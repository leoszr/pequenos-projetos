import type { ExtensionContext, ToolDefinition, ToolInfo } from "@earendil-works/pi-coding-agent";
import type { ExecutionIdentity } from "../kernel/backend.ts";
export interface ToolCapabilities {
  code: boolean; notebook: boolean; interactive: boolean; approval: boolean;
  parallel: boolean; cancellable: boolean; nested: boolean;
}
export interface NestedContext extends ExecutionIdentity {
  cwd: string; toolCallId: string; signal: AbortSignal; context: ExtensionContext;
  onUpdate: (value: unknown) => void;
}
/** Host must explicitly supply preflight; raw execute bypasses Pi event middleware. */
export interface ToolProvider {
  list(): ToolInfo[];
  resolve(name: string): { definition: ToolDefinition; capabilities: ToolCapabilities } | undefined;
  preflight(name: string, args: unknown, context: NestedContext): Promise<void>;
  invoke(name: string, args: unknown, context: NestedContext): Promise<unknown>;
}
export interface BridgeExecution { identity: ExecutionIdentity; context: ExtensionContext; signal: AbortSignal; onUpdate: (value: unknown) => void }
