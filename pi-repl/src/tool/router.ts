import type { AgentToolResult, ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { Limits } from "../config.ts";
import type { ExecutionResult } from "../execution/engine.ts";
import type { Mode } from "../kernel/backend.ts";
import type { NotebookRuntime } from "../notebook-mode/runtime.ts";
import { validateReplRequest, type ReplRequest } from "./request.ts";

export interface ExecutionSupervisor {
  readonly notebook: Pick<NotebookRuntime,
    "checkpoint" | "snapshot" | "restart" | "reset" | "pin" | "release" | "prune" | "profile" |
    "promote" | "rollback" | "status" | "diagnostics" | "store">;
  start(mode: Mode, code: string, context: ExtensionContext, signal?: AbortSignal, yieldMs?: number): Promise<ExecutionResult>;
  wait(mode: Mode, executionId: string, ms?: number, signal?: AbortSignal): Promise<ExecutionResult>;
  interrupt(mode: Mode, executionId: string, terminate?: boolean): Promise<ExecutionResult>;
  administer<T>(operation: () => Promise<T>): Promise<T>;
  status(): unknown;
  shutdown(): Promise<void>;
}

export interface ReplRouterOptions {
  limits: Limits;
  sessionId: string;
  cwd: string;
  createManager: () => ExecutionSupervisor;
  listTools: (mode: Mode) => ToolInfo[];
  integrationStatus?: () => unknown;
}

export class ReplRouter {
  private manager?: ExecutionSupervisor;
  private enabled = true;

  constructor(private readonly options: ReplRouterOptions) {}

  async route(value: unknown, context: ExtensionContext, signal?: AbortSignal): Promise<AgentToolResult<unknown>> {
    const request = validateReplRequest(value);
    if (!this.enabled && !["status", "diagnostics", "tools"].includes(request.action)) {
      throw new Error("repl_notebook is disabled; run /repl enable first");
    }

    switch (request.action) {
      case "exec":
        return this.execution(await this.getManager().start(
          request.mode,
          request.code!,
          context,
          signal,
          request["yield-time_ms"],
        ), request.cursor ?? 0);
      case "wait":
        return this.execution(await this.getManager().wait(
          request.mode,
          request.execution_id!,
          request["yield-time_ms"],
          signal,
        ), request.cursor ?? 0);
      case "interrupt":
      case "terminate":
        return this.execution(await this.getManager().interrupt(
          request.mode,
          request.execution_id!,
          request.action === "terminate",
        ), 0);
      case "status":
        return this.value(request, this.executionStatus(request.execution_id));
      case "diagnostics":
        return this.value(request, this.diagnostics(request));
      case "tools":
        return this.value(request, {
          mode: request.mode,
          tools: this.options.listTools(request.mode),
          integration: this.options.integrationStatus?.(),
        });
      case "bindings":
        return this.value(request, this.getManager().notebook.status());
      case "snapshot":
        return this.value(request, await this.administer((notebook) => notebook.snapshot()));
      case "checkpoint":
        return this.value(request, await this.administer((notebook) => notebook.checkpoint()));
      case "restart":
        return this.value(request, await this.administer((notebook) => notebook.restart()));
      case "reset":
        return this.value(request, await this.administer((notebook) => notebook.reset(request.scope!)));
      case "pin":
      case "unpin":
        return this.value(request, await this.administer((notebook) => notebook.pin(request.names!, request.action === "pin")));
      case "release":
        return this.value(request, await this.administer((notebook) => notebook.release(request.names!, request.scope!)));
      case "prune": {
        const dryRun = resolvePruneDryRun(request);
        return this.value(request, await this.administer((notebook) => notebook.prune(request.names!, request.scope!, dryRun)));
      }
      case "profile":
        return this.value(request, await this.administer((notebook) => notebook.profile(
          request.operation as "save" | "list" | "load",
          request.name,
        )));
      case "project":
        return this.value(request, await this.project(request));
      case "journal":
        return this.value(request, await this.journal(request));
    }
  }

  enable(): void {
    this.enabled = true;
  }

  async disable(): Promise<void> {
    this.enabled = false;
    if (!this.manager) return;
    await this.manager.shutdown();
    this.manager = undefined;
  }

  async shutdown(): Promise<void> {
    this.enabled = false;
    if (!this.manager) return;
    await this.manager.shutdown();
    this.manager = undefined;
  }

  status(): unknown {
    return {
      enabled: this.enabled,
      initialized: this.manager !== undefined,
      sessionId: this.options.sessionId,
      cwd: this.options.cwd,
      integration: this.options.integrationStatus?.(),
      runtime: this.manager?.status(),
    };
  }

  policies(): unknown {
    return {
      code: { persistent: false, concurrent: this.options.limits.concurrentCode },
      notebook: { persistent: true, concurrent: 1 },
      nested: {
        maxCalls: this.options.limits.nestedCalls,
        maxParallel: this.options.limits.nestedParallel,
        maxDepth: this.options.limits.nestedDepth,
        interactive: false,
        provider: this.options.integrationStatus?.(),
      },
      sandbox: false,
    };
  }

  limits(): Limits {
    return { ...this.options.limits };
  }

  private getManager(): ExecutionSupervisor {
    if (!this.enabled) throw new Error("repl_notebook is disabled");
    return this.manager ??= this.options.createManager();
  }

  private executionStatus(executionId?: string): unknown {
    if (!this.manager) {
      if (executionId) throw new Error("Unknown execution for this session/mode (possibly expired)");
      return this.status();
    }
    const status = this.manager.status() as { executions?: Array<{ executionId?: string }> };
    if (!executionId) return status;
    const execution = status.executions?.find((candidate) => candidate.executionId === executionId);
    if (!execution) throw new Error("Unknown execution for this session/mode (possibly expired)");
    return execution;
  }

  private diagnostics(request: ReplRequest): unknown {
    if (!this.manager) {
      if (request.execution_id) throw new Error("Unknown execution for this session/mode (possibly expired)");
      return this.status();
    }
    if (request.execution_id) return this.executionStatus(request.execution_id);
    return request.mode === "notebook"
      ? { manager: this.manager.status(), notebook: this.manager.notebook.diagnostics() }
      : this.manager.status();
  }

  private administer<T>(operation: (notebook: ExecutionSupervisor["notebook"]) => Promise<T>): Promise<T> {
    const manager = this.getManager();
    return manager.administer(() => operation(manager.notebook));
  }

  private project(request: ReplRequest): Promise<unknown> {
    const manager = this.getManager();
    if (request.operation === "status") return manager.notebook.store.project();
    return manager.administer(async () => {
      const current = await manager.notebook.store.project();
      if (current.generation !== request.expected_generation) {
        throw new Error(`Project generation conflict: expected ${request.expected_generation}, actual ${current.generation}`);
      }
      return request.operation === "promote"
        ? manager.notebook.promote()
        : manager.notebook.rollback(request.target_generation!);
    });
  }

  private async journal(request: ReplRequest): Promise<unknown> {
    const store = this.getManager().notebook.store;
    if (request.operation === "export") return store.exportNotebook();
    const entries = await store.journal();
    const cursor = request.cursor ?? 0;
    const limit = request.limit ?? 100;
    const page = entries.slice(cursor, cursor + limit);
    const nextCursor = cursor + page.length;
    return {
      entries: page,
      cursor,
      next_cursor: nextCursor < entries.length ? nextCursor : undefined,
      total: entries.length,
    };
  }

  private execution(result: ExecutionResult, cursor: number): AgentToolResult<unknown> {
    if (cursor > result.outputs.length) throw new Error(`Output cursor ${cursor} exceeds ${result.outputs.length}`);
    const selected = result.outputs.slice(cursor);
    const content = outputContent(selected, this.options.limits);
    const nextCursor = result.outputs.length;
    const details = {
      execution: {
        sessionId: result.sessionId,
        executionId: result.executionId,
        cellId: result.cellId,
        generation: result.generation,
        mode: result.mode,
        state: result.state,
        cleanup: result.cleanup,
        startedAt: result.startedAt,
        durationMs: result.durationMs,
        dirty: result.dirty,
        error: result.error,
        value: boundedValue(result.value, 64 * 1024),
      },
      cursor,
      next_cursor: nextCursor,
      total_outputs: result.outputs.length,
      outputs: selected.map(outputDetails),
    };
    const response = fitResult({
      content: content.length ? content : [{ type: "text", text: executionSummary(result) }],
      details,
    }, this.options.limits.responseBytes);
    if (result.state === "failed") {
      throw new Error(`Execution ${result.executionId} failed: ${result.error ?? "unknown error"}`);
    }
    return response;
  }

  private value(request: ReplRequest, value: unknown): AgentToolResult<unknown> {
    const encoded = safeStringify(value, 2);
    const text = truncateUtf8(encoded.text, Math.max(256, Math.min(this.options.limits.outputBytes, this.options.limits.responseBytes / 2)));
    return fitResult({
      content: [{ type: "text", text: text.value }],
      details: {
        mode: request.mode,
        action: request.action,
        value: boundedValue(value, Math.max(1_024, Math.min(128 * 1024, this.options.limits.responseBytes / 4))),
        truncated: encoded.truncated || text.truncated,
      },
    }, this.options.limits.responseBytes);
  }
}

type Content = TextContent | ImageContent;

function outputContent(outputs: ExecutionResult["outputs"], limits: Limits): Content[] {
  const content: Content[] = [];
  const budget = Math.max(1_024, limits.responseBytes - Math.min(96 * 1024, Math.floor(limits.responseBytes / 4)));
  let bytes = 0;
  let truncated = false;

  const add = (block: Content): void => {
    const size = Buffer.byteLength(JSON.stringify(block));
    if (bytes + size > budget) {
      truncated = true;
      return;
    }
    content.push(block);
    bytes += size;
  };
  const addText = (text: string): void => {
    const remaining = budget - bytes - 64;
    if (remaining <= 0) {
      truncated = true;
      return;
    }
    const bounded = truncateUtf8(text, remaining);
    add({ type: "text", text: bounded.value });
    truncated ||= bounded.truncated;
  };

  for (const output of outputs) {
    if (output.text) addText(output.text);
    const data = output.data;
    if (!data) continue;
    if (!output.text) {
      const text = ["text/plain", "text/markdown", "text/html"].find((mime) => typeof data[mime] === "string");
      if (text) addText(String(data[text]));
      else if (Object.hasOwn(data, "application/json")) addText(safeStringify(data["application/json"], 2).text);
    }
    for (const mimeType of ["image/png", "image/jpeg", "image/webp", "image/gif"] as const) {
      const raw = data[mimeType];
      if (typeof raw !== "string") continue;
      const base64 = raw.replace(/^data:[^,]+,/, "");
      if (Buffer.from(base64, "base64").byteLength > limits.attachmentBytes) {
        truncated = true;
        continue;
      }
      add({ type: "image", data: base64, mimeType });
    }
  }
  if (truncated) addText("[Output truncated by repl_notebook response limits]");
  return content;
}

function outputDetails(output: ExecutionResult["outputs"][number]): unknown {
  return {
    kind: output.kind,
    attribution: output.attribution,
    origin: output.origin,
    mime_types: output.data ? Object.keys(output.data) : [],
    metadata: boundedValue(output.metadata, 16 * 1024),
  };
}

function executionSummary(result: ExecutionResult): string {
  const id = result.cellId ? `${result.executionId} (cell ${result.cellId})` : result.executionId;
  return `${result.mode} execution ${id}: ${result.state}; cleanup=${result.cleanup}`;
}

function boundedValue(value: unknown, maxBytes: number): unknown {
  if (value === undefined) return undefined;
  const encoded = safeStringify(value);
  if (!encoded.truncated && Buffer.byteLength(encoded.text) <= maxBytes) {
    try {
      return JSON.parse(encoded.text);
    } catch {
      return String(value);
    }
  }
  return { truncated: true, bytes: Buffer.byteLength(encoded.text), preview: truncateUtf8(encoded.text, maxBytes).value };
}

function safeStringify(value: unknown, space?: number): { text: string; truncated: boolean } {
  try {
    const text = JSON.stringify(value, jsonReplacer, space);
    return { text: text === undefined ? "null" : text, truncated: false };
  } catch (error) {
    return { text: JSON.stringify({ serialization_error: String(error) }), truncated: true };
  }
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
  if (typeof value === "symbol") return String(value);
  return value;
}

function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const buffer = Buffer.from(value);
  if (buffer.byteLength <= maxBytes) return { value, truncated: false };
  const suffix = "\n[truncated]";
  const prefix = new TextDecoder().decode(buffer.subarray(0, Math.max(0, maxBytes - Buffer.byteLength(suffix))), { stream: true });
  return { value: prefix + suffix, truncated: true };
}

function resolvePruneDryRun(request: ReplRequest): boolean {
  if (request.dry_run !== undefined) return request.dry_run;
  if (request.operation !== undefined) return request.operation !== "apply";
  return true;
}

function fitResult(result: AgentToolResult<unknown>, maxBytes: number): AgentToolResult<unknown> {
  if (Buffer.byteLength(JSON.stringify(result)) <= maxBytes) return result;
  const compact: AgentToolResult<unknown> = {
    content: [...result.content],
    details: { truncated: true, reason: "repl_notebook response byte limit" },
  };
  while (compact.content.length > 1 && Buffer.byteLength(JSON.stringify(compact)) > maxBytes) compact.content.pop();
  if (Buffer.byteLength(JSON.stringify(compact)) <= maxBytes) return compact;
  return {
    content: [{ type: "text", text: "repl_notebook response exceeded the configured byte limit" }],
    details: { truncated: true },
  };
}
