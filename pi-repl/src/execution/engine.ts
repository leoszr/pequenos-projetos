import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ExecutionIdentity, KernelOutput } from "../kernel/backend.ts";
export type ExecutionState = "created" | "queued" | "running" | "yielded" | "completed" | "failed" | "cancelled" | "terminated" | "stale";
export interface ExecutionRequest { code: string; context: ExtensionContext }
export interface ExecutionResult extends ExecutionIdentity {
  state: ExecutionState; cleanup: "pending" | "completed";
  outputs: KernelOutput[]; value?: unknown; error?: string;
  startedAt: string; durationMs: number; dirty?: boolean;
}
export interface ReplExecutionEngine {
  execute(request: ExecutionRequest, signal?: AbortSignal): Promise<ExecutionResult>;
  interrupt(executionId: string): Promise<void>;
  terminate(executionId: string): Promise<void>;
  diagnostics(executionId?: string): unknown;
  shutdown(): Promise<void>;
}
export function identityOf(value: ExecutionIdentity): ExecutionIdentity {
  return { sessionId: value.sessionId, generation: value.generation, executionId: value.executionId, mode: value.mode, ...(value.cellId ? { cellId: value.cellId } : {}) };
}
export function isTerminal(state: ExecutionState): boolean {
  return !["created", "queued", "running", "yielded"].includes(state);
}
export async function boundedWait<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: number | undefined;
  try { return await Promise.race([promise, new Promise<undefined>(resolve => { timer = setTimeout(resolve, ms); })]); }
  finally { if (timer) clearTimeout(timer); }
}
