import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { SNAPSHOT_MIME, snapshotSource, valueFrom } from "../src/execution/bootstrap.ts";
import type { ExecutionIdentity, KernelOutput } from "../src/kernel/backend.ts";
import { createJupyterKernel } from "../src/kernel/jupyter.ts";

function identity(kernel: { generation: string }, extra: Partial<ExecutionIdentity> = {}): ExecutionIdentity {
  return {
    sessionId: "kernel-integration",
    executionId: randomUUID(),
    mode: "notebook",
    generation: kernel.generation,
    ...extra,
  };
}

function texts(outputs: KernelOutput[], kind: KernelOutput["kind"]): string[] {
  return outputs.filter((output) => output.kind === kind).map((output) => output.text ?? "");
}

test("deno kernel preserves TypeScript semantics, output and errors", async (t) => {
  const seen: KernelOutput[] = [];
  const kernel = createJupyterKernel({
    cwd: process.cwd(),
    mode: "notebook",
    sessionId: "kernel-integration",
    startupTimeoutMs: 30_000,
    onOutput: (output) => seen.push(output),
  });
  t.after(() => kernel.shutdown());

  await kernel.start();
  assert.equal(kernel.state, "available");

  // Lexical bindings, TypeScript types, closures, classes and destructuring.
  const setup = await kernel.execute(
    `const greeting: string = "hello";\nlet counter = 1;\nfunction add(a: number, b: number) { return a + b; }\nclass Box { constructor(readonly value: number) {} get doubled() { return this.value * 2; } }\nconst { doubled } = new Box(21);\nconst make = () => { const hidden = 7; return () => hidden + counter; };\nconst fn = make();`,
    identity(kernel),
  );
  assert.equal(setup.status, "ok", setup.error);

  const use = await kernel.execute(`greeting + " " + (counter += 1) + " " + add(2, 3) + " " + doubled + " " + fn()`, identity(kernel));
  assert.equal(use.status, "ok", use.error);

  // Top-level await.
  const awaited = await kernel.execute(`await new Promise((resolve) => setTimeout(() => resolve("tla-ok"), 10))`, identity(kernel));
  assert.equal(awaited.status, "ok", awaited.error);

  // Redeclaration behaviour matches a REPL: let can be reassigned, const cannot.
  const reassign = await kernel.execute(`counter = 42\ncounter`, identity(kernel));
  assert.equal(reassign.status, "ok", reassign.error);

  // Console output is captured without corrupting the control channel.
  seen.length = 0;
  const logged = await kernel.execute(`console.log("out-1");\nconsole.error("err-1");\n"text-result"`, identity(kernel));
  assert.equal(logged.status, "ok", logged.error);
  assert.match(texts(logged.outputs, "stdout").join("\n"), /out-1/);
  assert.match(texts(logged.outputs, "stderr").join("\n"), /err-1/);

  // Runtime errors report useful text instead of hanging the kernel.
  const failure = await kernel.execute(`throw new Error("boom-marker")`, identity(kernel));
  assert.equal(failure.status, "error");
  assert.match([failure.error ?? "", ...texts(failure.outputs, "error")].join("\n"), /boom-marker/);

  // The kernel stays usable after an error and concurrent startup shares one boot.
  // Concurrent executions are serialized by the kernel: both complete ok,
  // neither is rejected, and no update is lost.
  await assert.rejects(kernel.execute(`1`, { ...identity(kernel), generation: "stale" }), /another kernel generation/);
  const [first, second] = await Promise.all([
    kernel.execute(`counter += 1`, identity(kernel)),
    kernel.execute(`counter += 1`, identity(kernel)),
  ]);
  assert.equal(first.status, "ok", first.error);
  assert.equal(second.status, "ok", second.error);
  // deno-lint-ignore no-control-regex
  const increments = [first, second].map((result) => texts(result.outputs, "result").join("\n").replace(/\u001b\[[0-9;]*m/g, "").trim()).sort();
  assert.deepEqual(increments, ["43", "44"]);
  const after = await kernel.execute(`counter`, identity(kernel));
  assert.equal(after.status, "ok", after.error);
  assert.match(texts(after.outputs, "result").join("\n"), /44/);
  const diagnostics = kernel.diagnostics() as { state: string; pendingExecutions: number };
  assert.equal(diagnostics.state, kernel.state);
  assert.equal(diagnostics.state, "available");
  assert.equal(diagnostics.pendingExecutions, 0);
});

test("deno kernel snapshots bindings best-effort without losing the rest", async (t) => {
  const kernel = createJupyterKernel({
    cwd: process.cwd(),
    mode: "notebook",
    sessionId: "kernel-snapshot",
    startupTimeoutMs: 30_000,
  });
  t.after(() => kernel.shutdown());
  await kernel.start();
  const id = (): ExecutionIdentity => ({
    sessionId: "kernel-snapshot",
    executionId: randomUUID(),
    mode: "notebook",
    generation: kernel.generation,
  });

  const stub = await kernel.execute(
    `var __repl = { emit: (data: unknown) => (Deno as unknown as { jupyter: { display: (data: unknown, options: unknown) => void } }).jupyter.display(data, { raw: true }) };`,
    id(),
  );
  assert.equal(stub.status, "ok", stub.error);

  const setup = await kernel.execute(
    `const keep = { a: 1, nested: [1, 2, 3] };\nlet count = 3;\nconst label = "hello";\nconst nums = [1, 2, 3];\nconst alias = keep;\nconst cyc: Record<string, unknown> = {};\ncyc.self = cyc;\nfunction fn() { return 1; }\nconst withGetter = { get x() { return 1; } };`,
    id(),
  );
  assert.equal(setup.status, "ok", setup.error);

  const snap = await kernel.execute(
    snapshotSource([
      { name: "keep", declaration: "const" },
      { name: "count", declaration: "let" },
      { name: "label", declaration: "const" },
      { name: "nums", declaration: "const" },
      { name: "alias", declaration: "const" },
      { name: "cyc", declaration: "const" },
      { name: "fn", declaration: "function" },
      { name: "withGetter", declaration: "const" },
      { name: "missing", declaration: "let" },
      { name: "DummyClass", declaration: "class" },
      { name: "DummyImport", declaration: "import" },
      { name: "DummyEnum", declaration: "enum" },
    ], 1024),
    id(),
  );
  assert.equal(snap.status, "ok", snap.error);
  const payload = valueFrom(snap.outputs, SNAPSHOT_MIME) as
    | { bindings: Array<{ name: string; declaration: string; status: string; value?: unknown; reason?: string }> }
    | undefined;
  assert.ok(payload, "expected a snapshot MIME payload");
  const byName = new Map(payload.bindings.map((binding) => [binding.name, binding]));
  assert.equal(byName.get("count")?.status, "saved");
  assert.deepEqual(byName.get("count")?.value, 3);
  assert.equal(byName.get("label")?.status, "saved");
  assert.deepEqual(byName.get("label")?.value, "hello");
  assert.equal(byName.get("nums")?.status, "saved");
  assert.deepEqual(byName.get("nums")?.value, [1, 2, 3]);
  // Shared identity is not silently duplicated: both aliases are excluded.
  assert.equal(byName.get("keep")?.status, "excluded");
  assert.equal(byName.get("alias")?.status, "excluded");
  assert.match(byName.get("keep")?.reason ?? "", /Shared object identity/);
  assert.equal(byName.get("cyc")?.status, "excluded");
  assert.match(byName.get("cyc")?.reason ?? "", /Cyclic reference/);
  assert.equal(byName.get("fn")?.status, "excluded");
  assert.match(byName.get("fn")?.reason ?? "", /Declaration semantics/);
  assert.equal(byName.get("withGetter")?.status, "excluded");
  assert.match(byName.get("withGetter")?.reason ?? "", /Non-plain property descriptor/);
  assert.equal(byName.get("missing")?.status, "excluded");
  assert.equal(byName.get("DummyClass")?.status, "excluded");
  assert.match(byName.get("DummyClass")?.reason ?? "", /Declaration semantics/);
  assert.equal(byName.get("DummyImport")?.status, "excluded");
  assert.equal(byName.get("DummyEnum")?.status, "excluded");
});
