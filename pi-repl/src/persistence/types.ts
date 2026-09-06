import type { DeclarationKind } from "../execution/source.ts";
import type { ExecutionIdentity } from "../kernel/backend.ts";
export interface BindingSnapshot { name: string; declaration: DeclarationKind; status: "saved" | "excluded"; value?: unknown; reason?: string }
export interface PromoteIntent { version: 1; sessionId: string; expectedGeneration: number; createdAt: string }
export interface Snapshot {
  version: 1; mode: "notebook"; sessionId: string; generation: string;
  runtime: { name: "deno"; version: string }; createdAt: string;
  bindings: BindingSnapshot[]; pins: string[];
}
export interface SessionState { version: 1; sessionId: string; revision: number; projectGeneration: number; snapshot: Snapshot }
export interface JournalOutput {
  kind: string;
  text?: string;
  data?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  origin?: ExecutionIdentity;
  attribution?: "execution" | "background" | "unattributed";
}
export interface JournalEntry {
  executionId: string; cellId: string; generation: string; mode: "notebook";
  source: string; startedAt: string; durationMs: number; status: string;
  outputs: JournalOutput[];
  error?: string;
}
