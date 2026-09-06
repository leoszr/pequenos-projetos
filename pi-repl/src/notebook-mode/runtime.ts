import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { KernelSession, type RuntimeServices } from "../execution/session.ts";
import { identityOf, type ExecutionResult } from "../execution/engine.ts";
import { declarationMetadata, bindingName, type DeclarationKind } from "../execution/source.ts";
import { snapshotSource, SNAPSHOT_MIME, VALUE_MIME, valueFrom } from "../execution/bootstrap.ts";
import type { KernelOutput } from "../kernel/backend.ts";
import { StateStore } from "../persistence/store.ts";
import type { Snapshot, SessionState } from "../persistence/types.ts";
export class NotebookRuntime {
  private session?: KernelSession;
  private preparing?: Promise<void>;
  private bindings = new Map<string, DeclarationKind>();
  private pins = new Set<string>();
  private persisted?: SessionState;
  private projectGeneration = 0;
  private dirty = false;
  private uncertain = false;
  private closed = false;
  private recovery: unknown;
  readonly store: StateStore;
  constructor(private services: RuntimeServices, root: string, private output: (output: KernelOutput) => void) {
    this.store = new StateStore(root, services.sessionId, services.limits);
  }
  get generation(): string { return this.session?.kernel.generation ?? "not_started"; }
  private async prepareInner(signal?: AbortSignal): Promise<void> {
    if (this.closed) throw new Error("Notebook is closed");
    if (this.session && !["dead", "closed", "incompatible"].includes(this.session.kernel.state)) return;
    if (this.session) await this.session.close();
    const stored = await this.store.load();
    const project = await this.store.project();
    const intent = await this.store.readPromoteIntent();
    this.persisted = stored;
    this.projectGeneration = stored?.projectGeneration ?? project.generation;
    let snapshot = stored?.snapshot ?? project.snapshot;
    let adoptSnapshot = false;
    if (intent) {
      if (project.generation === intent.expectedGeneration + 1 && project.snapshot) {
        // Our promote landed but the session checkpoint did not: adopt the
        // head snapshot instead of silently keeping the stale private fork.
        snapshot = project.snapshot;
        this.projectGeneration = project.generation;
        adoptSnapshot = true;
        this.recovery = { recoveredPromotion: project.generation, fromGeneration: project.snapshot.generation };
      } else if (project.generation === intent.expectedGeneration) {
        await this.store.clearPromoteIntent();
      } else {
        this.recovery = { promotionDiverged: { expected: intent.expectedGeneration, actual: project.generation } };
        await this.store.clearPromoteIntent();
      }
    }
    const candidate = new KernelSession(this.services, "notebook", this.output);
    try {
      await candidate.start(signal);
      if (snapshot) await this.restoreInto(candidate, snapshot, signal);
      if (this.closed) throw new Error("Notebook closed during startup");
      this.session = candidate;
      this.bindings = new Map(snapshot?.bindings.filter(b => b.status === "saved").map(b => [b.name, b.declaration]) ?? []);
      this.pins = new Set(snapshot?.pins.filter(n => this.bindings.has(n)) ?? []);
      this.uncertain = false;
      if (adoptSnapshot) {
        // Persist the adopted promotion before admitting work; on failure
        // the intent is retained so the next startup retries the adoption.
        this.persisted = await this.store.checkpoint(snapshot!, this.persisted?.revision ?? 0, this.projectGeneration);
        await this.store.clearPromoteIntent();
        this.dirty = false;
      } else {
        this.dirty = false;
        this.recovery ??= snapshot ? { restored: snapshot.bindings.filter(b => b.status === "saved").map(b => b.name), lost: snapshot.bindings.filter(b => b.status === "excluded"), fromGeneration: snapshot.generation } : undefined;
      }
    } catch (error) { await candidate.close(); throw error; }
  }
  async start(signal?: AbortSignal): Promise<void> {
    if (!this.preparing) this.preparing = this.prepareInner(signal).finally(() => { this.preparing = undefined; });
    await this.preparing;
  }
  async run(record: ExecutionResult, code: string, context: ExtensionContext, signal: AbortSignal): Promise<void> {
    const discovered = declarationMetadata(code);
    if (new Set([...this.bindings.keys(), ...discovered.map(binding => binding.name)]).size > this.services.limits.bindings) throw new Error("Binding count limit");
    await this.start(signal);
    record.generation = this.generation;
    this.dirty = true;
    try {
      const result = await this.session!.run(code, identityOf(record), context, signal,
        value => this.output({ kind: "notification", data: { update: value }, origin: identityOf(record), attribution: "execution" }));
      if (result.status === "ok") {
        discovered.forEach(binding => this.bindings.set(binding.name, binding.declaration));
      } else if (this.session?.kernel.state === "available") {
        await this.syncDiscoveredBindings(discovered, signal);
      }
      record.state = result.status === "ok" ? "completed" : result.status === "cancelled" ? "cancelled" : "failed";
      record.error = result.error;
      this.uncertain ||= result.status === "cancelled";
      const settled = await this.services.registry.settle(record.executionId, this.services.limits.interruptMs);
      record.cleanup = settled ? "completed" : "pending";
      if (!settled) this.uncertain = true;
      if (result.status === "ok" && settled) {
        await this.session!.internal("await __repl.drain();", signal);
        try { await this.checkpoint(); }
        catch (error) { record.error = `Execution completed; checkpoint failed: ${String(error)}`; record.state = "failed"; }
      }
    } catch (error) { this.uncertain = true; throw error; }
    finally {
      record.dirty = this.dirty || this.uncertain;
      await this.store.appendJournal({ executionId: record.executionId, cellId: record.cellId!, generation: record.generation, mode: "notebook", source: code, startedAt: record.startedAt, durationMs: Date.now() - Date.parse(record.startedAt), status: signal.aborted ? "cancelled" : record.state, outputs: record.outputs, ...(record.error === undefined ? {} : { error: record.error }) });
    }
  }
  private async syncDiscoveredBindings(discovered: ReturnType<typeof declarationMetadata>, signal?: AbortSignal): Promise<void> {
    const valid = discovered.filter(b => bindingName(b.name) && !this.bindings.has(b.name));
    if (!valid.length || !this.session || this.session.kernel.state !== "available") return;
    const probe = `await (async () => {
      const __repl_live = [];
      ${valid.map(b => `try { void ${b.name}; __repl_live.push(${JSON.stringify(b.name)}); } catch {}`).join("\n")}
      await __repl.value(__repl_live);
    })();`;
    try {
      const result = await this.session.internal(probe, signal);
      const existing = valueFrom(result.outputs, VALUE_MIME);
      if (Array.isArray(existing)) {
        const live = new Set(existing);
        for (const binding of valid) {
          if (live.has(binding.name) && !this.bindings.has(binding.name)) {
            this.bindings.set(binding.name, binding.declaration);
          }
        }
      }
    } catch {
      // Best-effort inspection: preserve original cell failure if probe fails.
    }
  }
  async snapshot(): Promise<Snapshot> {
    if (!this.session || this.session.kernel.state !== "available" || this.uncertain) throw new Error("Checkpoint requires a consistent, idle Notebook; restart from last checkpoint after interruption/error");
    const result = await this.session.internal(snapshotSource([...this.bindings].map(([name, declaration]) => ({ name, declaration })), this.services.limits.bindingBytes));
    const payload = valueFrom(result.outputs, SNAPSHOT_MIME) as Pick<Snapshot, "bindings" | "runtime"> | undefined;
    if (!payload?.bindings || payload.runtime?.name !== "deno") throw new Error("Invalid snapshot response");
    return { version: 1, mode: "notebook", sessionId: this.services.sessionId, generation: this.generation, createdAt: new Date().toISOString(), bindings: payload.bindings, runtime: payload.runtime, pins: [...this.pins] };
  }
  async checkpoint(): Promise<SessionState | undefined> {
    if (!this.session) return this.store.load();
    if (!this.dirty && this.persisted) return this.persisted;
    const snapshot = await this.snapshot();
    this.persisted = await this.store.checkpoint(snapshot, this.persisted?.revision ?? 0, this.projectGeneration);
    this.dirty = false;
    return this.persisted;
  }
  private async restoreInto(session: KernelSession, snapshot: Snapshot, signal?: AbortSignal): Promise<void> {
    if (snapshot.version !== 1 || snapshot.mode !== "notebook" || snapshot.runtime.name !== "deno" || snapshot.runtime.version !== "2.9.6") throw new Error("Incompatible snapshot runtime");
    const saved = snapshot.bindings.filter(b => b.status === "saved");
    for (const binding of saved) if (!bindingName(binding.name)) throw new Error(`Invalid binding: ${binding.name}`);
    // Restore values, never replay historical code. JSON.parse preserves own __proto__ data keys.
    const source = saved.map(b => `${b.declaration} ${b.name} = JSON.parse(${JSON.stringify(JSON.stringify(b.value))});`).join("\n");
    if (source) await session.internal(source, signal);
  }
  private async replace(snapshot: Snapshot): Promise<void> {
    const candidate = new KernelSession(this.services, "notebook", this.output);
    try {
      await candidate.start();
      await this.restoreInto(candidate, snapshot);
      const previous = this.session;
      const persisted = await this.store.checkpoint({ ...snapshot, generation: candidate.kernel.generation, sessionId: this.services.sessionId }, this.persisted?.revision ?? 0, this.projectGeneration);
      await this.store.clearPromoteIntent();
      this.session = candidate; this.persisted = persisted;
      this.bindings = new Map(snapshot.bindings.filter(b => b.status === "saved").map(b => [b.name, b.declaration]));
      this.pins = new Set(snapshot.pins); this.dirty = false; this.uncertain = false;
      await previous?.close();
    } catch (error) { if (candidate !== this.session) await candidate.close(); throw error; }
  }
  async restart(): Promise<unknown> {
    await this.session?.close(); this.session = undefined;
    await this.start(); return this.status();
  }
  async reset(scope: string): Promise<unknown> {
    if (scope !== "session") throw new Error("Reset requires scope=session; project and profiles remain untouched");
    if (!this.persisted) this.persisted = await this.store.load();
    await this.replace({ version: 1, mode: "notebook", sessionId: this.services.sessionId, generation: randomUUID(), createdAt: new Date().toISOString(), runtime: { name: "deno", version: "2.9.6" }, bindings: [], pins: [] });
    return this.status();
  }
  async pin(names: string[], pinned: boolean): Promise<unknown> {
    for (const name of names) if (!this.bindings.has(name)) throw new Error(`Unknown binding: ${name}`);
    if (pinned) {
      const snapshot = await this.snapshot();
      for (const name of names) if (snapshot.bindings.find(binding => binding.name === name)?.status !== "saved") {
        throw new Error(`Binding cannot be pinned because it is not restorable: ${name}`);
      }
    }
    for (const name of names) { if (pinned) this.pins.add(name); else this.pins.delete(name); }
    this.dirty = true; await this.checkpoint(); return this.status();
  }
  async release(names: string[], scope: string): Promise<unknown> {
    if (scope !== "bindings" || !names.length) throw new Error("Release/prune requires scope=bindings and explicit names");
    for (const name of names) {
      if (this.pins.has(name)) throw new Error(`Pinned binding: ${name}`);
      if (!this.bindings.has(name)) throw new Error(`Unknown binding: ${name}`);
    }
    const snapshot = await this.snapshot();
    const remaining = snapshot.bindings.filter(b => !names.includes(b.name));
    if (remaining.some(b => b.status !== "saved")) throw new Error("Cannot replace kernel without losing retained non-serializable bindings");
    await this.replace({ ...snapshot, bindings: remaining });
    return { released: names, ...this.status() };
  }
  async prune(names: string[], scope: string, dryRun = true): Promise<unknown> {
    if (scope !== "bindings" || !names.length) throw new Error("Prune requires scope=bindings and explicit candidates");
    const candidates = names.filter(name => this.bindings.has(name) && !this.pins.has(name));
    const protectedNames = names.filter(name => this.pins.has(name));
    if (dryRun) return { candidates, protected: protectedNames, applied: false };
    if (protectedNames.length) throw new Error(`Prune includes pinned bindings: ${protectedNames.join(", ")}`);
    if (!candidates.length) return { candidates: [], protected: [], applied: true };
    const result = await this.release(candidates, scope);
    return { candidates, protected: [], applied: true, ...(typeof result === "object" && result !== null ? result : {}) };
  }
  async profile(action: "save" | "list" | "load", name?: string): Promise<unknown> {
    if (action === "list") return this.store.listProfiles();
    if (!name) throw new Error("Profile name required");
    if (action === "save") {
      const snapshot = await this.snapshot();
      const excluded = snapshot.bindings.filter(binding => binding.status === "excluded");
      if (excluded.length) throw new Error(`Profile requires fully restorable state; excluded: ${excluded.map(binding => binding.name).join(", ")}`);
      await this.store.saveProfile(name, snapshot); return { saved: name };
    }
    const profile = await this.store.loadProfile(name);
    const current = this.session ? await this.snapshot() : undefined;
    const live = current?.bindings ?? [];
    for (const binding of profile.bindings) if (live.some(b => b.name === binding.name)) throw new Error(`Profile collision: ${binding.name}`);
    if (live.some(b => b.status !== "saved")) throw new Error("Profile load cannot discard live non-serializable values; reset explicitly first");
    await this.replace({ ...profile, bindings: [...live, ...profile.bindings], pins: [...new Set([...(current?.pins ?? []), ...profile.pins])] });
    return this.status();
  }
  async promote(): Promise<unknown> {
    const snapshot = await this.snapshot();
    const expected = this.projectGeneration;
    await this.store.writePromoteIntent(expected);
    try {
      this.projectGeneration = await this.store.promote(snapshot, expected);
    } catch (error) {
      const head = await this.store.project().catch(() => undefined);
      if (head && head.generation === expected) await this.store.clearPromoteIntent().catch(() => undefined);
      throw error;
    }
    this.dirty = true; await this.checkpoint();
    await this.store.clearPromoteIntent();
    return { projectGeneration: this.projectGeneration };
  }
  async rollback(generation: number): Promise<unknown> {
    this.projectGeneration = await this.store.rollbackProject(generation, this.projectGeneration);
    this.dirty = true; await this.checkpoint(); return { projectGeneration: this.projectGeneration, liveUnchanged: true };
  }
  status() { return { state: this.session?.kernel.state ?? "not_started", generation: this.generation, bindings: [...this.bindings].map(([name, declaration]) => ({ name, declaration })), pins: [...this.pins], dirty: this.dirty, uncertain: this.uncertain, projectGeneration: this.projectGeneration, revision: this.persisted?.revision ?? 0, recovery: this.recovery }; }
  diagnostics() { return { ...this.status(), kernel: this.session?.kernel.diagnostics() }; }
  async interrupt(): Promise<void> { this.uncertain = true; await this.session?.kernel.interrupt(); }
  async shutdown(): Promise<void> {
    this.closed = true;
    try {
      await this.preparing?.catch(() => undefined);
      if (!this.uncertain && this.session?.kernel.state === "available") await this.checkpoint();
    } finally { await this.session?.close(); }
  }
}
