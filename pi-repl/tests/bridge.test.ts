import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import type {
  ExtensionContext,
  ToolDefinition,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ToolRegistry } from "../src/bridge/registry.ts";
import { BridgeServer } from "../src/bridge/server.ts";
import type {
  BridgeExecution,
  NestedContext,
  ToolCapabilities,
  ToolProvider,
} from "../src/bridge/types.ts";

const sourceInfo = {
  path: "/test/tool.ts",
  source: "test",
  scope: "temporary" as const,
  origin: "top-level" as const,
};

function definition(name = "echo", prepareArguments?: (args: unknown) => { value: number }): ToolDefinition {
  return {
    name,
    label: name,
    description: `Test tool ${name}`,
    parameters: Type.Object({ value: Type.Number() }, { additionalProperties: false }),
    prepareArguments,
    execute() {
      return Promise.reject(new Error("ToolDefinition.execute must not bypass the host provider"));
    },
  };
}

function info(tool: ToolDefinition): ToolInfo {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    promptGuidelines: tool.promptGuidelines,
    sourceInfo,
  };
}

function capabilities(overrides: Partial<ToolCapabilities> = {}): ToolCapabilities {
  return {
    code: true,
    notebook: true,
    interactive: false,
    approval: false,
    parallel: true,
    cancellable: true,
    nested: true,
    ...overrides,
  };
}

function context(cwd = "/worktree"): ExtensionContext {
  return { cwd } as ExtensionContext;
}

function execution(
  executionId = "execution-1",
  signal = new AbortController().signal,
  onUpdate: (value: unknown) => void = () => {},
  overrides: Partial<BridgeExecution["identity"]> = {},
): BridgeExecution {
  return {
    identity: {
      sessionId: "session-1",
      executionId,
      cellId: "cell-1",
      mode: "notebook",
      generation: "generation-1",
      ...overrides,
    },
    context: context(),
    signal,
    onUpdate,
  };
}

interface Harness {
  registry: ToolRegistry;
  provider: ToolProvider;
  tool: ToolDefinition;
  active: string[];
  caps: ToolCapabilities;
  available: { value: boolean };
}

function harness(options: {
  tool?: ToolDefinition;
  caps?: Partial<ToolCapabilities>;
  preflight?: (name: string, args: unknown, context: NestedContext) => Promise<void>;
  invoke?: (name: string, args: unknown, context: NestedContext) => Promise<unknown>;
} = {}): Harness {
  const tool = options.tool ?? definition();
  const active = [tool.name];
  const caps = capabilities(options.caps);
  const available = { value: true };
  const provider: ToolProvider = {
    list: () => available.value ? [info(tool)] : [],
    resolve: (name) => available.value && name === tool.name ? { definition: tool, capabilities: { ...caps } } : undefined,
    preflight: options.preflight ?? (() => Promise.resolve()),
    invoke: options.invoke ?? ((_name, args) => Promise.resolve(args)),
  };
  return {
    tool,
    active,
    caps,
    available,
    provider,
    registry: new ToolRegistry(() => [info(tool)], () => active, provider),
  };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("registry fails closed without an explicit provider", async () => {
  const tool = definition();
  const registry = new ToolRegistry(() => [info(tool)], () => [tool.name]);

  assert.deepEqual(registry.list("notebook"), []);
  await assert.rejects(registry.invoke(tool.name, { value: 1 }, execution()), /provider is unavailable/);
});

test("registry prepares and validates arguments, then preserves host context, updates, IDs and result", async () => {
  const prepared: unknown[] = [];
  const invoked: unknown[] = [];
  const contexts: NestedContext[] = [];
  const invokeContexts: NestedContext[] = [];
  const updates: unknown[] = [];
  let prepareCalls = 0;
  const result = { content: [{ type: "text", text: "complete" }], details: { kept: true } };
  const controller = new AbortController();
  const tool = definition("echo", (args) => {
    prepareCalls++;
    return { value: Number((args as { value: string }).value) };
  });
  const h = harness({
    tool,
    preflight: (_name, args, nested) => {
      prepared.push(args);
      contexts.push(nested);
      return Promise.resolve();
    },
    invoke: (_name, args, nested) => {
      invoked.push(args);
      invokeContexts.push(nested);
      nested.onUpdate({ partial: true });
      return Promise.resolve(result);
    },
  });
  const bridgeExecution = execution("prepared", controller.signal, (value) => updates.push(value));

  assert.deepEqual(h.registry.list("notebook"), [info(tool)]);
  assert.strictEqual(await h.registry.invoke("echo", { value: "42" }, bridgeExecution), result);
  assert.equal(prepareCalls, 1);
  assert.deepEqual(prepared, [{ value: 42 }]);
  assert.deepEqual(invoked, [{ value: 42 }]);
  assert.strictEqual(invokeContexts[0], contexts[0]);
  assert.deepEqual(updates, [{ partial: true }]);
  assert.equal(contexts[0].cwd, "/worktree");
  assert.strictEqual(contexts[0].context, bridgeExecution.context);
  assert.strictEqual(contexts[0].signal, controller.signal);
  assert.match(contexts[0].toolCallId, /^bridge:prepared:\d+$/);
  assert.deepEqual(
    {
      sessionId: contexts[0].sessionId,
      executionId: contexts[0].executionId,
      cellId: contexts[0].cellId,
      mode: contexts[0].mode,
      generation: contexts[0].generation,
    },
    bridgeExecution.identity,
  );
  await assert.rejects(h.registry.invoke("echo", { value: "not-a-number" }, execution("invalid")), /Invalid arguments/);
});

test("registry preserves provider errors and preflight denials", async () => {
  const denial = new Error("approval denied");
  const denied = harness({ preflight: () => Promise.reject(denial) });
  await assert.rejects(denied.registry.invoke("echo", { value: 1 }, execution("denied")), (error) => error === denial);

  const failure = new Error("host failure");
  const failed = harness({ invoke: () => Promise.reject(failure) });
  await assert.rejects(failed.registry.invoke("echo", { value: 1 }, execution("failed")), (error) => error === failure);
});

test("registry rechecks active tool and capabilities after preflight", async () => {
  const activeGate = deferred();
  let invoked = false;
  const inactive = harness({
    preflight: () => activeGate.promise,
    invoke: () => {
      invoked = true;
      return Promise.resolve();
    },
  });
  const inactiveCall = inactive.registry.invoke("echo", { value: 1 }, execution("inactive-dynamic"));
  inactive.active.length = 0;
  activeGate.resolve();
  await assert.rejects(inactiveCall, /inactive/);
  assert.equal(invoked, false);

  const toolGate = deferred();
  const missing = harness({ preflight: () => toolGate.promise });
  const missingCall = missing.registry.invoke("echo", { value: 1 }, execution("missing-dynamic"));
  missing.available.value = false;
  toolGate.resolve();
  await assert.rejects(missingCall, /unavailable/);

  const capabilityGate = deferred();
  const changed = harness({ preflight: () => capabilityGate.promise });
  const changedCall = changed.registry.invoke("echo", { value: 1 }, execution("capability-dynamic"));
  changed.caps.interactive = true;
  capabilityGate.resolve();
  await assert.rejects(changedCall, /not allowed/);
});

test("registry lets an accepted nested call finish after close and reports pending cleanup", async () => {
  const gate = deferred();
  const result = { complete: true };
  const h = harness({
    preflight: () => gate.promise,
    invoke: () => Promise.resolve(result),
  });
  const current = execution("close-during-preflight");
  const call = h.registry.invoke("echo", { value: 1 }, current);
  h.registry.closeExecution("close-during-preflight");

  assert.equal(await h.registry.settle("close-during-preflight", 5), false);
  await assert.rejects(h.registry.invoke("echo", { value: 2 }, current), /execution is closed/);
  gate.resolve();
  assert.strictEqual(await call, result);
  assert.equal(await h.registry.settle("close-during-preflight", 50), true);
});

test("registry rejects recursion, interaction and unsafe mode capabilities", async () => {
  const own = harness({ tool: definition("repl_notebook") });
  await assert.rejects(own.registry.invoke("repl_notebook", { value: 1 }, execution("own")), /not allowed/);

  for (const [id, cap] of [
    ["interactive", { interactive: true }],
    ["nested", { nested: false }],
    ["cancellable", { cancellable: false }],
    ["mode", { notebook: false }],
  ] as const) {
    const h = harness({ caps: cap });
    assert.deepEqual(h.registry.list("notebook"), []);
    await assert.rejects(h.registry.invoke("echo", { value: 1 }, execution(id)), /not allowed/);
  }

  const approval = harness({ caps: { approval: true } });
  assert.deepEqual(await approval.registry.invoke("echo", { value: 1 }, execution("approval")), { value: 1 });
});

test("registry limits each execution to 64 calls", async () => {
  const h = harness();
  const current = execution("counted");
  for (let index = 0; index < 64; index++) {
    assert.deepEqual(await h.registry.invoke("echo", { value: index }, current), { value: index });
  }
  await assert.rejects(h.registry.invoke("echo", { value: 65 }, current), /call limit exceeded/);
});

test("registry bounds parallel calls, propagates abort and tracks late cleanup after close", async () => {
  const pending: Array<ReturnType<typeof deferred<unknown>>> = [];
  const contexts: NestedContext[] = [];
  const controller = new AbortController();
  const h = harness({
    preflight: (_name, _args, nested) => {
      contexts.push(nested);
      return Promise.resolve();
    },
    invoke: () => {
      const gate = deferred<unknown>();
      pending.push(gate);
      return gate.promise;
    },
  });
  const current = execution("parallel", controller.signal);
  const calls = Array.from({ length: 8 }, (_, value) => h.registry.invoke("echo", { value }, current));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(pending.length, 8);
  assert.equal(new Set(contexts.map((item) => item.toolCallId)).size, 8);
  assert.ok(contexts.every((item) => item.signal === controller.signal));
  await assert.rejects(h.registry.invoke("echo", { value: 9 }, current), /parallel limit exceeded/);

  controller.abort();
  h.registry.closeExecution("parallel");
  assert.equal(await h.registry.settle("parallel", 5), false);
  await assert.rejects(h.registry.invoke("echo", { value: 10 }, current), /execution is closed/);

  pending.forEach((gate, index) => gate.resolve({ full: index }));
  assert.deepEqual(await Promise.all(calls), Array.from({ length: 8 }, (_, full) => ({ full })));
  assert.equal(await h.registry.settle("parallel", 50), true);
});

test("registry keeps non-parallel tools exclusive", async () => {
  const gate = deferred<unknown>();
  const h = harness({ caps: { parallel: false }, invoke: () => gate.promise });
  const current = execution("exclusive");
  const first = h.registry.invoke("echo", { value: 1 }, current);
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(h.registry.invoke("echo", { value: 2 }, current), /parallel limit exceeded/);
  gate.resolve({ done: true });
  assert.deepEqual(await first, { done: true });
});

async function post(
  started: { url: string; token: string },
  body: unknown,
  token = started.token,
): Promise<{ response: Response; value: Record<string, unknown> }> {
  const response = await fetch(started.url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { response, value: await response.json() as Record<string, unknown> };
}

function message(type: "hello" | "tools" | "call", requestId: string, overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    type,
    requestId,
    sessionId: "session-1",
    executionId: "http-execution",
    cellId: "cell-1",
    mode: "notebook",
    generation: "generation-1",
    ...overrides,
  };
}

test("HTTP bridge authenticates, handshakes, checks version and identity, and preserves calls", async () => {
  const result = { content: [{ type: "text", text: "full" }], details: { code: 7 } };
  const h = harness({ invoke: () => Promise.resolve(result) });
  const server = new BridgeServer(h.registry);
  assert.equal((server as unknown as { server?: unknown }).server, undefined);
  server.open(execution("http-execution"));
  const started = await server.start();
  assert.strictEqual(await server.start(), started);

  try {
    const unauthorized = await post(started, message("hello", "unauthorized"), "wrong-token");
    assert.equal(unauthorized.response.status, 401);
    assert.equal(unauthorized.value.ok, false);

    const noHandshake = await post(started, { ...message("call", "early"), name: "echo", args: { value: 1 } });
    assert.equal(noHandshake.response.status, 400);
    assert.match(String(noHandshake.value.error), /handshake required/);

    const wrongVersion = await post(started, message("hello", "version", { version: 2 }));
    assert.equal(wrongVersion.response.status, 400);
    assert.match(String(wrongVersion.value.error), /Unsupported bridge version/);

    const stale = await post(started, message("hello", "stale", { generation: "old" }));
    assert.equal(stale.response.status, 409);
    assert.match(String(stale.value.error), /Stale/);

    const hello = await post(started, message("hello", "hello"));
    assert.equal(hello.response.status, 200);
    assert.deepEqual(hello.value, {
      version: 1,
      requestId: "hello",
      ok: true,
      value: { version: 1, policies: h.registry.policies() },
    });

    const tools = await post(started, message("tools", "tools"));
    assert.equal(tools.response.status, 200);
    assert.deepEqual((tools.value.value as Array<{ name: string }>).map((tool) => tool.name), ["echo"]);

    const call = await post(started, { ...message("call", "call"), name: "echo", args: { value: 7 } });
    assert.equal(call.response.status, 200);
    assert.deepEqual(call.value, { version: 1, requestId: "call", ok: true, value: result });

    server.closeExecution("http-execution");
    const closed = await post(started, message("hello", "closed"));
    assert.equal(closed.response.status, 409);
    assert.match(String(closed.value.error), /Stale/);
  } finally {
    await server.shutdown();
    await server.shutdown();
  }
  assert.equal((server as unknown as { server?: unknown }).server, undefined);
});

test("HTTP bridge enforces request and response byte limits", async () => {
  const h = harness({ invoke: () => Promise.resolve({ text: "x".repeat(1_000) }) });
  const server = new BridgeServer(h.registry, 384);
  server.open(execution("http-execution"));
  const started = await server.start();
  try {
    assert.equal((await post(started, message("hello", "hello"))).response.status, 200);

    const oversizedResponse = await post(started, { ...message("call", "response"), name: "echo", args: { value: 1 } });
    assert.equal(oversizedResponse.response.status, 413);
    assert.match(String(oversizedResponse.value.error), /response exceeds byte limit/);
    assert.equal(oversizedResponse.value.requestId, "");

    const oversizedRequest = await post(started, {
      ...message("call", "request"),
      name: "echo",
      args: { value: 1, padding: "x".repeat(1_000) },
    });
    assert.equal(oversizedRequest.response.status, 413);
    assert.match(String(oversizedRequest.value.error), /request exceeds byte limit/);
    assert.equal(oversizedRequest.value.requestId, "");

    const unknownTool = await post(started, { ...message("call", "unknown"), name: "missing", args: {} });
    assert.equal(unknownTool.response.status, 404);

    const invalidArgs = await post(started, { ...message("call", "invalid"), name: "echo", args: {} });
    assert.equal(invalidArgs.response.status, 400);
  } finally {
    await server.shutdown();
  }
});

test("HTTP bridge times out an incomplete authenticated body and frees the slot", async () => {
  const h = harness();
  const server = new BridgeServer(h.registry, 1024 * 1024, 50);
  server.open(execution("http-timeout"));
  const started = await server.start();
  try {
    let statusCode = 0;
    let serverClosedSocket = false;
    let responseBody = "";

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timeout waiting for server to close stalled connection")), 2_000);
      const stalled = http.request(started.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${started.token}`,
          "content-type": "application/json",
          "content-length": 10_000,
        },
      });

      stalled.on("socket", (socket) => {
        socket.on("close", () => {
          serverClosedSocket = true;
          clearTimeout(timer);
          resolve();
        });
      });

      stalled.on("response", (response) => {
        statusCode = response.statusCode ?? 0;
        response.on("data", (chunk: Buffer) => {
          responseBody += chunk.toString();
        });
      });

      stalled.on("error", () => {
        // Client-side socket errors on server abrupt close are expected on some platforms
      });

      stalled.write('{"version":1');
    });

    assert.equal(statusCode, 408);
    assert.equal(serverClosedSocket, true);
    assert.match(responseBody, /Bridge request body timed out/);

    const hello = await post(started, message("hello", "after-timeout", { executionId: "http-timeout" }));
    assert.equal(hello.response.status, 200);
    assert.equal(hello.value.ok, true);
  } finally {
    await server.shutdown();
  }
});

test("HTTP bridge cleans up multiple timed-out connections without leaking active slots or sockets", async () => {
  const h = harness();
  const server = new BridgeServer(h.registry, 1024 * 1024, 50);
  server.open(execution("http-multi-timeout"));
  const started = await server.start();
  try {
    const stalledRequests = Array.from({ length: 8 }, () => new Promise<{ statusCode: number; closed: boolean }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timeout waiting for server to close stalled socket")), 2_000);
      let statusCode = 0;
      let closed = false;
      const req = http.request(started.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${started.token}`,
          "content-type": "application/json",
          "content-length": 10_000,
        },
      });
      req.on("socket", (socket) => {
        socket.on("close", () => {
          closed = true;
          clearTimeout(timer);
          resolve({ statusCode, closed });
        });
      });
      req.on("response", (res) => {
        statusCode = res.statusCode ?? 0;
        res.resume();
      });
      req.on("error", () => {});
      req.write('{"version":1');
    }));

    const results = await Promise.all(stalledRequests);
    assert.ok(results.every((r) => r.statusCode === 408));
    assert.ok(results.every((r) => r.closed));

    // All slots are freed immediately; full batch of 8 requests can proceed without 429.
    const calls = await Promise.all(
      Array.from({ length: 8 }, (_, i) => post(started, message("hello", `post-timeout-${i}`, { executionId: "http-multi-timeout" }))),
    );
    assert.ok(calls.every((c) => c.response.status === 200));
    assert.ok(calls.every((c) => c.value.ok === true));
  } finally {
    await server.shutdown();
  }
});

test("HTTP bridge rejects the ninth concurrent request with 429", async () => {
  let release!: () => void;
  const gate = new Promise<unknown>((resolve) => { release = () => resolve({ slow: true }); });
  const h = harness({ invoke: () => gate });
  const server = new BridgeServer(h.registry);
  server.open(execution("http-concurrency"));
  const started = await server.start();
  try {
    await post(started, message("hello", "hello", { executionId: "http-concurrency" }));
    const inFlight = Array.from({ length: 8 }, (_, index) =>
      post(started, { ...message("call", `slow-${index}`, { executionId: "http-concurrency" }), name: "echo", args: { value: index } }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const rejected = await post(started, { ...message("call", "ninth", { executionId: "http-concurrency" }), name: "echo", args: { value: 9 } });
    assert.equal(rejected.response.status, 429);
    release();
    const results = await Promise.all(inFlight);
    assert.ok(results.every((result) => result.response.status === 200));
  } finally {
    release();
    await server.shutdown();
  }
});
