import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { configureLimits } from "../src/config.ts";
import type { RuntimeServices } from "../src/execution/session.ts";
import type { ExecutionResult } from "../src/execution/engine.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ExecutionIdentity, KernelBackend, KernelOutput, KernelResult, KernelState, Mode } from "../src/kernel/backend.ts";
import { BridgeServer } from "../src/bridge/server.ts";
import { ToolRegistry } from "../src/bridge/registry.ts";
import { VALUE_MIME } from "../src/execution/bootstrap.ts";
import { createJupyterKernel } from "../src/kernel/jupyter.ts";
import { ExecutionManager } from "../src/execution/manager.ts";
import { NotebookRuntime } from "../src/notebook-mode/runtime.ts";
import { ReplRouter } from "../src/tool/router.ts";
import type { Snapshot } from "../src/persistence/types.ts";

const roots: string[] = [];

test.afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class FakeKernel implements KernelBackend {
  readonly generation = "gen-1";
  state: KernelState = "not_started";
  executions: string[] = [];
  onOutput?: (output: KernelOutput) => void;
  liveBindings = new Set<string>();

  constructor(private readonly sessionId: string, private readonly mode: "code" | "notebook" = "notebook") {}

  start(): Promise<void> {
    this.state = "available";
    return Promise.resolve();
  }

  execute(code: string, identity: ExecutionIdentity): Promise<KernelResult> {
    assert.equal(identity.sessionId, this.sessionId);
    assert.equal(identity.generation, this.generation);
    this.executions.push(code);
    if (code.includes("__repl.value")) {
      const match = code.match(/try\s*\{\s*void\s+([A-Za-z_$][\w$]*);/g) ?? [];
      const probed = match.map((m) => m.replace(/try\s*\{\s*void\s+([A-Za-z_$][\w$]*);/, "$1"));
      const existing = probed.filter((n) => this.liveBindings.has(n));
      return Promise.resolve({
        status: "ok",
        outputs: [{
          kind: "display",
          data: { [VALUE_MIME]: existing },
          attribution: "execution",
        } as KernelOutput],
      });
    }
    if (code.includes("neverCreated") || code.includes("ghostBinding") || code.includes("antes")) {
      if (code.includes("realBinding")) this.liveBindings.add("realBinding");
      return Promise.resolve({ status: "error", error: "boom", outputs: [] as KernelOutput[] });
    }
    if (code.includes("pi-repl.snapshot")) {
      const bindings = [...this.liveBindings].map((name) => ({
        name,
        declaration: "const" as const,
        status: "saved" as const,
        value: 42,
      }));
      return Promise.resolve({
        status: "ok",
        outputs: [{
          kind: "display",
          data: {
            "application/vnd.pi-repl.snapshot+json": {
              bindings,
              runtime: { name: "deno", version: "2.9.6" },
            },
          },
          attribution: "execution",
        } as KernelOutput],
      });
    }
    const matchDeclarations = code.match(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g) ?? [];
    for (const m of matchDeclarations) {
      const name = m.split(/\s+/)[1];
      if (name && !name.startsWith("__repl") && !["tools", "text", "display", "globalThis", "Deno"].includes(name)) {
        this.liveBindings.add(name);
      }
    }
    return Promise.resolve({ status: "ok", outputs: [] as KernelOutput[] });
  }

  async interrupt(): Promise<void> {}

  shutdown(): Promise<void> {
    this.state = "closed";
    return Promise.resolve();
  }

  diagnostics(): Record<string, unknown> {
    return { state: this.state };
  }
}

function services(sessionId: string, kernel: FakeKernel): RuntimeServices {
  return {
    limits: configureLimits(),
    bridge: {
      start: () => Promise.resolve({ url: "http://127.0.0.1:1/bridge", token: "test" }),
      open: () => {},
      closeExecution: () => {},
      shutdown: () => Promise.resolve(),
    },
    registry: { settle: () => Promise.resolve(true) },
    kernel: (_mode: Mode, onOutput?: (output: KernelOutput) => void) => {
      kernel.onOutput = onOutput;
      return kernel as unknown as ReturnType<RuntimeServices["kernel"]>;
    },
    sessionId,
    cwd: "/tmp",
  } as unknown as RuntimeServices;
}

function headSnapshot(sessionId: string, value: unknown = 41): Snapshot {
  return {
    version: 1,
    mode: "notebook",
    sessionId,
    generation: "gen-1",
    runtime: { name: "deno", version: "2.9.6" },
    createdAt: new Date().toISOString(),
    bindings: [{ name: "x", declaration: "let", status: "saved", value }],
    pins: [],
  };
}

test("startup adopts a landed promotion whose session checkpoint never happened", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-repl-recovery-"));
  roots.push(root);
  const crashed = new NotebookRuntime(services("recovery-session", new FakeKernel("recovery-session")), root, () => {});
  // Simulate the crash window: intent written, promotion landed, then death.
  await crashed.store.writePromoteIntent(0);
  await crashed.store.promote(headSnapshot("recovery-session"), 0);

  const restarted = new NotebookRuntime(services("recovery-session", new FakeKernel("recovery-session")), root, () => {});
  await restarted.start();
  try {
    const status = restarted.status() as {
      projectGeneration: number; bindings: Array<{ name: string }>; recovery: Record<string, unknown>;
    };
    assert.equal(status.projectGeneration, 1);
    assert.deepEqual(status.bindings.map((binding) => binding.name), ["x"]);
    assert.equal(status.recovery.recoveredPromotion, 1);
    assert.equal(await restarted.store.readPromoteIntent(), undefined);
    const persisted = await restarted.store.load();
    assert.equal(persisted?.projectGeneration, 1);
    assert.equal(persisted?.snapshot.bindings[0]?.name, "x");
  } finally {
    await restarted.shutdown();
  }
});

test("startup discards an intent whose promotion never landed", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-repl-recovery-"));
  roots.push(root);
  const crashed = new NotebookRuntime(services("recovery-noop", new FakeKernel("recovery-noop")), root, () => {});
  await crashed.store.writePromoteIntent(0);

  const restarted = new NotebookRuntime(services("recovery-noop", new FakeKernel("recovery-noop")), root, () => {});
  await restarted.start();
  try {
    const status = restarted.status() as { projectGeneration: number; recovery: unknown };
    assert.equal(status.projectGeneration, 0);
    assert.equal(await restarted.store.readPromoteIntent(), undefined);
  } finally {
    await restarted.shutdown();
  }
});

test("startup reports divergence when another session promoted past the intent", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-repl-recovery-"));
  roots.push(root);
  const crashed = new NotebookRuntime(services("recovery-diverged", new FakeKernel("recovery-diverged")), root, () => {});
  await crashed.store.writePromoteIntent(0);
  await crashed.store.promote(headSnapshot("recovery-diverged", 1), 0);
  await crashed.store.promote(headSnapshot("recovery-diverged", 2), 1);

  const restarted = new NotebookRuntime(services("recovery-diverged", new FakeKernel("recovery-diverged")), root, () => {});
  await restarted.start();
  try {
    const status = restarted.status() as { recovery: { promotionDiverged: { expected: number; actual: number } } };
    assert.deepEqual(status.recovery.promotionDiverged, { expected: 0, actual: 2 });
    assert.equal(await restarted.store.readPromoteIntent(), undefined);
  } finally {
    await restarted.shutdown();
  }
});

test("failed cell does not register bindings, ok cell does", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-repl-bindings-"));
  roots.push(root);
  const sessionId = "bindings-failure";
  const runtime = new NotebookRuntime(services(sessionId, new FakeKernel(sessionId)), root, () => {});
  const context = {} as unknown as ExtensionContext;
  const signal = new AbortController().signal;
  const failing: ExecutionResult = {
    executionId: "exec-fail", cellId: "cell-fail", sessionId, generation: "gen-1",
    mode: "notebook", state: "running", cleanup: "pending", outputs: [],
    startedAt: new Date().toISOString(), durationMs: 0,
  };
  await runtime.run(failing, 'throw new Error("x"); const neverCreated = 1', context, signal);
  try {
    assert.equal(failing.state, "failed");
    assert.deepEqual((runtime.status() as { bindings: Array<{ name: string }> }).bindings, []);
    const ok: ExecutionResult = {
      executionId: "exec-ok", cellId: "cell-ok", sessionId, generation: "gen-1",
      mode: "notebook", state: "running", cleanup: "pending", outputs: [],
      startedAt: new Date().toISOString(), durationMs: 0,
    };
    await runtime.run(ok, "const created = 1", context, signal);
    assert.equal(ok.state, "completed");
    assert.deepEqual(
      (runtime.status() as { bindings: Array<{ name: string }> }).bindings.map((binding) => binding.name),
      ["created"],
    );
  } finally {
    await runtime.shutdown();
  }
});

test("notebook execution records real runtime outputs with origin and attribution into journal", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-repl-journal-flow-"));
  roots.push(root);
  const sessionId = "journal-flow-session";
  class OutputtingKernel extends FakeKernel {
    override execute(code: string, identity: ExecutionIdentity): Promise<KernelResult> {
      this.executions.push(code);
      if (code.includes("pi-repl.snapshot")) return super.execute(code, identity);
      const out: KernelOutput = {
        kind: "stdout",
        text: "computed 42\n",
        origin: identity,
        attribution: "execution",
      };
      this.onOutput?.(out);
      return Promise.resolve({ status: "ok", outputs: [out] });
    }
  }

  const kernel = new OutputtingKernel(sessionId);
  const manager = new ExecutionManager(services(sessionId, kernel), root);
  const context = {} as unknown as ExtensionContext;
  try {
    const result = await manager.start("notebook", "42", context);
    assert.equal(result.state, "completed");

    const entries = await manager.notebook.store.journal();
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.executionId, result.executionId);
    assert.equal(entries[0]!.outputs.length, 1);
    const output = entries[0]!.outputs[0]!;
    assert.equal(output.kind, "stdout");
    assert.equal(output.text, "computed 42\n");
    assert.equal(output.attribution, "execution");
    assert.deepEqual(output.origin, {
      sessionId,
      executionId: result.executionId,
      cellId: result.cellId,
      mode: "notebook",
      generation: "gen-1",
    });

    const notebook = await manager.notebook.store.exportNotebook() as {
      cells: Array<{ outputs: Array<Record<string, unknown>> }>;
    };
    assert.equal(notebook.cells[0]!.outputs[0]!["output_type"], "stream");
    assert.equal(notebook.cells[0]!.outputs[0]!["text"], "computed 42\n");
  } finally {
    await manager.shutdown();
  }
});

test("failed cell with partial bindings preserves real bindings and omits ghosts", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-repl-partial-bindings-"));
  roots.push(root);
  const sessionId = "partial-bindings-session";
  const kernel = new FakeKernel(sessionId);
  const runtime = new NotebookRuntime(services(sessionId, kernel), root, () => {});
  const context = {} as unknown as ExtensionContext;
  const signal = new AbortController().signal;

  const prev: ExecutionResult = {
    executionId: "exec-prev", cellId: "cell-prev", sessionId, generation: "gen-1",
    mode: "notebook", state: "running", cleanup: "pending", outputs: [],
    startedAt: new Date().toISOString(), durationMs: 0,
  };
  await runtime.run(prev, "const previous = 1", context, signal);
  assert.equal(prev.state, "completed");

  const failing: ExecutionResult = {
    executionId: "exec-partial", cellId: "cell-partial", sessionId, generation: "gen-1",
    mode: "notebook", state: "running", cleanup: "pending", outputs: [],
    startedAt: new Date().toISOString(), durationMs: 0,
  };
  await runtime.run(failing, "const realBinding = 2; throw new Error('boom'); const ghostBinding = 3;", context, signal);
  assert.equal(failing.state, "failed");

  const probeExecution = kernel.executions.find((c) => c.includes("__repl.value"));
  assert.ok(probeExecution, "internal probe must execute");
  assert.ok(!probeExecution.includes("eval"), "probe must not use eval");
  assert.ok(probeExecution.includes("void realBinding"), "probe must directly reference realBinding");
  assert.ok(probeExecution.includes("void ghostBinding"), "probe must directly reference ghostBinding");

  const status = runtime.status() as { bindings: Array<{ name: string; declaration: string }> };
  const names = status.bindings.map((b) => b.name);
  assert.ok(names.includes("previous"), "previous binding must be retained");
  assert.ok(names.includes("realBinding"), "real binding before throw must be tracked");
  assert.ok(!names.includes("ghostBinding"), "ghost binding after throw must NOT be tracked");

  await runtime.shutdown();
});

test("prune handles dry-run and apply with pin protection", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-repl-prune-"));
  roots.push(root);
  const sessionId = "prune-session";
  const kernel = new FakeKernel(sessionId);
  const runtime = new NotebookRuntime(services(sessionId, kernel), root, () => {});
  const context = {} as unknown as ExtensionContext;
  const signal = new AbortController().signal;

  const exec: ExecutionResult = {
    executionId: "exec-setup", cellId: "cell-setup", sessionId, generation: "gen-1",
    mode: "notebook", state: "running", cleanup: "pending", outputs: [],
    startedAt: new Date().toISOString(), durationMs: 0,
  };
  await runtime.run(exec, "const keep = 1; const discard = 2;", context, signal);
  await runtime.pin(["keep"], true);

  const preview = await runtime.prune(["keep", "discard"], "bindings", true) as {
    candidates: string[];
    protected: string[];
    applied: boolean;
  };
  assert.equal(preview.applied, false);
  assert.deepEqual(preview.candidates, ["discard"]);
  assert.deepEqual(preview.protected, ["keep"]);
  let bindings = (runtime.status() as { bindings: Array<{ name: string }> }).bindings.map((b) => b.name);
  assert.ok(bindings.includes("keep"));
  assert.ok(bindings.includes("discard"));

  await assert.rejects(
    () => runtime.prune(["keep", "discard"], "bindings", false),
    /Prune includes pinned bindings: keep/,
  );

  const applied = await runtime.prune(["discard"], "bindings", false) as {
    candidates: string[];
    applied: boolean;
  };
  assert.equal(applied.applied, true);
  assert.deepEqual(applied.candidates, ["discard"]);
  bindings = (runtime.status() as { bindings: Array<{ name: string }> }).bindings.map((b) => b.name);
  assert.ok(bindings.includes("keep"));
  assert.ok(!bindings.includes("discard"));

  await runtime.shutdown();
});

test("real Deno kernel: partial cell failure tracks real binding, omits ghost, and enables prune apply", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-repl-real-deno-"));
  roots.push(root);
  const limits = configureLimits();
  const registry = new ToolRegistry(() => [], () => []);
  const bridge = new BridgeServer(registry, limits.responseBytes);
  const sessionId = "real-deno-session";
  const realServices: RuntimeServices = {
    limits,
    bridge,
    registry,
    kernel: (mode: Mode, onOutput?: (output: KernelOutput) => void) => createJupyterKernel({
      cwd: process.cwd(),
      mode,
      sessionId,
      startupTimeoutMs: 30_000,
      onOutput,
    }),
    sessionId,
    cwd: process.cwd(),
  };

  const runtime = new NotebookRuntime(realServices, root, () => {});
  t.after(async () => {
    await runtime.shutdown();
    await bridge.shutdown();
  });

  const context = {} as unknown as ExtensionContext;
  const signal = new AbortController().signal;

  const res1: ExecutionResult = {
    executionId: "exec-real-1", cellId: "cell-real-1", sessionId, generation: "gen-1",
    mode: "notebook", state: "running", cleanup: "pending", outputs: [],
    startedAt: new Date().toISOString(), durationMs: 0,
  };
  await runtime.run(res1, "const survived = 123;\nlet survivedLet = 'ok';\nthrow new Error('boom');\nconst ghost = 456;\nlet tdzLet = 'never';", context, signal);
  assert.equal(res1.state, "failed");

  const bindingsAfterFail = (runtime.status() as { bindings: Array<{ name: string }> }).bindings.map((b) => b.name);
  assert.ok(bindingsAfterFail.includes("survived"), "survived binding must be tracked even after cell failure");
  assert.ok(bindingsAfterFail.includes("survivedLet"), "survived let binding before throw must be tracked");
  assert.ok(!bindingsAfterFail.includes("ghost"), "ghost binding after error must NOT be tracked");
  assert.ok(!bindingsAfterFail.includes("tdzLet"), "TDZ let binding after error must NOT be tracked");

  const res2: ExecutionResult = {
    executionId: "exec-real-2", cellId: "cell-real-2", sessionId, generation: "gen-1",
    mode: "notebook", state: "running", cleanup: "pending", outputs: [],
    startedAt: new Date().toISOString(), durationMs: 0,
  };
  await runtime.run(res2, "survived + 1", context, signal);
  assert.equal(res2.state, "completed");

  const res3: ExecutionResult = {
    executionId: "exec-real-3", cellId: "cell-real-3", sessionId, generation: "gen-1",
    mode: "notebook", state: "running", cleanup: "pending", outputs: [],
    startedAt: new Date().toISOString(), durationMs: 0,
  };
  await runtime.run(res3, "let removable = 789;", context, signal);
  assert.equal(res3.state, "completed");

  const dry = await runtime.prune(["removable"], "bindings", true) as { applied: boolean; candidates: string[] };
  assert.equal(dry.applied, false);
  assert.deepEqual(dry.candidates, ["removable"]);
  assert.ok((runtime.status() as { bindings: Array<{ name: string }> }).bindings.some((b) => b.name === "removable"));

  const applied = await runtime.prune(["removable"], "bindings", false) as { applied: boolean; candidates: string[] };
  assert.equal(applied.applied, true);
  assert.deepEqual(applied.candidates, ["removable"]);
  assert.ok(!(runtime.status() as { bindings: Array<{ name: string }> }).bindings.some((b) => b.name === "removable"));
});

test("unit: failed cell with redeclaration does not alter existing binding metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-repl-redeclare-"));
  roots.push(root);
  const sessionId = "redeclare-session";
  const kernel = new FakeKernel(sessionId);
  const runtime = new NotebookRuntime(services(sessionId, kernel), root, () => {});
  const context = {} as unknown as ExtensionContext;
  const signal = new AbortController().signal;

  const first: ExecutionResult = {
    executionId: "exec-keep", cellId: "cell-keep", sessionId, generation: "gen-1",
    mode: "notebook", state: "running", cleanup: "pending", outputs: [],
    startedAt: new Date().toISOString(), durationMs: 0,
  };
  await runtime.run(first, "const keep = 42;", context, signal);
  assert.equal(first.state, "completed");
  let status = runtime.status() as { bindings: Array<{ name: string; declaration: string }> };
  assert.deepEqual(status.bindings, [{ name: "keep", declaration: "const" }]);

  const redeclaring: ExecutionResult = {
    executionId: "exec-redeclaring", cellId: "cell-redeclaring", sessionId, generation: "gen-1",
    mode: "notebook", state: "running", cleanup: "pending", outputs: [],
    startedAt: new Date().toISOString(), durationMs: 0,
  };
  await runtime.run(redeclaring, "throw new Error('antes'); function keep() {}", context, signal);
  assert.equal(redeclaring.state, "failed");

  status = runtime.status() as { bindings: Array<{ name: string; declaration: string }> };
  assert.deepEqual(status.bindings, [{ name: "keep", declaration: "const" }]);

  await runtime.shutdown();
});

test("unit: probe avoids ghost binding on collision with internal identifiers like existing", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-repl-probe-collision-"));
  roots.push(root);
  const sessionId = "probe-collision-session";
  const kernel = new FakeKernel(sessionId);
  const runtime = new NotebookRuntime(services(sessionId, kernel), root, () => {});
  const context = {} as unknown as ExtensionContext;
  const signal = new AbortController().signal;

  const failing: ExecutionResult = {
    executionId: "exec-existing", cellId: "cell-existing", sessionId, generation: "gen-1",
    mode: "notebook", state: "running", cleanup: "pending", outputs: [],
    startedAt: new Date().toISOString(), durationMs: 0,
  };
  await runtime.run(failing, "throw new Error('antes'); const existing = 7;", context, signal);
  assert.equal(failing.state, "failed");

  const probe = kernel.executions.find((c) => c.includes("__repl.value"));
  assert.ok(probe, "internal probe must execute");
  assert.ok(!probe.includes("const existing ="), "probe must not declare local existing variable");
  assert.ok(probe.includes("__repl_live"), "probe must use reserved internal identifier");

  const status = runtime.status() as { bindings: Array<{ name: string; declaration: string }> };
  assert.deepEqual(status.bindings, []);

  await runtime.shutdown();
});

test("real Deno kernel: redeclaration failure preserves existing metadata and probe avoids collision", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-repl-real-bindings-"));
  roots.push(root);
  const limits = configureLimits();
  const registry = new ToolRegistry(() => [], () => []);
  const bridge = new BridgeServer(registry, limits.responseBytes);
  const sessionId = "real-deno-bindings";
  const realServices: RuntimeServices = {
    limits,
    bridge,
    registry,
    kernel: (mode: Mode, onOutput?: (output: KernelOutput) => void) => createJupyterKernel({
      cwd: process.cwd(),
      mode,
      sessionId,
      startupTimeoutMs: 30_000,
      onOutput,
    }),
    sessionId,
    cwd: process.cwd(),
  };

  const runtime = new NotebookRuntime(realServices, root, () => {});
  t.after(async () => {
    await runtime.shutdown();
    await bridge.shutdown();
  });

  const context = {} as unknown as ExtensionContext;
  const signal = new AbortController().signal;

  // 1. Initial const binding succeeds
  const res1: ExecutionResult = {
    executionId: "exec-real-keep", cellId: "cell-real-keep", sessionId, generation: "gen-1",
    mode: "notebook", state: "running", cleanup: "pending", outputs: [],
    startedAt: new Date().toISOString(), durationMs: 0,
  };
  await runtime.run(res1, "const keep = 42;", context, signal);
  assert.equal(res1.state, "completed");
  let status = runtime.status() as { bindings: Array<{ name: string; declaration: string }> };
  assert.deepEqual(status.bindings, [{ name: "keep", declaration: "const" }]);

  // 2. Failed redeclaration must NOT alter keep metadata to function
  const res2: ExecutionResult = {
    executionId: "exec-real-redecl", cellId: "cell-real-redecl", sessionId, generation: "gen-1",
    mode: "notebook", state: "running", cleanup: "pending", outputs: [],
    startedAt: new Date().toISOString(), durationMs: 0,
  };
  await runtime.run(res2, "throw new Error('antes'); function keep() {}", context, signal);
  assert.equal(res2.state, "failed");
  status = runtime.status() as { bindings: Array<{ name: string; declaration: string }> };
  assert.deepEqual(status.bindings, [{ name: "keep", declaration: "const" }]);

  // 3. Failed cell with existing variable name must NOT create ghost binding
  const res3: ExecutionResult = {
    executionId: "exec-real-ghost-existing", cellId: "cell-real-ghost-existing", sessionId, generation: "gen-1",
    mode: "notebook", state: "running", cleanup: "pending", outputs: [],
    startedAt: new Date().toISOString(), durationMs: 0,
  };
  await runtime.run(res3, "throw new Error('antes'); const existing = 7;", context, signal);
  assert.equal(res3.state, "failed");
  status = runtime.status() as { bindings: Array<{ name: string; declaration: string }> };
  assert.deepEqual(status.bindings, [{ name: "keep", declaration: "const" }]);

  // 4. Partial binding before throw is preserved, ghost after throw omitted
  const res4: ExecutionResult = {
    executionId: "exec-real-partial-existing", cellId: "cell-real-partial-existing", sessionId, generation: "gen-1",
    mode: "notebook", state: "running", cleanup: "pending", outputs: [],
    startedAt: new Date().toISOString(), durationMs: 0,
  };
  await runtime.run(res4, "const existing = 7; throw new Error('depois'); const ghost = 99;", context, signal);
  assert.equal(res4.state, "failed");
  status = runtime.status() as { bindings: Array<{ name: string; declaration: string }> };
  assert.deepEqual(status.bindings, [
    { name: "keep", declaration: "const" },
    { name: "existing", declaration: "const" },
  ]);

  // 5. Subsequent execution sees live keep and existing bindings
  const res5: ExecutionResult = {
    executionId: "exec-real-eval", cellId: "cell-real-eval", sessionId, generation: "gen-1",
    mode: "notebook", state: "running", cleanup: "pending", outputs: [],
    startedAt: new Date().toISOString(), durationMs: 0,
  };
  await runtime.run(res5, "keep + existing", context, signal);
  assert.equal(res5.state, "completed");
});

test("repl router: public prune action handles dry-run default, conflicting options rejection, and reachable apply end-to-end", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-repl-router-prune-"));
  roots.push(root);
  const sessionId = "router-prune-session";
  const routerServices: RuntimeServices = {
    limits: configureLimits(),
    bridge: {
      start: () => Promise.resolve({ url: "http://127.0.0.1:1/bridge", token: "test" }),
      open: () => {},
      closeExecution: () => {},
      shutdown: () => Promise.resolve(),
    },
    registry: { settle: () => Promise.resolve(true) },
    kernel: (_mode: Mode, onOutput?: (output: KernelOutput) => void) => {
      const k = new FakeKernel(sessionId);
      k.onOutput = onOutput;
      return k as unknown as ReturnType<RuntimeServices["kernel"]>;
    },
    sessionId,
    cwd: "/tmp",
  } as unknown as RuntimeServices;
  const manager = new ExecutionManager(routerServices, root);
  const router = new ReplRouter({
    limits: configureLimits(),
    sessionId,
    cwd: "/tmp",
    createManager: () => manager,
    listTools: () => [],
  });
  const context = {} as unknown as ExtensionContext;

  await router.route({
    mode: "notebook",
    action: "exec",
    code: "const keep = 1; const discard = 2; const extra = 3;",
  }, context);

  await router.route({
    mode: "notebook",
    action: "pin",
    names: ["keep"],
  }, context);

  // 1. Dry-run by default without flags
  const dryRes = await router.route({
    mode: "notebook",
    action: "prune",
    names: ["keep", "discard"],
    scope: "bindings",
  }, context);
  const dryVal = (dryRes.details as { value: { candidates: string[]; protected: string[]; applied: boolean } }).value;
  assert.equal(dryVal.applied, false);
  assert.deepEqual(dryVal.candidates, ["discard"]);
  assert.deepEqual(dryVal.protected, ["keep"]);

  let statusRes = await router.route({ mode: "notebook", action: "bindings" }, context);
  let bNames = (statusRes.details as { value: { bindings: Array<{ name: string }> } }).value.bindings.map((b) => b.name);
  assert.deepEqual(bNames.sort(), ["discard", "extra", "keep"]);

  // 2. Conflicting parameters rejected
  await assert.rejects(
    () => router.route({
      mode: "notebook",
      action: "prune",
      names: ["discard"],
      scope: "bindings",
      dry_run: false,
      operation: "dry_run",
    }, context),
    /conflicting parameters/i,
  );
  await assert.rejects(
    () => router.route({
      mode: "notebook",
      action: "prune",
      names: ["discard"],
      scope: "bindings",
      dry_run: true,
      operation: "apply",
    }, context),
    /conflicting parameters/i,
  );

  // 3. Apply on pinned binding rejected without mutating state
  await assert.rejects(
    () => router.route({
      mode: "notebook",
      action: "prune",
      names: ["keep", "discard"],
      scope: "bindings",
      operation: "apply",
    }, context),
    /Prune includes pinned bindings: keep/,
  );
  statusRes = await router.route({ mode: "notebook", action: "bindings" }, context);
  bNames = (statusRes.details as { value: { bindings: Array<{ name: string }> } }).value.bindings.map((b) => b.name);
  assert.deepEqual(bNames.sort(), ["discard", "extra", "keep"]);

  // 4. Apply reached via operation="apply"
  const applyOpRes = await router.route({
    mode: "notebook",
    action: "prune",
    names: ["discard"],
    scope: "bindings",
    operation: "apply",
  }, context);
  const applyOpVal = (applyOpRes.details as { value: { candidates: string[]; applied: boolean } }).value;
  assert.equal(applyOpVal.applied, true);
  assert.deepEqual(applyOpVal.candidates, ["discard"]);

  statusRes = await router.route({ mode: "notebook", action: "bindings" }, context);
  bNames = (statusRes.details as { value: { bindings: Array<{ name: string }> } }).value.bindings.map((b) => b.name);
  assert.ok(bNames.includes("keep"));
  assert.ok(bNames.includes("extra"));
  assert.ok(!bNames.includes("discard"));

  // 5. Apply reached via dry_run=false
  const applyBoolRes = await router.route({
    mode: "notebook",
    action: "prune",
    names: ["extra"],
    scope: "bindings",
    dry_run: false,
  }, context);
  const applyBoolVal = (applyBoolRes.details as { value: { candidates: string[]; applied: boolean } }).value;
  assert.equal(applyBoolVal.applied, true);
  assert.deepEqual(applyBoolVal.candidates, ["extra"]);

  statusRes = await router.route({ mode: "notebook", action: "bindings" }, context);
  bNames = (statusRes.details as { value: { bindings: Array<{ name: string }> } }).value.bindings.map((b) => b.name);
  assert.ok(bNames.includes("keep"));
  assert.ok(!bNames.includes("discard"));
  assert.ok(!bNames.includes("extra"));

  await router.shutdown();
});
