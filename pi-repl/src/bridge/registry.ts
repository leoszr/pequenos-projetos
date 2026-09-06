import type { ToolDefinition, ToolInfo } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import type { Mode } from "../kernel/backend.ts";
import type { BridgeExecution, NestedContext, ToolCapabilities, ToolProvider } from "./types.ts";

const MAX_CALLS = 64;
const MAX_PARALLEL = 8;
const OWN_TOOL = "repl_notebook";

interface ExecutionState {
  calls: number;
  running: number;
  exclusive: boolean;
  pending: Set<Promise<unknown>>;
  waiters: Set<() => void>;
}

interface ResolvedTool {
  provider: ToolProvider;
  definition: ToolDefinition;
  capabilities: ToolCapabilities;
}

export class ToolRegistry {
  private provider?: ToolProvider;
  private readonly states = new Map<string, ExecutionState>();
  private readonly closed = new Set<string>();

  constructor(
    private readonly discover: () => ToolInfo[],
    private readonly active: () => string[],
    provider?: ToolProvider,
  ) {
    this.provider = provider;
  }

  setProvider(provider?: ToolProvider): void {
    this.provider = provider;
  }

  list(mode: Mode): ToolInfo[] {
    const provider = this.provider;
    if (!provider) return [];

    const active = new Set(this.active());
    const provided = new Set(provider.list().map((tool) => tool.name));
    const seen = new Set<string>();
    return this.discover().filter((tool) => {
      if (seen.has(tool.name)) return false;
      seen.add(tool.name);
      if (!active.has(tool.name) || !provided.has(tool.name)) return false;
      try {
        const resolved = provider.resolve(tool.name);
        return !!resolved && resolved.definition.name === tool.name && allowed(tool.name, mode, resolved.capabilities);
      } catch {
        return false;
      }
    });
  }

  policies(): unknown {
    return {
      maxCallsPerExecution: MAX_CALLS,
      maxParallelCallsPerExecution: MAX_PARALLEL,
      interactive: false,
      cancellable: true,
      nested: true,
    };
  }

  async invoke(name: string, args: unknown, execution: BridgeExecution): Promise<unknown> {
    const id = execution.identity.executionId;
    if (this.closed.has(id)) throw new Error(`Bridge execution is closed: ${id}`);
    if (execution.signal.aborted) throw new Error(`Bridge execution is aborted: ${id}`);

    const resolved = this.resolve(name, execution.identity.mode);
    const prepared = prepare(resolved.definition, args);
    if (!Check(resolved.definition.parameters, prepared)) throw new Error(`Invalid arguments for tool: ${name}`);

    // Reservation below is synchronous up to the first await (at `return await
    // operation`), so concurrent invoke() calls in one tick observe each
    // other's increments: no two calls can both pass the parallel check.
    const state = this.state(id);
    if (state.calls >= MAX_CALLS) throw new Error(`Bridge call limit exceeded for execution: ${id}`);
    if (state.running >= MAX_PARALLEL || state.exclusive || (!resolved.capabilities.parallel && state.running > 0)) {
      throw new Error(`Bridge parallel limit exceeded for execution: ${id}`);
    }

    state.calls++;
    state.running++;
    state.exclusive = !resolved.capabilities.parallel;
    const operation = this.run(name, prepared, execution, resolved.provider, state);
    state.pending.add(operation);
    void operation.then(
      () => this.finished(id, state, operation),
      () => this.finished(id, state, operation),
    );
    return await operation;
  }

  openExecution(executionId: string): void {
    const state = this.states.get(executionId);
    if (state?.pending.size) throw new Error(`Bridge execution still has pending calls: ${executionId}`);
    this.states.delete(executionId);
    this.closed.delete(executionId);
  }

  closeExecution(executionId: string): void {
    this.closed.add(executionId);
    const state = this.states.get(executionId);
    if (state && state.pending.size === 0) this.states.delete(executionId);
  }

  settle(executionId: string, timeoutMs?: number): Promise<boolean> {
    const state = this.states.get(executionId);
    if (!state?.pending.size) return Promise.resolve(true);

    let timer: ReturnType<typeof setTimeout> | undefined;
    return new Promise<boolean>((resolve) => {
      const done = () => {
        if (timer) clearTimeout(timer);
        state.waiters.delete(done);
        resolve(true);
      };
      state.waiters.add(done);
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          state.waiters.delete(done);
          resolve(false);
        }, Math.max(0, timeoutMs));
      }
    });
  }

  private resolve(name: string, mode: Mode): ResolvedTool {
    const provider = this.provider;
    if (!provider) throw new Error("Bridge tool provider is unavailable");
    if (!this.active().includes(name)) throw new Error(`Bridge tool is inactive: ${name}`);
    if (!this.discover().some((tool) => tool.name === name) || !provider.list().some((tool) => tool.name === name)) {
      throw new Error(`Bridge tool is unavailable: ${name}`);
    }
    const resolved = provider.resolve(name);
    if (!resolved || resolved.definition.name !== name) throw new Error(`Bridge tool is unavailable: ${name}`);
    if (!allowed(name, mode, resolved.capabilities)) throw new Error(`Bridge tool is not allowed: ${name}`);
    return { provider, ...resolved };
  }

  private async run(
    name: string,
    preparedArgs: unknown,
    execution: BridgeExecution,
    provider: ToolProvider,
    state: ExecutionState,
  ): Promise<unknown> {
    const context: NestedContext = {
      ...execution.identity,
      cwd: execution.context.cwd,
      toolCallId: `bridge:${execution.identity.executionId}:${state.calls}`,
      signal: execution.signal,
      context: execution.context,
      onUpdate: execution.onUpdate,
    };

    await provider.preflight(name, preparedArgs, context);
    if (execution.signal.aborted) throw new Error(`Bridge execution is aborted: ${execution.identity.executionId}`);
    if (provider !== this.provider) throw new Error("Bridge tool provider changed during preflight");

    const current = this.resolve(name, execution.identity.mode);
    if (current.provider !== provider) throw new Error("Bridge tool provider changed during preflight");
    if (!Check(current.definition.parameters, preparedArgs)) throw new Error(`Invalid arguments for tool: ${name}`);
    if (!current.capabilities.parallel) {
      if (state.running > 1) throw new Error(`Bridge tool became non-parallel during preflight: ${name}`);
      state.exclusive = true;
    }
    return provider.invoke(name, preparedArgs, context);
  }

  private state(executionId: string): ExecutionState {
    let state = this.states.get(executionId);
    if (!state) {
      state = { calls: 0, running: 0, exclusive: false, pending: new Set(), waiters: new Set() };
      this.states.set(executionId, state);
    }
    return state;
  }

  private finished(executionId: string, state: ExecutionState, operation: Promise<unknown>): void {
    state.pending.delete(operation);
    state.running--;
    if (state.running === 0) state.exclusive = false;
    if (state.pending.size !== 0) return;
    for (const waiter of state.waiters) waiter();
    state.waiters.clear();
    if (this.closed.has(executionId)) this.states.delete(executionId);
  }
}

function prepare(definition: ToolDefinition, args: unknown): unknown {
  return definition.prepareArguments ? definition.prepareArguments(args) : args;
}

function allowed(name: string, mode: Mode, capabilities: ToolCapabilities): boolean {
  return name !== OWN_TOOL && capabilities[mode] && capabilities.nested && capabilities.cancellable && !capabilities.interactive;
}
