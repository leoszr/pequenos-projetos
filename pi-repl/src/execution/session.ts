import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BridgeServer } from "../bridge/server.ts";
import type { ToolRegistry } from "../bridge/registry.ts";
import type { ExecutionIdentity, KernelBackend, KernelOutput, KernelResult, Mode } from "../kernel/backend.ts";
import type { Limits } from "../config.ts";
import { bootstrap, enter } from "./bootstrap.ts";
export interface RuntimeServices {
  limits: Limits; bridge: BridgeServer; registry: ToolRegistry;
  kernel(mode: Mode, onOutput?: (output: KernelOutput) => void): KernelBackend;
  sessionId: string; cwd: string;
}
export class KernelSession {
  readonly kernel: KernelBackend;
  private starting?: Promise<void>;
  constructor(readonly services: RuntimeServices, private readonly mode: Mode, onOutput?: (output: KernelOutput) => void) {
    this.kernel = services.kernel(mode, onOutput);
  }
  start(signal?: AbortSignal): Promise<void> {
    return this.starting ??= this.initialize(signal);
  }
  private async initialize(signal?: AbortSignal): Promise<void> {
    const endpoint = await this.services.bridge.start();
    await this.kernel.start(signal);
    const identity = this.identity(this.mode, `internal:${randomUUID()}`);
    const result = await this.kernel.execute(bootstrap(endpoint.url, endpoint.token, this.services.limits.responseBytes), identity, signal);
    if (result.status !== "ok") throw new Error(`Bootstrap failed: ${result.error}`);
  }
  identity(mode: Mode, executionId = randomUUID(), cellId?: string): ExecutionIdentity {
    return { sessionId: this.services.sessionId, generation: this.kernel.generation, mode, executionId, ...(cellId ? { cellId } : {}) };
  }
  async run(source: string, identity: ExecutionIdentity, context: ExtensionContext, signal: AbortSignal, onUpdate: (value: unknown) => void): Promise<KernelResult> {
    await this.start(signal);
    signal.throwIfAborted();
    this.services.bridge.open({ identity, context, signal, onUpdate });
    try {
      const hello = await this.kernel.execute(`${enter(identity)}await __repl.call("hello");`, this.identity(identity.mode), signal);
      if (hello.status !== "ok") throw new Error(`Bridge handshake failed: ${hello.error}`);
      // enterWith occurs in the user evaluation, preserving lexical REPL scope.
      return await this.kernel.execute(`${enter(identity)}${source}`, identity, signal);
    } finally { this.services.bridge.closeExecution(identity.executionId); }
  }
  async internal(source: string, signal?: AbortSignal): Promise<KernelResult> {
    await this.start(signal);
    const result = await this.kernel.execute(source, this.identity(this.mode, `internal:${randomUUID()}`), signal);
    if (result.status !== "ok") throw new Error(result.error ?? "Internal kernel operation failed");
    return result;
  }
  async close(): Promise<void> { await this.kernel.shutdown(); }
}
