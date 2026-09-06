import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { types as utilTypes } from "node:util";
import type { JournalEntry, PromoteIntent, SessionState, Snapshot } from "./types.ts";

export class RevisionConflictError extends Error {
  constructor(expected: number, actual: number) {
    super(`session revision conflict: expected ${expected}, actual ${actual}`);
    this.name = "RevisionConflictError";
  }
}

export class GenerationConflictError extends Error {
  constructor(expected: number, actual: number) {
    super(`project generation conflict: expected ${expected}, actual ${actual}`);
    this.name = "GenerationConflictError";
  }
}

export class PersistenceCorruptionError extends Error {
  constructor(path: string, cause?: unknown) {
    super(`corrupt persistence data: ${path}`, { cause });
    this.name = "PersistenceCorruptionError";
  }
}

export class PersistenceLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersistenceLimitError";
  }
}

type Limits = {
  snapshotBytes: number;
  bindingBytes: number;
  journalBytes: number;
  storageBytes: number;
};

type ProjectHead = { version: 1; generation: number };
type LockOwner = { host: string; pid: number; token: string };
type ProfileFile = { version: 1; name: string; snapshot: Snapshot };

const DEFAULT_LIMITS: Limits = {
  snapshotBytes: 4 * 1024 * 1024,
  bindingBytes: 1 * 1024 * 1024,
  journalBytes: 16 * 1024 * 1024,
  storageBytes: 64 * 1024 * 1024,
};
const LOCK_WAIT_MS = 2_000;
const LOCK_POLL_MS = 20;
const POISON_NAMES = new Set(["__proto__", "prototype", "constructor"]);
const DECLARATION_KINDS = new Set(["const", "let", "var", "function", "class", "import", "enum"]);
const SAVED_DECLARATION_KINDS = new Set(["const", "let", "var"]);
const TRANSIENT_WRITE_ERRORS = new Set(["EBUSY", "EINTR", "EIO", "EMFILE", "ENFILE", "EPERM"]);

export class StateStore {
  readonly #root: string;
  readonly #sessionId: string;
  readonly #sessionKey: string;
  readonly #limits: Limits;

  constructor(
    root: string,
    sessionId: string,
    limits: Partial<Limits> = {},
  ) {
    if (!root || !sessionId) throw new TypeError("root and sessionId must be non-empty strings");
    this.#root = resolve(root);
    this.#sessionId = sessionId;
    this.#sessionKey = digest(sessionId);
    this.#limits = { ...DEFAULT_LIMITS };
    for (const [name, value] of Object.entries(limits)) {
      if (value !== undefined) this.#limits[name as keyof Limits] = value;
    }
    for (const [name, value] of Object.entries(this.#limits)) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new TypeError(`${name} must be a positive safe integer`);
      }
    }
  }

  async load(): Promise<SessionState | undefined> {
    const path = this.#sessionStatePath();
    const value = await readJsonIfExists(path);
    if (value === undefined) return undefined;
    try {
      assertSessionState(value, this.#sessionId, this.#limits);
      return value;
    } catch (error) {
      throw new PersistenceCorruptionError(path, error);
    }
  }

  checkpoint(
    snapshot: Snapshot,
    expectedRevision: number,
    projectGeneration: number,
  ): Promise<SessionState> {
    return this.#locked(async () => {
      assertNonNegativeInteger(expectedRevision, "expectedRevision");
      assertNonNegativeInteger(projectGeneration, "projectGeneration");
      assertSnapshot(snapshot, this.#sessionId, this.#limits);
      const storedSnapshot = cloneJson(snapshot);
      const current = await this.#loadSessionLocked();
      const revision = current?.revision ?? 0;
      if (revision !== expectedRevision) throw new RevisionConflictError(expectedRevision, revision);
      const next: SessionState = {
        version: 1,
        sessionId: this.#sessionId,
        revision: revision + 1,
        projectGeneration,
        snapshot: storedSnapshot,
      };
      const path = this.#sessionStatePath();
      const data = encodeJson(next);
      await this.#ensureStorage([{ path, data }]);
      await atomicWrite(path, data, 3);
      return structuredClone(next);
    });
  }

  async project(): Promise<{ generation: number; snapshot?: Snapshot }> {
    const head = await this.#readProjectHead();
    if (head.generation === 0) return { generation: 0 };
    return {
      generation: head.generation,
      snapshot: await this.#readProjectSnapshot(head.generation),
    };
  }

  async projectSnapshot(generation: number): Promise<Snapshot> {
    assertPositiveInteger(generation, "generation");
    const path = this.#projectGenerationPath(generation);
    if (!(await exists(path))) throw new Error(`unknown project generation: ${generation}`);
    return this.#readProjectSnapshot(generation);
  }

  writePromoteIntent(expectedGeneration: number): Promise<void> {
    return this.#locked(async () => {
      assertNonNegativeInteger(expectedGeneration, "expectedGeneration");
      const intent: PromoteIntent = {
        version: 1,
        sessionId: this.#sessionId,
        expectedGeneration,
        createdAt: new Date().toISOString(),
      };
      const path = this.#promoteIntentPath();
      const data = encodeJson(intent);
      await this.#ensureStorage([{ path, data }]);
      await atomicWrite(path, data, 3);
    });
  }

  async readPromoteIntent(): Promise<PromoteIntent | undefined> {
    const path = this.#promoteIntentPath();
    const value = await readJsonIfExists(path);
    if (value === undefined) return undefined;
    try {
      assertPromoteIntent(value, this.#sessionId);
      return value;
    } catch (error) {
      throw new PersistenceCorruptionError(path, error);
    }
  }

  clearPromoteIntent(): Promise<void> {
    return this.#locked(async () => {
      await rm(this.#promoteIntentPath(), { force: true });
    });
  }

  promote(snapshot: Snapshot, expectedGeneration: number): Promise<number> {
    return this.#locked(async () => {
      assertNonNegativeInteger(expectedGeneration, "expectedGeneration");
      assertSnapshot(snapshot, undefined, this.#limits);
      const storedSnapshot = cloneJson(snapshot);
      const head = await this.#readProjectHead();
      if (head.generation !== expectedGeneration) {
        throw new GenerationConflictError(expectedGeneration, head.generation);
      }
      return this.#appendProjectGeneration(storedSnapshot, head);
    });
  }

  rollbackProject(targetGeneration: number, expectedGeneration: number): Promise<number> {
    return this.#locked(async () => {
      assertPositiveInteger(targetGeneration, "targetGeneration");
      assertNonNegativeInteger(expectedGeneration, "expectedGeneration");
      const head = await this.#readProjectHead();
      if (head.generation !== expectedGeneration) {
        throw new GenerationConflictError(expectedGeneration, head.generation);
      }
      const snapshot = await this.#readProjectSnapshot(targetGeneration);
      return this.#appendProjectGeneration(snapshot, head);
    });
  }

  async saveProfile(name: string, snapshot: Snapshot): Promise<void> {
    assertSafeName(name, "profile name");
    assertSnapshot(snapshot, undefined, this.#limits);
    const storedSnapshot = cloneJson(snapshot);
    await this.#locked(async () => {
      const path = this.#profilePath(name);
      if (await exists(path)) throw new Error(`profile already exists: ${name}`);
      const data = encodeJson({ version: 1, name, snapshot: storedSnapshot } satisfies ProfileFile);
      await this.#ensureStorage([{ path, data }]);
      await atomicWriteNew(path, data);
    });
  }

  async listProfiles(): Promise<string[]> {
    const directory = join(this.#root, "profiles");
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isCode(error, "ENOENT")) return [];
      throw error;
    }
    const names: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const path = join(directory, entry.name);
      const profile = await this.#readProfileFile(path);
      if (`${digest(profile.name)}.json` !== entry.name) {
        throw new PersistenceCorruptionError(path, new Error("profile path does not match its name"));
      }
      names.push(profile.name);
    }
    return names.sort((a, b) => a.localeCompare(b));
  }

  async loadProfile(name: string): Promise<Snapshot> {
    assertSafeName(name, "profile name");
    const path = this.#profilePath(name);
    const value = await readJson(path);
    try {
      assertProfileFile(value, this.#limits);
      if (value.name !== name) throw new Error("profile name mismatch");
      return value.snapshot;
    } catch (error) {
      throw new PersistenceCorruptionError(path, error);
    }
  }

  async appendJournal(entry: JournalEntry): Promise<void> {
    assertJournalEntry(entry);
    const storedEntry = cloneJson(entry);
    await this.#locked(async () => {
      const path = this.#journalPath();
      const current = await readTextIfExists(path) ?? "";
      if (current && !current.endsWith("\n")) {
        throw new PersistenceCorruptionError(path, new Error("incomplete JSONL record"));
      }
      validateJournalText(current, path);
      const line = `${JSON.stringify(storedEntry)}\n`;
      const data = Buffer.from(current + line);
      if (data.byteLength > this.#limits.journalBytes) {
        throw new PersistenceLimitError(
          `journal exceeds journalBytes limit (${data.byteLength} > ${this.#limits.journalBytes})`,
        );
      }
      await this.#ensureStorage([{ path, data }]);
      await atomicWrite(path, data);
    });
  }

  async journal(): Promise<JournalEntry[]> {
    const path = this.#journalPath();
    const text = await readTextIfExists(path);
    if (text === undefined || text === "") return [];
    if (!text.endsWith("\n")) {
      throw new PersistenceCorruptionError(path, new Error("incomplete JSONL record"));
    }
    return validateJournalText(text, path);
  }

  async exportNotebook(): Promise<object> {
    const entries = await this.journal();
    const usedIds = new Set<string>();
    return {
      cells: entries.map((entry, index) => ({
        cell_type: "code",
        execution_count: index + 1,
        id: notebookCellId(entry.cellId, entry.executionId, index, usedIds),
        metadata: {},
        outputs: notebookOutputs(entry, index + 1),
        source: entry.source,
      })),
      metadata: {
        kernelspec: { display_name: "Deno", language: "typescript", name: "deno" },
        language_info: { name: "typescript" },
      },
      nbformat: 4,
      nbformat_minor: 5,
    };
  }

  async #locked<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const lockPath = join(this.#root, ".lock");
    const owner: LockOwner = { host: hostname(), pid: process.pid, token: randomUUID() };
    const candidate = `${lockPath}.candidate-${owner.token}`;
    const deadline = Date.now() + LOCK_WAIT_MS;

    try {
      await durableWriteNew(candidate, encodeJson(owner));
      for (;;) {
        try {
          await link(candidate, lockPath);
          await rm(candidate);
          await syncDirectory(this.#root);
          break;
        } catch (error) {
          if (!isCode(error, "EEXIST")) throw error;
          await this.#recoverDeadLock(lockPath);
          if (Date.now() >= deadline) throw new Error(`persistence lock timeout: ${lockPath}`);
          await delay(LOCK_POLL_MS);
        }
      }
    } catch (error) {
      await rm(candidate, { force: true }).catch(() => undefined);
      throw error;
    }

    try {
      return await operation();
    } finally {
      const saved = await readLockOwner(lockPath);
      if (isLockOwner(saved) && saved.token === owner.token) {
        await rm(lockPath, { force: true });
        await syncDirectory(this.#root);
      }
    }
  }

  async #recoverDeadLock(lockPath: string): Promise<void> {
    const saved = await readLockOwner(lockPath);
    if (!isLockOwner(saved) || saved.host !== hostname() || processAlive(saved.pid)) return;
    const stale = `${lockPath}.stale-${randomUUID()}`;
    try {
      await rename(lockPath, stale);
    } catch (error) {
      if (isCode(error, "ENOENT") || isCode(error, "EEXIST")) return;
      throw error;
    }
    await rm(stale, { recursive: true, force: true });
    await syncDirectory(this.#root);
  }

  async #loadSessionLocked(): Promise<SessionState | undefined> {
    const path = this.#sessionStatePath();
    const value = await readJsonIfExists(path);
    if (value === undefined) return undefined;
    try {
      assertSessionState(value, this.#sessionId, this.#limits);
      return value;
    } catch (error) {
      throw new PersistenceCorruptionError(path, error);
    }
  }

  async #readProjectHead(): Promise<ProjectHead> {
    const path = join(this.#root, "project", "head.json");
    const value = await readJsonIfExists(path);
    if (value === undefined) return { version: 1, generation: 0 };
    try {
      assertProjectHead(value);
      return value;
    } catch (error) {
      throw new PersistenceCorruptionError(path, error);
    }
  }

  async #readProjectSnapshot(generation: number): Promise<Snapshot> {
    const path = this.#projectGenerationPath(generation);
    let value: unknown;
    try {
      value = await readJson(path);
      assertSnapshot(value, undefined, this.#limits);
      return value;
    } catch (error) {
      if (error instanceof PersistenceCorruptionError) throw error;
      throw new PersistenceCorruptionError(path, error);
    }
  }

  async #appendProjectGeneration(snapshot: Snapshot, head: ProjectHead): Promise<number> {
    const directory = join(this.#root, "project", "generations");
    const nextGeneration = Math.max(head.generation, await maxProjectGeneration(directory)) + 1;
    if (!Number.isSafeInteger(nextGeneration)) throw new PersistenceLimitError("project generation exhausted");
    const generationPath = this.#projectGenerationPath(nextGeneration);
    const headPath = join(this.#root, "project", "head.json");
    const generationData = encodeJson(snapshot);
    const headData = encodeJson({ version: 1, generation: nextGeneration } satisfies ProjectHead);
    await this.#ensureStorage([
      { path: generationPath, data: generationData },
      { path: headPath, data: headData },
    ]);
    await atomicWriteNew(generationPath, generationData);
    await atomicWrite(headPath, headData);
    return nextGeneration;
  }

  async #readProfileFile(path: string): Promise<ProfileFile> {
    const value = await readJson(path);
    try {
      assertProfileFile(value, this.#limits);
      return value;
    } catch (error) {
      throw new PersistenceCorruptionError(path, error);
    }
  }

  async #ensureStorage(writes: Array<{ path: string; data: Uint8Array }>): Promise<void> {
    let projected = await directoryBytes(this.#root);
    for (const write of writes) {
      projected -= await fileBytes(write.path);
      projected += write.data.byteLength;
    }
    if (projected > this.#limits.storageBytes) {
      throw new PersistenceLimitError(
        `storage exceeds storageBytes limit (${projected} > ${this.#limits.storageBytes})`,
      );
    }
  }

  #sessionStatePath(): string {
    return join(this.#root, "sessions", this.#sessionKey, "state.json");
  }

  #journalPath(): string {
    return join(this.#root, "sessions", this.#sessionKey, "journal.jsonl");
  }

  #promoteIntentPath(): string {
    return join(this.#root, "sessions", this.#sessionKey, "promote-intent.json");
  }

  #profilePath(name: string): string {
    return join(this.#root, "profiles", `${digest(name)}.json`);
  }

  #projectGenerationPath(generation: number): string {
    return join(this.#root, "project", "generations", `${generation}.json`);
  }
}

function assertSnapshot(value: unknown, sessionId: string | undefined, limits: Limits): asserts value is Snapshot {
  assertJsonValue(value, "snapshot");
  if (!isRecord(value)) throw new TypeError("snapshot must be an object");
  assertExactKeys(value, ["version", "mode", "sessionId", "generation", "runtime", "createdAt", "bindings", "pins"], "snapshot");
  if (value.version !== 1) throw new TypeError("unsupported snapshot version");
  if (value.mode !== "notebook") throw new TypeError("unsupported snapshot mode");
  if (typeof value.sessionId !== "string" || !value.sessionId) throw new TypeError("invalid snapshot sessionId");
  if (sessionId !== undefined && value.sessionId !== sessionId) throw new TypeError("snapshot sessionId mismatch");
  if (typeof value.generation !== "string" || !value.generation) throw new TypeError("invalid snapshot generation");
  if (!isRecord(value.runtime)) throw new TypeError("invalid snapshot runtime");
  assertExactKeys(value.runtime, ["name", "version"], "snapshot.runtime");
  if (value.runtime.name !== "deno" || typeof value.runtime.version !== "string" || !value.runtime.version) {
    throw new TypeError("invalid snapshot runtime");
  }
  if (!isCanonicalTimestamp(value.createdAt)) throw new TypeError("invalid snapshot createdAt");
  if (!Array.isArray(value.bindings)) throw new TypeError("snapshot.bindings must be an array");
  const names = new Set<string>();
  const savedNames = new Set<string>();
  for (const binding of value.bindings) {
    if (!isRecord(binding)) throw new TypeError("invalid binding");
    assertExactKeys(
      binding,
      binding.status === "saved" ? ["name", "declaration", "status", "value"] : ["name", "declaration", "status", "reason"],
      "binding",
      true,
    );
    assertSafeName(binding.name, "binding name");
    if (typeof binding.declaration !== "string" || !DECLARATION_KINDS.has(binding.declaration)) {
      throw new TypeError(`invalid binding declaration: ${binding.name}`);
    }
    if (names.has(binding.name)) throw new TypeError(`duplicate binding: ${binding.name}`);
    names.add(binding.name);
    if (binding.status === "saved") {
      if (!SAVED_DECLARATION_KINDS.has(binding.declaration)) {
        throw new TypeError(`saved binding has unsupported declaration: ${binding.name}`);
      }
      if (!Object.hasOwn(binding, "value")) throw new TypeError(`saved binding has no value: ${binding.name}`);
      savedNames.add(binding.name);
      const bytes = Buffer.byteLength(JSON.stringify(binding.value));
      if (bytes > limits.bindingBytes) {
        throw new PersistenceLimitError(`binding ${binding.name} exceeds bindingBytes limit (${bytes} > ${limits.bindingBytes})`);
      }
    } else if (binding.status === "excluded") {
      if (Object.hasOwn(binding, "value")) throw new TypeError(`excluded binding has a value: ${binding.name}`);
      if (binding.reason !== undefined && typeof binding.reason !== "string") throw new TypeError("invalid exclusion reason");
    } else {
      throw new TypeError("invalid binding status");
    }
  }
  if (!Array.isArray(value.pins)) throw new TypeError("snapshot.pins must be an array");
  for (const pin of value.pins) {
    assertSafeName(pin, "pin");
    if (!savedNames.has(pin)) throw new TypeError(`pin does not reference a saved binding: ${pin}`);
  }
  if (new Set(value.pins).size !== value.pins.length) throw new TypeError("duplicate snapshot pin");
  const bytes = Buffer.byteLength(JSON.stringify(value));
  if (bytes > limits.snapshotBytes) {
    throw new PersistenceLimitError(`snapshot exceeds snapshotBytes limit (${bytes} > ${limits.snapshotBytes})`);
  }
}

function assertSessionState(value: unknown, sessionId: string, limits: Limits): asserts value is SessionState {
  assertJsonValue(value, "session state");
  if (!isRecord(value)) throw new TypeError("session state must be an object");
  assertExactKeys(value, ["version", "sessionId", "revision", "projectGeneration", "snapshot"], "session state");
  if (value.version !== 1 || value.sessionId !== sessionId) throw new TypeError("invalid session state identity");
  assertPositiveInteger(value.revision, "revision");
  assertNonNegativeInteger(value.projectGeneration, "projectGeneration");
  assertSnapshot(value.snapshot, sessionId, limits);
}

function assertProjectHead(value: unknown): asserts value is ProjectHead {
  assertJsonValue(value, "project head");
  if (!isRecord(value)) throw new TypeError("project head must be an object");
  assertExactKeys(value, ["version", "generation"], "project head");
  if (value.version !== 1) throw new TypeError("unsupported project head version");
  assertNonNegativeInteger(value.generation, "project generation");
}

function assertProfileFile(value: unknown, limits: Limits): asserts value is ProfileFile {
  assertJsonValue(value, "profile");
  if (!isRecord(value)) throw new TypeError("profile must be an object");
  assertExactKeys(value, ["version", "name", "snapshot"], "profile");
  if (value.version !== 1) throw new TypeError("unsupported profile version");
  assertSafeName(value.name, "profile name");
  assertSnapshot(value.snapshot, undefined, limits);
}

function assertJournalEntry(value: unknown): asserts value is JournalEntry {
  assertJsonValue(value, "journal entry");
  if (!isRecord(value)) throw new TypeError("journal entry must be an object");
  assertExactKeys(value, ["executionId", "cellId", "generation", "mode", "source", "startedAt", "durationMs", "status", "outputs", "error"], "journal entry", true);
  for (const key of ["executionId", "cellId", "generation", "source", "startedAt", "status"] as const) {
    if (typeof value[key] !== "string") throw new TypeError(`invalid journal ${key}`);
  }
  if (!value.executionId || !value.cellId || !value.generation) throw new TypeError("journal identifiers must be non-empty");
  if (value.mode !== "notebook") throw new TypeError("unsupported journal mode");
  if (!isCanonicalTimestamp(value.startedAt)) throw new TypeError("invalid journal startedAt");
  if (typeof value.durationMs !== "number" || !Number.isFinite(value.durationMs) || value.durationMs < 0) {
    throw new TypeError("invalid journal durationMs");
  }
  if (value.error !== undefined && typeof value.error !== "string") throw new TypeError("invalid journal error");
  if (!Array.isArray(value.outputs)) throw new TypeError("journal outputs must be an array");
  for (const output of value.outputs) {
    if (!isRecord(output)) throw new TypeError("invalid journal output");
    assertExactKeys(output, ["kind", "text", "data", "metadata", "origin", "attribution"], "journal output", true);
    if (typeof output.kind !== "string" || !output.kind) throw new TypeError("invalid output kind");
    if (output.text !== undefined && typeof output.text !== "string") throw new TypeError("invalid output text");
    if (output.data !== undefined && !isRecord(output.data)) throw new TypeError("invalid output data");
    if (output.metadata !== undefined && !isRecord(output.metadata)) throw new TypeError("invalid output metadata");
    if (
      output.attribution !== undefined &&
      output.attribution !== "execution" &&
      output.attribution !== "background" &&
      output.attribution !== "unattributed"
    ) {
      throw new TypeError("invalid output attribution");
    }
    if (output.origin !== undefined) {
      if (!isRecord(output.origin)) throw new TypeError("invalid output origin");
      assertExactKeys(output.origin, ["sessionId", "executionId", "cellId", "mode", "generation"], "output origin", true);
      for (const key of ["sessionId", "executionId", "generation"] as const) {
        if (typeof output.origin[key] !== "string" || !output.origin[key]) {
          throw new TypeError(`invalid output origin ${key}`);
        }
      }
      if (output.origin.mode !== "code" && output.origin.mode !== "notebook") {
        throw new TypeError("invalid output origin mode");
      }
      if (output.origin.cellId !== undefined && (typeof output.origin.cellId !== "string" || !output.origin.cellId)) {
        throw new TypeError("invalid output origin cellId");
      }
    }
  }
}

type JsonInspection = { ancestors: Set<object>; seen: WeakMap<object, string> };

function assertJsonValue(
  value: unknown,
  path: string,
  inspection: JsonInspection = { ancestors: new Set(), seen: new WeakMap() },
): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new TypeError(`${path} contains a lossy number`);
    return;
  }
  if (typeof value !== "object") throw new TypeError(`${path} contains a non-JSON value`);
  if (utilTypes.isProxy(value)) throw new TypeError(`${path} contains a proxy`);
  if (inspection.ancestors.has(value)) throw new TypeError(`${path} contains a cycle`);
  const firstPath = inspection.seen.get(value);
  if (firstPath !== undefined) throw new TypeError(`${path} aliases ${firstPath}`);
  inspection.seen.set(value, path);
  inspection.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor) throw new TypeError(`${path} contains a sparse array`);
        if (!descriptor.enumerable || !("value" in descriptor)) {
          throw new TypeError(`${path}[${index}] is not losslessly serializable`);
        }
        assertJsonValue(descriptor.value, `${path}[${index}]`, inspection);
      }
      if (Reflect.ownKeys(value).some((key) => {
        if (typeof key === "symbol") return true;
        if (key === "length") return false;
        const index = Number(key);
        return !Number.isSafeInteger(index) || index < 0 || String(index) !== key || index >= value.length;
      })) {
        throw new TypeError(`${path} contains non-JSON array properties`);
      }
      return;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${path} contains a non-plain object`);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") throw new TypeError(`${path} contains symbol keys`);
      if (POISON_NAMES.has(key)) throw new TypeError(`${path} contains prohibited property ${key}`);
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!descriptor.enumerable || !("value" in descriptor)) throw new TypeError(`${path}.${key} is not losslessly serializable`);
      assertJsonValue(descriptor.value, `${path}.${key}`, inspection);
    }
  } finally {
    inspection.ancestors.delete(value);
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: string[],
  label: string,
  optionalAllowed = false,
): void {
  const actual = Object.keys(value);
  for (const key of actual) if (!allowed.includes(key)) throw new TypeError(`${label} has unknown property: ${key}`);
  if (!optionalAllowed) {
    for (const key of allowed) if (!Object.hasOwn(value, key)) throw new TypeError(`${label} is missing property: ${key}`);
  }
}

function assertSafeName(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value || value.length > 512 || POISON_NAMES.has(value) || value.includes("\0")) {
    throw new TypeError(`invalid ${label}`);
  }
}

function assertPromoteIntent(value: unknown, sessionId: string): asserts value is PromoteIntent {
  if (!isRecord(value)) throw new TypeError("promote intent must be an object");
  assertExactKeys(value, ["version", "sessionId", "expectedGeneration", "createdAt"], "promote intent");
  if (value.version !== 1) throw new TypeError("unsupported promote intent version");
  if (value.sessionId !== sessionId) throw new TypeError("promote intent sessionId mismatch");
  assertNonNegativeInteger(value.expectedGeneration, "expectedGeneration");
  if (typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) {
    throw new TypeError("invalid promote intent createdAt");
  }
}

function assertPositiveInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new TypeError(`${label} must be a positive safe integer`);
}

function assertNonNegativeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError(`${label} must be a non-negative safe integer`);
}

// deno-lint-ignore no-explicit-any
function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isLockOwner(value: unknown): value is LockOwner {
  return isRecord(value) && typeof value.host === "string" && Number.isSafeInteger(value.pid) &&
    value.pid > 0 && typeof value.token === "string" && value.token.length > 0;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isCode(error, "ESRCH");
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function encodeJson(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`);
}

// deno-lint-ignore no-explicit-any
async function readJson(path: string): Promise<any> {
  const text = await readFile(path, "utf8");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new PersistenceCorruptionError(path, error);
  }
}

// deno-lint-ignore no-explicit-any
async function readJsonIfExists(path: string): Promise<any | undefined> {
  try {
    return await readJson(path);
  } catch (error) {
    if (isCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function readLockOwner(path: string): Promise<unknown> {
  try {
    return await readJson(path);
  } catch (error) {
    if (isCode(error, "EISDIR")) {
      return readJsonIfExists(join(path, "owner.json")).catch(() => undefined);
    }
    return undefined;
  }
}

async function readTextIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

function validateJournalText(text: string, path: string): JournalEntry[] {
  if (!text) return [];
  try {
    return text.trimEnd().split("\n").map((line) => {
      const value: unknown = JSON.parse(line);
      assertJournalEntry(value);
      return value;
    });
  } catch (error) {
    throw new PersistenceCorruptionError(path, error);
  }
}

async function atomicWrite(path: string, data: Uint8Array, attempts = 1): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const temp = join(dirname(path), `.${randomUUID()}.tmp`);
    try {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      try {
        await handle.writeFile(data);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temp, path);
      await syncDirectory(dirname(path));
      return;
    } catch (error) {
      lastError = error;
      await rm(temp, { force: true }).catch(() => undefined);
      if (!TRANSIENT_WRITE_ERRORS.has(errorCode(error)) || attempt + 1 === attempts) throw error;
      await delay(10 * (attempt + 1));
    }
  }
  throw lastError;
}

async function atomicWriteNew(path: string, data: Uint8Array): Promise<void> {
  const temp = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await durableWriteNew(temp, data);
    await link(temp, path);
    await rm(temp);
    await syncDirectory(dirname(path));
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function durableWriteNew(path: string, data: Uint8Array): Promise<void> {
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(dirname(path));
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function directoryBytes(root: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isCode(error, "ENOENT")) return 0;
    throw error;
  }
  for (const entry of entries) {
    if (entry.name === ".lock" || entry.name.startsWith(".lock.") || entry.name.endsWith(".tmp")) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(path);
    else if (entry.isFile()) total += (await stat(path)).size;
  }
  return total;
}

async function fileBytes(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if (isCode(error, "ENOENT")) return 0;
    throw error;
  }
}

async function maxProjectGeneration(directory: string): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if (isCode(error, "ENOENT")) return 0;
    throw error;
  }
  let max = 0;
  for (const entry of entries) {
    const match = /^(\d+)\.json$/.exec(entry);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max;
}

function notebookOutputs(entry: JournalEntry, executionCount: number): object[] {
  const outputs = entry.outputs.map((output) => {
    if (output.kind === "stdout" || output.kind === "stderr") {
      return { name: output.kind, output_type: "stream", text: output.text ?? "" };
    }
    if (output.kind === "error") {
      const ename = typeof output.data?.ename === "string" ? output.data.ename : "Error";
      const message = typeof output.data?.evalue === "string"
        ? output.data.evalue
        : output.text ?? entry.error ?? ename;
      const traceback = Array.isArray(output.data?.traceback) && output.data.traceback.every((line) => typeof line === "string")
        ? output.data.traceback
        : message.split("\n");
      return { ename, evalue: message, output_type: "error", traceback };
    }
    const data = { ...(output.data ?? {}) } as Record<string, unknown>;
    if (data["text/plain"] === undefined && (output.text !== undefined || Object.keys(data).length === 0)) {
      data["text/plain"] = output.text ?? "";
    }
    return output.kind === "result"
      ? { data, execution_count: executionCount, metadata: output.metadata ?? {}, output_type: "execute_result" }
      : { data, metadata: output.metadata ?? {}, output_type: "display_data" };
  });
  if (entry.error && !entry.outputs.some((output) => output.kind === "error")) {
    outputs.push({ ename: "Error", evalue: entry.error, output_type: "error", traceback: entry.error.split("\n") });
  }
  return outputs;
}

function notebookCellId(cellId: string, executionId: string, index: number, used: Set<string>): string {
  const candidate = /^[A-Za-z0-9_-]{1,64}$/.test(cellId) ? cellId : digest(`${cellId}\0${executionId}`).slice(0, 32);
  let id = candidate;
  if (used.has(id)) id = digest(`${candidate}\0${executionId}\0${index}`).slice(0, 32);
  used.add(id);
  return id;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, (error) => {
    if (isCode(error, "ENOENT")) return false;
    throw error;
  });
}

function errorCode(error: unknown): string {
  return isRecord(error) && typeof error.code === "string" ? error.code : "";
}

function isCode(error: unknown, code: string): boolean {
  return errorCode(error) === code;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
