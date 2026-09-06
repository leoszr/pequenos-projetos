export type Mode = "code" | "notebook";
export type KernelState = "not_started" | "starting" | "available" | "executing" | "interrupting" | "busy_after_interrupt" | "restarting" | "closing" | "closed" | "dead" | "incompatible";
export interface ExecutionIdentity { sessionId: string; executionId: string; cellId?: string; mode: Mode; generation: string }
export interface KernelOutput {
  kind: "stdout" | "stderr" | "display" | "result" | "error" | "notification";
  text?: string;
  data?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  origin?: ExecutionIdentity;
  attribution: "execution" | "background" | "unattributed";
}
export interface KernelResult { status: "ok" | "error" | "cancelled"; error?: string; outputs: KernelOutput[] }
export interface KernelBackend {
  readonly generation: string;
  readonly state: KernelState;
  start(signal?: AbortSignal): Promise<void>;
  execute(code: string, identity: ExecutionIdentity, signal?: AbortSignal): Promise<KernelResult>;
  interrupt(): Promise<void>;
  shutdown(): Promise<void>;
  diagnostics(): Record<string, unknown>;
}
export interface KernelOptions {
  cwd: string; mode: Mode; sessionId: string; deno?: string; maxHeapMiB?: number;
  startupTimeoutMs?: number; interruptGraceMs?: number; shutdownGraceMs?: number;
  maxOutputBytes?: number; maxMessageBytes?: number;
  onOutput?: (output: KernelOutput) => void;
}
