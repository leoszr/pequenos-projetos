import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type TSchema } from "typebox";
import { Check, Errors } from "typebox/value";

export const REPL_ACTIONS = [
  "exec",
  "wait",
  "interrupt",
  "terminate",
  "status",
  "diagnostics",
  "bindings",
  "snapshot",
  "checkpoint",
  "restart",
  "reset",
  "pin",
  "unpin",
  "release",
  "prune",
  "profile",
  "project",
  "journal",
  "tools",
] as const;

const OPERATIONS = ["save", "list", "load", "status", "promote", "rollback", "export", "dry_run", "apply", "dry-run"] as const;

export const replRequestSchema: TSchema = Type.Object({
  mode: StringEnum(["code", "notebook"] as const, { description: "Isolated code or persistent notebook runtime" }),
  action: StringEnum(REPL_ACTIONS, { description: "Operation to perform" }),
  code: Type.Optional(Type.String({ description: "TypeScript source" })),
  "yield-time_ms": Type.Optional(Type.Integer({ minimum: 0, maximum: 30_000 })),
  execution_id: Type.Optional(Type.String({ minLength: 1 })),
  cursor: Type.Optional(Type.Integer({ minimum: 0 })),
  scope: Type.Optional(StringEnum(["session", "bindings"] as const)),
  names: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 512 }), {
    minItems: 1,
    maxItems: 512,
    uniqueItems: true,
  })),
  operation: Type.Optional(StringEnum(OPERATIONS)),
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  expected_generation: Type.Optional(Type.Integer({ minimum: 0 })),
  target_generation: Type.Optional(Type.Integer({ minimum: 1 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000 })),
  dry_run: Type.Optional(Type.Boolean({ description: "Preview candidates without applying changes (default true)" })),
}, { additionalProperties: false });

export type ReplAction = (typeof REPL_ACTIONS)[number];
export interface ReplRequest {
  mode: "code" | "notebook";
  action: ReplAction;
  code?: string;
  "yield-time_ms"?: number;
  execution_id?: string;
  cursor?: number;
  scope?: "session" | "bindings";
  names?: string[];
  operation?: string;
  name?: string;
  expected_generation?: number;
  target_generation?: number;
  limit?: number;
  dry_run?: boolean;
}

const BASE = ["mode", "action"] as const;
const fields = {
  exec: ["code", "yield-time_ms"],
  wait: ["execution_id", "yield-time_ms", "cursor"],
  interrupt: ["execution_id"],
  terminate: ["execution_id"],
  status: ["execution_id"],
  diagnostics: ["execution_id"],
  bindings: [],
  snapshot: [],
  checkpoint: [],
  restart: [],
  reset: ["scope"],
  pin: ["names"],
  unpin: ["names"],
  release: ["names", "scope"],
  prune: ["names", "scope", "dry_run", "operation"],
  profile: ["operation", "name"],
  project: ["operation", "expected_generation", "target_generation"],
  journal: ["operation", "cursor", "limit"],
  tools: [],
} satisfies Record<(typeof REPL_ACTIONS)[number], readonly string[]>;

export function validateReplRequest(value: unknown): ReplRequest {
  if (!Check(replRequestSchema, value)) {
    const first = Errors(replRequestSchema, value)[0];
    const location = first?.instancePath || "request";
    throw new Error(`Invalid repl_notebook request at ${location}: ${first?.message ?? "schema mismatch"}`);
  }

  const request = value as ReplRequest;
  const allowed = new Set<string>([...BASE, ...fields[request.action]]);
  const unsupported = Object.keys(request).filter((key) => !allowed.has(key));
  if (unsupported.length) throw new Error(`Unsupported field for ${request.action}: ${unsupported.join(", ")}`);

  if (request.mode === "code" && !["exec", "wait", "interrupt", "terminate", "status", "diagnostics", "tools"].includes(request.action)) {
    throw new Error(`Action ${request.action} requires mode=notebook`);
  }

  switch (request.action) {
    case "exec":
      requireField(request, "code");
      break;
    case "wait":
    case "interrupt":
    case "terminate":
      requireField(request, "execution_id");
      break;
    case "reset":
      if (request.scope !== "session") throw new Error("reset requires scope=session");
      break;
    case "pin":
    case "unpin":
      requireNames(request);
      break;
    case "release":
      requireNames(request);
      if (request.scope !== "bindings") throw new Error("release requires scope=bindings");
      break;
    case "prune":
      requireNames(request);
      if (request.scope !== "bindings") throw new Error("prune requires scope=bindings");
      if (request.operation !== undefined && !["dry_run", "apply", "dry-run"].includes(request.operation)) {
        throw new Error("prune requires operation=dry_run|apply when operation is provided");
      }
      if (request.dry_run !== undefined && request.operation !== undefined) {
        const opDryRun = request.operation !== "apply";
        if (request.dry_run !== opDryRun) {
          throw new Error("prune received conflicting parameters: dry_run and operation disagree");
        }
      }
      break;
    case "profile":
      if (!request.operation || !["save", "list", "load"].includes(request.operation)) {
        throw new Error("profile requires operation=save|list|load");
      }
      if (request.operation === "list") {
        if (request.name !== undefined) throw new Error("profile operation=list does not accept name");
      } else {
        requireField(request, "name");
      }
      break;
    case "project":
      if (!request.operation || !["status", "promote", "rollback"].includes(request.operation)) {
        throw new Error("project requires operation=status|promote|rollback");
      }
      if (request.operation === "status") {
        rejectDefined(request, "expected_generation", "target_generation");
      } else {
        requireField(request, "expected_generation");
        if (request.operation === "rollback") requireField(request, "target_generation");
        else rejectDefined(request, "target_generation");
      }
      break;
    case "journal":
      if (!request.operation || !["list", "export"].includes(request.operation)) {
        throw new Error("journal requires operation=list|export");
      }
      if (request.operation === "export") rejectDefined(request, "cursor", "limit");
      break;
  }

  return request;
}

function requireNames(request: ReplRequest): void {
  if (!request.names?.length) throw new Error(`${request.action} requires non-empty names`);
}

function requireField(request: ReplRequest, field: keyof ReplRequest): void {
  if (request[field] === undefined) throw new Error(`${request.action} requires ${String(field)}`);
}

function rejectDefined(request: ReplRequest, ...names: Array<keyof ReplRequest>): void {
  const found = names.filter((name) => request[name] !== undefined);
  if (found.length) throw new Error(`${request.action} operation=${request.operation} does not accept ${found.join(", ")}`);
}
