import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  GenerationConflictError,
  PersistenceCorruptionError,
  PersistenceLimitError,
  RevisionConflictError,
  StateStore,
} from "../src/persistence/store.ts";
import type { JournalEntry, Snapshot } from "../src/persistence/types.ts";

const roots: string[] = [];

test.afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-repl-persistence-"));
  roots.push(root);
  return root;
}

function snapshot(sessionId: string, generation = "kernel-1", value: unknown = 1): Snapshot {
  return {
    version: 1,
    mode: "notebook",
    sessionId,
    generation,
    runtime: { name: "deno", version: "2.2.0" },
    createdAt: "2026-01-02T03:04:05.000Z",
    bindings: [
      { name: "answer", declaration: "const", status: "saved", value },
      { name: "socket", declaration: "let", status: "excluded", reason: "not serializable" },
    ],
    pins: ["answer"],
  };
}

function journalEntry(index: number): JournalEntry {
  return {
    executionId: `execution-${index}`,
    cellId: index === 2 ? "invalid cell id!" : `cell-${index}`,
    generation: "kernel-1",
    mode: "notebook",
    source: `console.log(${index})`,
    startedAt: "2026-01-02T03:04:05.000Z",
    durationMs: index,
    status: index === 2 ? "error" : "ok",
    outputs: index === 2
      ? [{ kind: "error", text: "boom\ntrace" }]
      : [
        { kind: "stdout", text: `${index}\n` },
        { kind: "result", text: String(index), data: { "application/json": index } },
      ],
    ...(index === 2 ? { error: "boom\ntrace" } : {}),
  };
}

test("checkpoints persist by private session hash and enforce revision CAS under concurrency", async () => {
  const root = await temporaryRoot();
  const first = new StateStore(root, "../../session A");
  const second = new StateStore(root, "session B");

  assert.equal(await first.load(), undefined);
  const attempts = await Promise.allSettled([
    first.checkpoint(snapshot("../../session A", "a"), 0, 0),
    first.checkpoint(snapshot("../../session A", "b"), 0, 0),
  ]);
  assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = attempts.find((result) => result.status === "rejected") as PromiseRejectedResult;
  assert.ok(rejected.reason instanceof RevisionConflictError);
  assert.equal((await first.load())?.revision, 1);

  await second.checkpoint(snapshot("session B"), 0, 0);
  assert.equal((await second.load())?.sessionId, "session B");
  const sessionDirectories = await readdir(join(root, "sessions"));
  assert.equal(sessionDirectories.length, 2);
  assert.ok(sessionDirectories.every((name) => /^[a-f0-9]{64}$/.test(name)));
  assert.ok(!sessionDirectories.join("/").includes("session"));
});

test("project promotions conflict explicitly and rollback appends an immutable generation", async () => {
  const root = await temporaryRoot();
  const a = new StateStore(root, "a");
  const b = new StateStore(root, "b");

  const promoted = await Promise.allSettled([
    a.promote(snapshot("a", "first", 1), 0),
    b.promote(snapshot("b", "racer", 9), 0),
  ]);
  assert.equal(promoted.filter((result) => result.status === "fulfilled").length, 1);
  const conflict = promoted.find((result) => result.status === "rejected") as PromiseRejectedResult;
  assert.ok(conflict.reason instanceof GenerationConflictError);

  const generation1 = (await a.project()).generation;
  const generation2 = await a.promote(snapshot("a", "second", 2), generation1);
  const generation3 = await a.rollbackProject(generation1, generation2);
  assert.equal(generation3, generation2 + 1);
  assert.equal((await a.project()).snapshot?.generation, (await readGeneration(root, generation1)).generation);

  const files = await readdir(join(root, "project", "generations"));
  assert.deepEqual(files.sort(), ["1.json", "2.json", "3.json"]);
  assert.equal((await readGeneration(root, 2)).generation, "second");
});

test("profiles use safe paths, reject collisions, and remain sorted", async () => {
  const root = await temporaryRoot();
  const store = new StateStore(root, "session");
  await store.saveProfile("z/../../outside", snapshot("session", "z"));
  await store.saveProfile("Alpha", snapshot("session", "a"));

  assert.deepEqual(await store.listProfiles(), ["Alpha", "z/../../outside"]);
  assert.equal((await store.loadProfile("z/../../outside")).generation, "z");
  await assert.rejects(store.saveProfile("Alpha", snapshot("session")), /profile already exists/);
  assert.deepEqual((await readdir(join(root, "profiles"))).sort(), [
    `${createHash("sha256").update("z/../../outside").digest("hex")}.json`,
    `${createHash("sha256").update("Alpha").digest("hex")}.json`,
  ].sort());
});

test("snapshot validation rejects invalid manifests, lossy JSON, poison names, and limits", async () => {
  const root = await temporaryRoot();
  const store = new StateStore(root, "session", { bindingBytes: 16, snapshotBytes: 2_000 });

  await assert.rejects(store.checkpoint({ ...snapshot("session"), version: 2 } as unknown as Snapshot, 0, 0), /version/);
  await assert.rejects(store.checkpoint({ ...snapshot("session"), mode: "code" } as unknown as Snapshot, 0, 0), /mode/);
  await assert.rejects(store.checkpoint(snapshot("other"), 0, 0), /sessionId mismatch/);
  await assert.rejects(store.checkpoint(snapshot("session", "nan", Number.NaN), 0, 0), /lossy number/);
  await assert.rejects(store.checkpoint(snapshot("session", "date", new Date()), 0, 0), /non-plain object/);
  await assert.rejects(store.checkpoint(snapshot("session", "large", "x".repeat(17)), 0, 0), PersistenceLimitError);

  const poisoned = snapshot("session");
  poisoned.bindings[0]!.value = JSON.parse('{"__proto__":1}');
  await assert.rejects(store.checkpoint(poisoned, 0, 0), /prohibited property __proto__/);
  const poisonName = snapshot("session");
  poisonName.bindings[0]!.name = "constructor";
  await assert.rejects(store.checkpoint(poisonName, 0, 0), /invalid binding name/);
  assert.equal(await store.load(), undefined);
});

test("validation rejects aliases, cycles, proxies, accessors, declarations, and invalid pins", async () => {
  const root = await temporaryRoot();
  const store = new StateStore(root, "session", { bindingBytes: 10_000, snapshotBytes: 20_000 });

  const shared = { nested: true };
  await assert.rejects(store.checkpoint(snapshot("session", "alias", { left: shared, right: shared }), 0, 0), /aliases/);

  const betweenBindings = snapshot("session", "cross-alias", shared);
  betweenBindings.bindings.push({ name: "again", declaration: "let", status: "saved", value: shared });
  await assert.rejects(store.checkpoint(betweenBindings, 0, 0), /aliases/);

  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  await assert.rejects(store.checkpoint(snapshot("session", "cycle", cyclic), 0, 0), /cycle/);
  await assert.rejects(store.checkpoint(snapshot("session", "proxy", new Proxy({}, {})), 0, 0), /proxy/);

  let getterCalls = 0;
  const getter = Object.defineProperty({}, "secret", {
    enumerable: true,
    get() {
      getterCalls++;
      return 1;
    },
  });
  await assert.rejects(store.checkpoint(snapshot("session", "getter", getter), 0, 0), /not losslessly serializable/);
  assert.equal(getterCalls, 0);

  const invalidDeclaration = snapshot("session");
  invalidDeclaration.bindings[0]!.declaration = "class";
  await assert.rejects(store.checkpoint(invalidDeclaration, 0, 0), /unsupported declaration/);
  const invalidPin = snapshot("session");
  invalidPin.pins = ["missing"];
  await assert.rejects(store.checkpoint(invalidPin, 0, 0), /does not reference a saved binding/);

  const snapshotLimited = new StateStore(root, "session", { bindingBytes: 10_000, snapshotBytes: 1 });
  await assert.rejects(snapshotLimited.checkpoint(snapshot("session"), 0, 0), /snapshot exceeds snapshotBytes/);
  assert.equal(await store.load(), undefined);
});

test("journal appends concurrently without loss, stays bounded, and exports valid nbformat outputs", async () => {
  const root = await temporaryRoot();
  const store = new StateStore(root, "session", { journalBytes: 10_000 });
  await Promise.all([0, 1, 2].map((index) => store.appendJournal(journalEntry(index))));

  const journal = await store.journal();
  assert.deepEqual(journal.map((entry) => entry.executionId).sort(), ["execution-0", "execution-1", "execution-2"]);
  const notebook = await store.exportNotebook() as {
    nbformat: number;
    nbformat_minor: number;
    cells: Array<{ id: string; outputs: Array<Record<string, unknown>> }>;
  };
  assert.equal(notebook.nbformat, 4);
  assert.equal(notebook.nbformat_minor, 5);
  assert.ok(notebook.cells.every((cell) => /^[A-Za-z0-9_-]{1,64}$/.test(cell.id)));
  assert.deepEqual(
    notebook.cells.flatMap((cell) => cell.outputs.map((output) => output.output_type)).sort(),
    ["error", "execute_result", "execute_result", "stream", "stream"],
  );

  const before = await readFile(journalPath(root, "session"), "utf8");
  const bounded = new StateStore(root, "session", { journalBytes: Buffer.byteLength(before) + 1 });
  await assert.rejects(bounded.appendJournal(journalEntry(4)), PersistenceLimitError);
  assert.equal(await readFile(journalPath(root, "session"), "utf8"), before);
});

test("nbformat preserves rich MIME metadata and structured errors with coherent counts", async () => {
  const root = await temporaryRoot();
  const store = new StateStore(root, "session");
  const rich = journalEntry(10);
  rich.outputs = [
    {
      kind: "display",
      data: { "image/png": "aGVsbG8=", "text/html": "<b>ok</b>" },
      metadata: { width: 320 },
    },
    { kind: "result", text: "42", data: { "application/json": { answer: 42 } } },
  ];
  const failed = journalEntry(11);
  failed.status = "error";
  failed.error = "fallback";
  failed.outputs = [{
    kind: "error",
    data: { ename: "TypeError", evalue: "bad value", traceback: ["line one", "line two"] },
  }];
  await store.appendJournal(rich);
  await store.appendJournal(failed);

  const notebook = await store.exportNotebook() as {
    cells: Array<{
      execution_count: number;
      outputs: Array<{
        output_type: string;
        execution_count?: number;
        data?: Record<string, unknown>;
        metadata?: Record<string, unknown>;
        ename?: string;
        evalue?: string;
        traceback?: string[];
      }>;
    }>;
  };
  const display = notebook.cells[0]!.outputs[0]!;
  const result = notebook.cells[0]!.outputs[1]!;
  const error = notebook.cells[1]!.outputs[0]!;
  assert.equal(display.output_type, "display_data");
  assert.deepEqual(display.data, { "image/png": "aGVsbG8=", "text/html": "<b>ok</b>" });
  assert.deepEqual(display.metadata, { width: 320 });
  assert.equal(result.output_type, "execute_result");
  assert.equal(result.execution_count, notebook.cells[0]!.execution_count);
  assert.deepEqual(result.data?.["application/json"], { answer: 42 });
  assert.deepEqual(
    { ename: error.ename, evalue: error.evalue, traceback: error.traceback },
    { ename: "TypeError", evalue: "bad value", traceback: ["line one", "line two"] },
  );
});

test("atomic checkpoint replacement never exposes partial JSON", async () => {
  const root = await temporaryRoot();
  const writer = new StateStore(root, "session");
  const reader = new StateStore(root, "session");
  await writer.checkpoint(snapshot("session", "0"), 0, 0);

  const readErrors: unknown[] = [];
  let done = false;
  const reads = (async () => {
    while (!done) {
      try {
        const state = await reader.load();
        assert.equal(state?.version, 1);
      } catch (error) {
        readErrors.push(error);
      }
    }
  })();
  for (let revision = 1; revision <= 20; revision++) {
    await writer.checkpoint(snapshot("session", String(revision), { revision, text: "x".repeat(2_000) }), revision, 0);
  }
  done = true;
  await reads;

  assert.deepEqual(readErrors, []);
  assert.equal((await reader.load())?.revision, 21);
  assert.ok((await recursiveFiles(root)).every((path) => !path.endsWith(".tmp")));
});

test("storage budget refusal preserves project generations, head, and profiles", async () => {
  const root = await temporaryRoot();
  const store = new StateStore(root, "session", { storageBytes: 100_000 });
  const generation = await store.promote(snapshot("session", "kept"), 0);
  await store.saveProfile("kept", snapshot("session", "profile"));
  const beforeFiles = (await recursiveFiles(root)).sort();
  const beforeHead = await readFile(join(root, "project", "head.json"), "utf8");
  const used = await directorySize(root);
  const bounded = new StateStore(root, "session", {
    bindingBytes: 10_000,
    snapshotBytes: 20_000,
    storageBytes: used + 100,
  });

  await assert.rejects(
    bounded.promote(snapshot("session", "too-large", "x".repeat(1_000)), generation),
    PersistenceLimitError,
  );
  assert.deepEqual((await recursiveFiles(root)).sort(), beforeFiles);
  assert.equal(await readFile(join(root, "project", "head.json"), "utf8"), beforeHead);
  assert.deepEqual(await store.listProfiles(), ["kept"]);
  assert.equal((await store.project()).generation, generation);
});

test("a dead same-host lock is recovered using its ownership record", async () => {
  const root = await temporaryRoot();
  const lock = join(root, ".lock");
  await mkdir(lock, { recursive: true });
  await writeFile(join(lock, "owner.json"), JSON.stringify({ host: hostname(), pid: 2_147_483_647, token: "dead-owner" }));

  const store = new StateStore(root, "session");
  const state = await store.checkpoint(snapshot("session"), 0, 0);
  assert.equal(state.revision, 1);
  await assert.rejects(readFile(lock), { code: "ENOENT" });
});

test("a live owned lock is not stolen and its ownership token remains intact", async () => {
  const root = await temporaryRoot();
  const lock = join(root, ".lock");
  const owner = { host: hostname(), pid: process.pid, token: "active-owner" };
  await writeFile(lock, `${JSON.stringify(owner)}\n`);

  const store = new StateStore(root, "session");
  const started = Date.now();
  await assert.rejects(store.checkpoint(snapshot("session"), 0, 0), /lock timeout/);
  assert.ok(Date.now() - started >= 1_900);
  assert.deepEqual(JSON.parse(await readFile(lock, "utf8")), owner);
});

test("corruption is reported and never treated as missing data", async () => {
  const root = await temporaryRoot();
  const store = new StateStore(root, "session");
  await store.checkpoint(snapshot("session"), 0, 0);
  const statePath = join(root, "sessions", createHash("sha256").update("session").digest("hex"), "state.json");
  await writeFile(statePath, "{partial");
  await assert.rejects(store.load(), PersistenceCorruptionError);

  const otherRoot = await temporaryRoot();
  const journalStore = new StateStore(otherRoot, "session");
  await journalStore.appendJournal(journalEntry(0));
  await writeFile(journalPath(otherRoot, "session"), `${JSON.stringify(journalEntry(0))}\n{partial`);
  await assert.rejects(journalStore.journal(), PersistenceCorruptionError);

  const projectRoot = await temporaryRoot();
  const projectStore = new StateStore(projectRoot, "session");
  await projectStore.promote(snapshot("session"), 0);
  await writeFile(join(projectRoot, "project", "head.json"), '{"version":1,"generation":99}\n');
  await assert.rejects(projectStore.project(), PersistenceCorruptionError);

  const profileRoot = await temporaryRoot();
  const profileStore = new StateStore(profileRoot, "session");
  await profileStore.saveProfile("original", snapshot("session"));
  const path = profilePath(profileRoot, "original");
  const profile = JSON.parse(await readFile(path, "utf8"));
  profile.name = "substituted";
  await writeFile(path, `${JSON.stringify(profile)}\n`);
  await assert.rejects(profileStore.loadProfile("original"), PersistenceCorruptionError);
  await assert.rejects(profileStore.listProfiles(), PersistenceCorruptionError);
});

test("stored profiles and journal entries are isolated from caller mutation", async () => {
  const root = await temporaryRoot();
  const store = new StateStore(root, "session");
  const profileSnapshot = snapshot("session", "before");
  const profileWrite = store.saveProfile("frozen", profileSnapshot);
  profileSnapshot.generation = "after";
  await profileWrite;
  assert.equal((await store.loadProfile("frozen")).generation, "before");

  const entry = journalEntry(20);
  const journalWrite = store.appendJournal(entry);
  entry.source = "mutated";
  await journalWrite;
  assert.equal((await store.journal())[0]!.source, "console.log(20)");
});

async function readGeneration(root: string, generation: number): Promise<Snapshot> {
  return JSON.parse(await readFile(join(root, "project", "generations", `${generation}.json`), "utf8"));
}

function journalPath(root: string, sessionId: string): string {
  return join(root, "sessions", createHash("sha256").update(sessionId).digest("hex"), "journal.jsonl");
}

function profilePath(root: string, name: string): string {
  return join(root, "profiles", `${createHash("sha256").update(name).digest("hex")}.json`);
}

async function directorySize(directory: string): Promise<number> {
  let bytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === ".lock" || entry.name.startsWith(".lock.")) continue;
    const path = join(directory, entry.name);
    bytes += entry.isDirectory() ? await directorySize(path) : (await stat(path)).size;
  }
  return bytes;
}

async function recursiveFiles(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await recursiveFiles(path));
    else result.push(path);
  }
  return result;
}

test("promote intent records a landed promotion and reads back project snapshots", async () => {
  const root = await temporaryRoot();
  const store = new StateStore(root, "session-intent");
  assert.equal(await store.readPromoteIntent(), undefined);
  await store.writePromoteIntent(0);
  assert.equal((await store.readPromoteIntent())?.expectedGeneration, 0);
  // Simulate a crash: the promotion landed but no session checkpoint followed.
  const generation = await store.promote(snapshot("session-intent", "kernel-1", 7), 0);
  assert.equal(generation, 1);
  assert.equal((await store.readPromoteIntent())?.expectedGeneration, 0);
  const head = await store.projectSnapshot(1);
  assert.equal(head.bindings[0]?.name, "answer");
  await assert.rejects(store.projectSnapshot(2), /unknown project generation/);
  await store.clearPromoteIntent();
  assert.equal(await store.readPromoteIntent(), undefined);
});

test("promote intent rejects invalid payloads instead of blocking startup", async () => {
  const root = await temporaryRoot();
  const store = new StateStore(root, "session-intent-bad");
  const path = join(root, "sessions", createHash("sha256").update("session-intent-bad").digest("hex"), "promote-intent.json");
  await mkdir(join(root, "sessions", createHash("sha256").update("session-intent-bad").digest("hex")), { recursive: true });
  await writeFile(path, JSON.stringify({ version: 2, sessionId: "session-intent-bad", expectedGeneration: 0, createdAt: "2026-01-02T03:04:05.000Z" }));
  await assert.rejects(store.readPromoteIntent(), PersistenceCorruptionError);
});

test("journal output validation preserves origin, attribution and rejects unknown or invalid fields", async () => {
  const root = await temporaryRoot();
  const store = new StateStore(root, "session-origin-attribution");

  const entry = journalEntry(1);
  entry.outputs = [
    {
      kind: "stdout",
      text: "ok\n",
      origin: {
        sessionId: "session-origin-attribution",
        executionId: "execution-1",
        cellId: "cell-1",
        mode: "notebook",
        generation: "kernel-1",
      },
      attribution: "execution",
    },
    {
      kind: "display",
      data: { "text/plain": "value" },
      attribution: "background",
    },
  ];
  await store.appendJournal(entry);
  const read = await store.journal();
  assert.equal(read.length, 1);
  assert.equal(read[0]!.outputs[0]!.attribution, "execution");
  assert.equal(read[0]!.outputs[0]!.origin?.sessionId, "session-origin-attribution");
  assert.equal(read[0]!.outputs[1]!.attribution, "background");

  const badAttribution = journalEntry(2);
  badAttribution.outputs = [{ kind: "stdout", text: "x", attribution: "invalid" as "execution" }];
  await assert.rejects(store.appendJournal(badAttribution), /invalid output attribution/);

  const unknownField = journalEntry(3);
  unknownField.outputs = [{ kind: "stdout", text: "x", extra: "nope" } as unknown as JournalEntry["outputs"][0]];
  await assert.rejects(store.appendJournal(unknownField), /unknown property: extra/);

  const badOriginKey = journalEntry(4);
  badOriginKey.outputs = [{
    kind: "stdout",
    text: "x",
    origin: {
      sessionId: "s",
      executionId: "e",
      mode: "notebook",
      generation: "g",
      rogue: true,
    } as unknown as NonNullable<JournalEntry["outputs"][0]["origin"]>,
  }];
  await assert.rejects(store.appendJournal(badOriginKey), /unknown property: rogue/);

  const badOriginMode = journalEntry(5);
  badOriginMode.outputs = [{
    kind: "stdout",
    text: "x",
    origin: { sessionId: "s", executionId: "e", mode: "invalid" as "notebook", generation: "g" },
  }];
  await assert.rejects(store.appendJournal(badOriginMode), /invalid output origin mode/);

  const emptySessionId = journalEntry(6);
  emptySessionId.outputs = [{
    kind: "stdout",
    text: "x",
    origin: { sessionId: "", executionId: "e", mode: "notebook", generation: "g" },
  }];
  await assert.rejects(store.appendJournal(emptySessionId), /invalid output origin sessionId/);
});
