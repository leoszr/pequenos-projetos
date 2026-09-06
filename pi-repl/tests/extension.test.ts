import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import createDefaultExtension, {
  createExtension,
  projectStateRoot,
  PROVIDER_EVENT,
  TOOL_NAME,
  type CooperativeProviderRequest,
} from "../src/index.ts";
import type { ToolProvider } from "../src/bridge/types.ts";
import type { ExecutionResult } from "../src/execution/engine.ts";
import type { ExecutionSupervisor } from "../src/tool/router.ts";
import { validateReplRequest } from "../src/tool/request.ts";

test("request validation enforces action discriminants and rejects stray fields", () => {
  assert.deepEqual(validateReplRequest({ mode: "code", action: "exec", code: "return 1" }), {
    mode: "code",
    action: "exec",
    code: "return 1",
  });
  assert.throws(() => validateReplRequest({ mode: "notebook", action: "exec" }), /requires code/);
  assert.throws(() => validateReplRequest({ mode: "code", action: "snapshot" }), /requires mode=notebook/);
  assert.throws(() => validateReplRequest({ mode: "notebook", action: "reset", scope: "bindings" }), /scope=session/);
  assert.throws(
    () => validateReplRequest({ mode: "notebook", action: "profile", operation: "list", name: "unexpected" }),
    /does not accept name/,
  );
  assert.throws(
    () => validateReplRequest({ mode: "code", action: "status", code: "silently ignored" }),
    /Unsupported field/,
  );
  assert.throws(
    () => validateReplRequest({ mode: "code", action: "status", unknown: true }),
    /Invalid repl_notebook request/,
  );
  assert.deepEqual(
    validateReplRequest({ mode: "notebook", action: "prune", names: ["x"], scope: "bindings", dry_run: false }),
    { mode: "notebook", action: "prune", names: ["x"], scope: "bindings", dry_run: false },
  );
  assert.deepEqual(
    validateReplRequest({ mode: "notebook", action: "prune", names: ["x"], scope: "bindings", operation: "apply" }),
    { mode: "notebook", action: "prune", names: ["x"], scope: "bindings", operation: "apply" },
  );
  assert.deepEqual(
    validateReplRequest({ mode: "notebook", action: "prune", names: ["x"], scope: "bindings", dry_run: false, operation: "apply" }),
    { mode: "notebook", action: "prune", names: ["x"], scope: "bindings", dry_run: false, operation: "apply" },
  );
  assert.deepEqual(
    validateReplRequest({ mode: "notebook", action: "prune", names: ["x"], scope: "bindings", dry_run: true, operation: "dry_run" }),
    { mode: "notebook", action: "prune", names: ["x"], scope: "bindings", dry_run: true, operation: "dry_run" },
  );
  assert.throws(
    () => validateReplRequest({ mode: "notebook", action: "prune", names: ["x"], scope: "bindings", dry_run: true, operation: "apply" }),
    /conflicting parameters/i,
  );
  assert.throws(
    () => validateReplRequest({ mode: "notebook", action: "prune", names: ["x"], scope: "bindings", dry_run: false, operation: "dry_run" }),
    /conflicting parameters/i,
  );
  assert.throws(
    () => validateReplRequest({ mode: "notebook", action: "prune", names: ["x"], scope: "bindings", dry_run: false, operation: "dry-run" }),
    /conflicting parameters/i,
  );
  assert.throws(
    () => validateReplRequest({ mode: "notebook", action: "prune", names: ["x"], scope: "bindings", operation: "save" }),
    /operation=dry_run\|apply/,
  );
  assert.throws(
    () => validateReplRequest({ mode: "notebook", action: "prune", names: ["x"], scope: "bindings", operation: "invalid" as unknown as "apply" }),
    /Invalid repl_notebook request at \/operation/,
  );
  assert.throws(
    () => validateReplRequest({ mode: "notebook", action: "prune", names: ["x"], scope: "session" }),
    /scope=bindings/,
  );
});

test("extension registers one tool on session_start and stays lazy for load and status", async () => {
  const pi = new MockPi([toolInfo("read")], ["read"]);
  let managerCreations = 0;
  createExtension({ createManager: () => {
    managerCreations++;
    return fakeSupervisor();
  } })(pi.api);

  assert.equal(pi.registeredTools.length, 0);
  assert.equal(managerCreations, 0);
  await pi.emit("session_start", {}, pi.context());
  assert.deepEqual(pi.registeredTools.map((tool) => tool.name), [TOOL_NAME]);
  assert.equal(managerCreations, 0);
  assert.equal(pi.setActiveCalls, 0);
  assert.equal(pi.getAllTools().find((tool) => tool.name === "read"), pi.initialTools[0]);

  await pi.command("repl", "status");
  assert.equal(managerCreations, 0);
  assert.match(pi.notifications.at(-1)?.message ?? "", /"initialized": false/);

  const definition = pi.definition(TOOL_NAME);
  assert.ok(definition.promptGuidelines?.every((line) => line.includes(TOOL_NAME)));
});

test("repl_notebook collision fails soft without replacing the existing tool", async () => {
  const existing = toolInfo(TOOL_NAME, "/existing/extension.ts");
  const pi = new MockPi([existing, toolInfo("notebook")], [TOOL_NAME, "notebook"]);
  let managerCreations = 0;
  createExtension({ createManager: () => {
    managerCreations++;
    return fakeSupervisor();
  } })(pi.api);

  await pi.emit("session_start", {}, pi.context());
  assert.equal(pi.registeredTools.length, 0);
  assert.equal(pi.getAllTools().find((tool) => tool.name === TOOL_NAME), existing);
  assert.equal(managerCreations, 0);
  assert.match(pi.notifications.at(-1)?.message ?? "", /already registered/);
  await pi.command("repl", "enable");
  assert.equal(pi.notifications.at(-1)?.type, "error");
});

test("cooperative provider is requested synchronously and tools use current Pi metadata", async () => {
  const nestedDefinition = definition("mock_a");
  const pi = new MockPi([toolInfo("read"), toolInfo("mock_a")], ["read", "mock_a"]);
  let managerCreations = 0;
  const provider: ToolProvider = {
    list: () => pi.getAllTools().filter((tool) => tool.name === "mock_a"),
    resolve: (name) => name === "mock_a" ? {
      definition: nestedDefinition,
      capabilities: capabilities(),
    } : undefined,
    preflight() { return Promise.resolve(); },
    invoke() { return Promise.resolve(null); },
  };
  pi.eventsOn(PROVIDER_EVENT, (value) => (value as CooperativeProviderRequest).accept(provider));
  createExtension({ createManager: () => {
    managerCreations++;
    return fakeSupervisor();
  } })(pi.api);
  await pi.emit("session_start", {}, pi.context());

  const result = await pi.executeTool({ mode: "code", action: "tools" });
  assert.equal(managerCreations, 0);
  assert.match(textOf(result), /mock_a/);
  assert.doesNotMatch(textOf(result), /"name": "read"/);
  assert.match(textOf(result), /"cooperativeProvider": "available"/);
});

test("execution converts bounded rich output, supports cursors, ignores model switches, and awaits shutdown", async () => {
  const pi = new MockPi([toolInfo("read")], ["read"]);
  let shutdownCalls = 0;
  let releaseShutdown: (() => void) | undefined;
  const shutdownGate = new Promise<void>((resolve) => { releaseShutdown = resolve; });
  const execution = result([
    { kind: "stdout", text: "first\n", attribution: "execution" },
    {
      kind: "display",
      data: { "image/png": Buffer.from("png").toString("base64"), "application/x-custom": { answer: 42 } },
      metadata: { width: 10, source: "test" },
      attribution: "execution",
    },
  ]);
  const supervisor = fakeSupervisor({
    start: () => Promise.resolve(execution),
    wait: () => Promise.resolve(execution),
    shutdown: async () => {
      shutdownCalls++;
      await shutdownGate;
    },
  });
  createExtension({ createManager: () => supervisor })(pi.api);
  const context = pi.context();
  await pi.emit("session_start", {}, context);

  const first = await pi.executeTool({ mode: "code", action: "exec", code: "return 1" });
  assert.equal(first.content.some((item) => item.type === "image" && item.mimeType === "image/png"), true);
  assert.match(JSON.stringify(first.details), /application\/x-custom/);
  assert.ok(Buffer.byteLength(JSON.stringify(first)) <= 1024 * 1024);

  const waited = await pi.executeTool({
    mode: "code",
    action: "wait",
    execution_id: execution.executionId,
    cursor: 1,
  });
  assert.doesNotMatch(textOf(waited), /first/);
  assert.equal((waited.details as { next_cursor: number }).next_cursor, 2);

  await pi.emit("model_select", {}, context);
  assert.equal(shutdownCalls, 0);

  let settled = false;
  const shutdown = pi.emit("session_shutdown", {}, context).then(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(settled, false);
  assert.equal(shutdownCalls, 1);
  releaseShutdown?.();
  await shutdown;
  assert.equal(settled, true);
});

test("slash administration catches shutdown failures and reports them", async () => {
  const pi = new MockPi();
  const supervisor = fakeSupervisor({
    start: () => Promise.resolve(result([])),
    shutdown: () => Promise.reject(new Error("cleanup exploded")),
  });
  createExtension({ createManager: () => supervisor })(pi.api);
  await pi.emit("session_start", {}, pi.context());
  await pi.executeTool({ mode: "code", action: "exec", code: "return 1" });

  await pi.command("repl", "disable");
  assert.equal(pi.notifications.at(-1)?.type, "error");
  assert.match(pi.notifications.at(-1)?.message ?? "", /cleanup exploded/);
});

test("default export is an extension and project state root remains cwd-partitioned", () => {
  assert.equal(typeof createDefaultExtension, "function");
  const previous = process.env.PI_REPL_STATE_DIR;
  process.env.PI_REPL_STATE_DIR = "/tmp/pi-repl-test-root";
  try {
    const first = projectStateRoot("/tmp/project-a");
    const second = projectStateRoot("/tmp/project-b");
    assert.notEqual(first, second);
    assert.match(first, /^\/tmp\/pi-repl-test-root\/[a-f0-9]{64}$/);
  } finally {
    if (previous === undefined) delete process.env.PI_REPL_STATE_DIR;
    else process.env.PI_REPL_STATE_DIR = previous;
  }
});

test("public prune tool action handles dry-run and apply contracts", async () => {
  const pi = new MockPi();
  const pruneCalls: Array<{ names: string[]; scope: string; dryRun?: boolean }> = [];
  const supervisor = fakeSupervisor({
    notebook: {
      ...fakeSupervisor().notebook,
      prune: (names: string[], scope: string, dryRun = true) => {
        pruneCalls.push({ names, scope, dryRun });
        return Promise.resolve({ candidates: names, protected: [], applied: !dryRun });
      },
    },
  });
  createExtension({ createManager: () => supervisor })(pi.api);
  await pi.emit("session_start", {}, pi.context());

  const defResult = await pi.executeTool({ mode: "notebook", action: "prune", names: ["tempA"], scope: "bindings" });
  assert.equal(pruneCalls.at(-1)?.dryRun, true);
  assert.match(textOf(defResult), /"applied": false/);

  const applyBoolResult = await pi.executeTool({ mode: "notebook", action: "prune", names: ["tempA"], scope: "bindings", dry_run: false });
  assert.equal(pruneCalls.at(-1)?.dryRun, false);
  assert.match(textOf(applyBoolResult), /"applied": true/);

  const applyOpResult = await pi.executeTool({ mode: "notebook", action: "prune", names: ["tempA"], scope: "bindings", operation: "apply" });
  assert.equal(pruneCalls.at(-1)?.dryRun, false);
  assert.match(textOf(applyOpResult), /"applied": true/);

  const dryOpResult = await pi.executeTool({ mode: "notebook", action: "prune", names: ["tempA"], scope: "bindings", operation: "dry_run" });
  assert.equal(pruneCalls.at(-1)?.dryRun, true);
  assert.match(textOf(dryOpResult), /"applied": false/);

  await assert.rejects(
    () => pi.executeTool({ mode: "notebook", action: "prune", names: ["tempA"], scope: "bindings", dry_run: true, operation: "apply" }),
    /conflicting parameters/i,
  );
  await assert.rejects(
    () => pi.executeTool({ mode: "notebook", action: "prune", names: ["tempA"], scope: "bindings", dry_run: false, operation: "dry_run" }),
    /conflicting parameters/i,
  );
});

type Handler = (event: unknown, context: ExtensionContext) => unknown;
type Command = { handler: (args: string, context: ExtensionContext) => Promise<void> };

class MockPi {
  readonly initialTools: ToolInfo[];
  readonly registeredTools: ToolDefinition[] = [];
  readonly notifications: Array<{ message: string; type?: string }> = [];
  readonly api: ExtensionAPI;
  setActiveCalls = 0;
  private readonly handlers = new Map<string, Handler[]>();
  private readonly listeners = new Map<string, Array<(value: unknown) => void>>();
  private readonly commands = new Map<string, Command>();
  private readonly definitions = new Map<string, ToolDefinition>();
  private active: string[];

  constructor(tools: ToolInfo[] = [], active: string[] = []) {
    this.initialTools = tools;
    this.active = [...active];
    // deno-lint-ignore no-this-alias
    const mock = this;
    this.api = {
      on(event: string, handler: Handler) {
        const list = mock.handlers.get(event) ?? [];
        list.push(handler);
        mock.handlers.set(event, list);
      },
      registerTool(tool: ToolDefinition) {
        mock.registeredTools.push(tool);
        mock.definitions.set(tool.name, tool);
        if (!mock.active.includes(tool.name)) mock.active.push(tool.name);
      },
      registerCommand(name: string, command: Command) { mock.commands.set(name, command); },
      getAllTools: () => mock.getAllTools(),
      getActiveTools: () => [...mock.active],
      setActiveTools(names: string[]) { mock.setActiveCalls++; mock.active = [...names]; },
      events: {
        emit(channel: string, value: unknown) {
          for (const listener of mock.listeners.get(channel) ?? []) listener(value);
        },
        on(channel: string, listener: (value: unknown) => void) {
          const list = mock.listeners.get(channel) ?? [];
          list.push(listener);
          mock.listeners.set(channel, list);
          return () => mock.listeners.set(channel, (mock.listeners.get(channel) ?? []).filter((item) => item !== listener));
        },
      },
    } as unknown as ExtensionAPI;
  }

  context(): ExtensionContext {
    // deno-lint-ignore no-this-alias
    const mock = this;
    return {
      cwd: "/workspace/project",
      sessionManager: { getSessionId: () => "session-1" },
      ui: {
        notify(message: string, type?: "info" | "warning" | "error") {
          mock.notifications.push({ message, type });
        },
      },
    } as unknown as ExtensionContext;
  }

  getAllTools(): ToolInfo[] {
    return [
      ...this.initialTools,
      ...this.registeredTools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        promptGuidelines: tool.promptGuidelines,
        sourceInfo: source("/pi-repl/src/index.ts"),
      })),
    ];
  }

  definition(name: string): ToolDefinition {
    const found = this.definitions.get(name);
    assert.ok(found, `Missing tool definition: ${name}`);
    return found;
  }

  eventsOn(channel: string, listener: (value: unknown) => void): void {
    const list = this.listeners.get(channel) ?? [];
    list.push(listener);
    this.listeners.set(channel, list);
  }

  async emit(event: string, payload: object, context: ExtensionContext): Promise<void> {
    for (const handler of this.handlers.get(event) ?? []) await handler({ type: event, ...payload }, context);
  }

  async command(name: string, args: string): Promise<void> {
    const command = this.commands.get(name);
    assert.ok(command, `Missing command: ${name}`);
    await command.handler(args, this.context());
  }

  executeTool(request: unknown) {
    return this.definition(TOOL_NAME).execute("call-1", request as never, undefined, undefined, this.context());
  }
}

function source(path: string) {
  return { path, source: "extension", scope: "temporary", origin: "top-level" } as const;
}

function toolInfo(name: string, path = `<builtin:${name}>`): ToolInfo {
  return {
    name,
    description: `${name} description`,
    parameters: Type.Object({}),
    sourceInfo: source(path),
  };
}

function definition(name: string): ToolDefinition {
  return {
    name,
    label: name,
    description: `${name} definition`,
    parameters: Type.Object({ value: Type.String() }),
    execute() { return Promise.resolve({ content: [{ type: "text", text: "ok" }], details: {} }); },
  };
}

function capabilities() {
  return {
    code: true,
    notebook: true,
    interactive: false,
    approval: false,
    parallel: true,
    cancellable: true,
    nested: true,
  };
}

function result(outputs: ExecutionResult["outputs"]): ExecutionResult {
  return {
    sessionId: "session-1",
    executionId: "execution-1",
    generation: "generation-1",
    mode: "code",
    state: "completed",
    cleanup: "completed",
    outputs,
    value: { answer: 42 },
    startedAt: "2026-01-02T03:04:05.000Z",
    durationMs: 10,
  };
}

function fakeSupervisor(overrides: Partial<ExecutionSupervisor> = {}): ExecutionSupervisor {
  const status = () => ({ enabled: true, executions: [] });
  const notebook = {
    checkpoint: () => Promise.resolve(undefined),
    snapshot: () => Promise.resolve({}),
    restart: () => Promise.resolve({}),
    reset: () => Promise.resolve({}),
    pin: () => Promise.resolve({}),
    release: () => Promise.resolve({}),
    prune: (names: string[], _scope: string, dryRun = true) => Promise.resolve({ candidates: names, protected: [], applied: !dryRun }),
    profile: () => Promise.resolve({}),
    promote: () => Promise.resolve({}),
    rollback: () => Promise.resolve({}),
    status,
    diagnostics: status,
    store: {
      project: () => Promise.resolve({ generation: 0 }),
      journal: () => Promise.resolve([]),
      exportNotebook: () => Promise.resolve({}),
    },
  };
  return {
    notebook,
    start: () => Promise.resolve(result([])),
    wait: () => Promise.resolve(result([])),
    interrupt: () => Promise.resolve(result([])),
    administer: (operation: () => Promise<unknown>) => operation(),
    status,
    shutdown: async () => {},
    ...overrides,
  } as unknown as ExecutionSupervisor;
}

function textOf(result: Awaited<ReturnType<MockPi["executeTool"]>>): string {
  return result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
}
