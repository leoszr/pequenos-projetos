import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BridgeServer } from "./bridge/server.ts";
import { ToolRegistry } from "./bridge/registry.ts";
import type { ToolProvider } from "./bridge/types.ts";
import { configureLimits, type Limits } from "./config.ts";
import { ExecutionManager } from "./execution/manager.ts";
import { JupyterKernelBackend } from "./kernel/jupyter.ts";
import { replRequestSchema } from "./tool/request.ts";
import { ReplRouter, type ExecutionSupervisor } from "./tool/router.ts";

export const TOOL_NAME = "repl_notebook";
export const PROVIDER_EVENT = "pi-repl-notebook:provider";

export interface CooperativeProviderRequest {
  accept(provider: ToolProvider): void;
}

export interface ManagerFactoryOptions {
  context: ExtensionContext;
  cwd: string;
  sessionId: string;
  root: string;
  limits: Limits;
  registry: ToolRegistry;
  bridge: BridgeServer;
}

export interface ExtensionDependencies {
  createManager?: (options: ManagerFactoryOptions) => ExecutionSupervisor;
  limits?: Partial<Limits>;
  stateRoot?: (cwd: string) => string;
}

type ProviderState = "not_requested" | "available" | "unavailable" | "conflict";

interface ActiveSession {
  router: ReplRouter;
  collision?: string;
}

export function createExtension(dependencies: ExtensionDependencies = {}) {
  const configuredLimits = configureLimits(dependencies.limits);
  const createManager = dependencies.createManager ?? defaultManager;

  return function replNotebookExtension(pi: ExtensionAPI): void {
    let active: ActiveSession | undefined;
    let registered = false;

    pi.on("session_start", async (_event, context) => {
      const previous = active;
      active = undefined;
      if (previous) await close(previous, context, "previous session");

      const sessionId = context.sessionManager.getSessionId();
      const cwd = context.cwd;
      const root = (dependencies.stateRoot ?? projectStateRoot)(cwd);
      let providerState: ProviderState = "not_requested";
      let registry: ToolRegistry | undefined;
      let bridge: BridgeServer | undefined;

      const integrationStatus = () => ({
        cooperativeProvider: providerState,
        event: PROVIDER_EVENT,
        rawBuiltinFallback: false,
      });

      const getRegistry = (): ToolRegistry => {
        if (registry) return registry;
        let accepted: ToolProvider | undefined;
        let conflict = false;
        let accepting = true;
        const request: CooperativeProviderRequest = {
          accept(provider) {
            if (!accepting) throw new Error(`${PROVIDER_EVENT} accept(provider) must run synchronously`);
            if (accepted && accepted !== provider) conflict = true;
            else accepted = provider;
          },
        };
        pi.events.emit(PROVIDER_EVENT, request);
        accepting = false;
        providerState = conflict ? "conflict" : accepted ? "available" : "unavailable";
        registry = new ToolRegistry(() => pi.getAllTools(), () => pi.getActiveTools(), conflict ? undefined : accepted);
        return registry;
      };

      const router = new ReplRouter({
        limits: configuredLimits,
        sessionId,
        cwd,
        integrationStatus,
        listTools: (mode) => getRegistry().list(mode),
        createManager: () => {
          const toolRegistry = getRegistry();
          bridge ??= new BridgeServer(toolRegistry, configuredLimits.responseBytes);
          return createManager({ context, cwd, sessionId, root, limits: configuredLimits, registry: toolRegistry, bridge });
        },
      });
      const session: ActiveSession = { router };
      active = session;

      if (!registered) {
        const collision = pi.getAllTools().find((tool) => tool.name === TOOL_NAME);
        if (collision) {
          session.collision = `Tool ${TOOL_NAME} is already registered by ${collision.sourceInfo.path}`;
          await router.disable();
          context.ui.notify(`${session.collision}; pi-repl-notebook stays disabled.`, "warning");
          return;
        }
        pi.registerTool({
          name: TOOL_NAME,
          label: "REPL Notebook",
          description: "Run isolated TypeScript code or persistent Notebook cells; wait, interrupt, inspect bindings, and administer explicit Notebook state. The runtime is not a sandbox.",
          promptSnippet: "Run composed TypeScript in isolated Code Mode or persistent Notebook Mode",
          promptGuidelines: [
            "Use repl_notebook for composed TypeScript computation; keep direct Pi tools and user interactions outside the runtime.",
            "Use repl_notebook mode=notebook only for persistent bindings; use mode=code for isolated work, and wait on yielded executions.",
            "Use repl_notebook action=tools before tools.*; only cooperatively authorized, non-interactive tools are available.",
          ],
          parameters: replRequestSchema,
          execute(_toolCallId, request, signal, _onUpdate, executionContext) {
            const current = active;
            if (!current) throw new Error("repl_notebook has no active Pi session");
            if (current.collision) throw new Error(current.collision);
            return current.router.route(request, executionContext, signal);
          },
        });
        registered = true;
      }
    });

    pi.on("session_shutdown", async (_event, context) => {
      const current = active;
      active = undefined;
      if (current) await close(current, context, "session shutdown");
    });

    pi.registerCommand("repl", {
      description: "Administer pi-repl-notebook or run a JSON repl_notebook request",
      handler: async (args, context) => {
        try {
          const current = active;
          if (!current) throw new Error("No active repl_notebook session");
          const run = async (request: unknown): Promise<void> => {
            if (current.collision) throw new Error(current.collision);
            const result = await current.router.route(request, context);
            report(context, {
              content: result.content.map((item) => item.type === "text" ? item.text : `[${item.mimeType} image]`),
              details: result.details,
            });
          };
          const input = args.trim();
          const operation = input || "status";

          if (operation === "status") {
            report(context, { ...asRecord(current.router.status()), collision: current.collision });
            return;
          }
          if (operation === "policies") {
            report(context, current.router.policies());
            return;
          }
          if (operation === "limits") {
            report(context, current.router.limits());
            return;
          }
          if (operation === "enable") {
            if (current.collision) throw new Error(current.collision);
            current.router.enable();
            report(context, current.router.status());
            return;
          }
          if (operation === "disable") {
            await current.router.disable();
            report(context, current.router.status());
            return;
          }
          if (operation.startsWith("{")) {
            await run(JSON.parse(operation));
            return;
          }
          const [command, ...rest] = operation.split(/\s+/);
          switch (command) {
            case "restart":
              requireNoArgs(command, rest);
              await run({ mode: "notebook", action: "restart" });
              return;
            case "checkpoint":
              requireNoArgs(command, rest);
              await run({ mode: "notebook", action: "checkpoint" });
              return;
            case "reset":
              requireNoArgs(command, rest);
              await run({ mode: "notebook", action: "reset", scope: "session" });
              return;
            case "terminate": {
              const [executionId, mode = "notebook"] = rest;
              if (!executionId || rest.length > 2 || (mode !== "notebook" && mode !== "code")) {
                throw new Error("Usage: /repl terminate <execution_id> [notebook|code]");
              }
              await run({ mode, action: "terminate", execution_id: executionId });
              return;
            }
            case "profile":
            case "profiles": {
              const [profileOperation = "list", ...nameParts] = rest;
              if (profileOperation === "list") {
                requireNoArgs(`${command} list`, nameParts);
                await run({ mode: "notebook", action: "profile", operation: "list" });
                return;
              }
              if (profileOperation === "save" || profileOperation === "load") {
                const name = nameParts.join(" ").trim();
                if (!name) throw new Error(`Usage: /repl ${command} ${profileOperation} <name>`);
                await run({ mode: "notebook", action: "profile", operation: profileOperation, name });
                return;
              }
              throw new Error(`Usage: /repl ${command} [list|save <name>|load <name>]`);
            }
            case "journal": {
              const [first, second, ...extra] = rest;
              if (first === undefined) {
                await run({ mode: "notebook", action: "journal", operation: "list" });
                return;
              }
              if (first === "export" && second === undefined && extra.length === 0) {
                await run({ mode: "notebook", action: "journal", operation: "export" });
                return;
              }
              if (extra.length > 0 || (second !== undefined && first === "export")) {
                throw new Error("Usage: /repl journal [export|<cursor> [<limit>]]");
              }
              if (first === "export") throw new Error("Usage: /repl journal [export|<cursor> [<limit>]]");
              await run({
                mode: "notebook",
                action: "journal",
                operation: "list",
                cursor: parseNonNegativeInt("cursor", first),
                ...(second !== undefined ? { limit: parsePositiveInt("limit", second) } : {}),
              });
              return;
            }
            case "journal-export":
            case "export":
              requireNoArgs(command, rest);
              await run({ mode: "notebook", action: "journal", operation: "export" });
              return;
            case "bindings":
            case "state":
            case "estado":
              requireNoArgs(command, rest);
              await run({ mode: "notebook", action: "bindings" });
              return;
            case "snapshot":
              requireNoArgs(command, rest);
              await run({ mode: "notebook", action: "snapshot" });
              return;
            case "project": {
              const [projectOperation = "status", ...projectArgs] = rest;
              if (projectOperation === "status") {
                requireNoArgs("project status", projectArgs);
                await run({ mode: "notebook", action: "project", operation: "status" });
                return;
              }
              if (projectOperation === "promote" && projectArgs.length === 1) {
                await run({
                  mode: "notebook",
                  action: "project",
                  operation: "promote",
                  expected_generation: parseNonNegativeInt("expected_generation", projectArgs[0]),
                });
                return;
              }
              if (projectOperation === "rollback" && projectArgs.length === 2) {
                await run({
                  mode: "notebook",
                  action: "project",
                  operation: "rollback",
                  expected_generation: parseNonNegativeInt("expected_generation", projectArgs[0]),
                  target_generation: parsePositiveInt("target_generation", projectArgs[1]),
                });
                return;
              }
              throw new Error("Usage: /repl project [status|promote <expected_generation>|rollback <expected_generation> <target_generation>]");
            }
            case "diagnostics": {
              const [first, second, ...extra] = rest;
              if (extra.length || (first !== undefined && second !== undefined && !isMode(second))) {
                throw new Error("Usage: /repl diagnostics [execution_id] [notebook|code]");
              }
              if (first !== undefined && second !== undefined) {
                await run({ mode: second, action: "diagnostics", execution_id: first });
                return;
              }
              if (first !== undefined && isMode(first)) {
                await run({ mode: first, action: "diagnostics" });
                return;
              }
              await run({
                mode: "notebook",
                action: "diagnostics",
                ...(first !== undefined ? { execution_id: first } : {}),
              });
              return;
            }
          }
          throw new Error(USAGE);
        } catch (error) {
          context.ui.notify(errorMessage(error), "error");
        }
      },
    });
  };
}

const USAGE = "Usage: /repl [status|enable|disable|policies|limits|restart|checkpoint|reset|terminate <execution_id> [notebook|code]|profile [list|save <name>|load <name>]|journal [export|<cursor> [<limit>]]|journal-export|export|bindings|state|snapshot|project [status|promote <expected_generation>|rollback <expected_generation> <target_generation>]|diagnostics [execution_id] [notebook|code]|{JSON request}]";

function requireNoArgs(command: string, rest: string[]): void {
  if (rest.length) throw new Error(`Usage: /repl ${command}`);
}

function isMode(value: string): value is "notebook" | "code" {
  return value === "notebook" || value === "code";
}

function parseNonNegativeInt(field: string, value: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`Usage: /repl ${field} must be a non-negative integer`);
  return Number(value);
}

function parsePositiveInt(field: string, value: string): number {
  const parsed = parseNonNegativeInt(field, value);
  if (parsed < 1) throw new Error(`Usage: /repl ${field} must be a positive integer`);
  return parsed;
}

async function close(session: ActiveSession, context: ExtensionContext, reason: string): Promise<void> {
  try {
    await session.router.shutdown();
  } catch (error) {
    context.ui.notify(`repl_notebook ${reason} cleanup failed: ${errorMessage(error)}`, "error");
  }
}

function defaultManager(options: ManagerFactoryOptions): ExecutionSupervisor {
  const services = {
    limits: options.limits,
    bridge: options.bridge,
    registry: options.registry,
    sessionId: options.sessionId,
    cwd: options.cwd,
    kernel: (mode: "code" | "notebook", onOutput?: ConstructorParameters<typeof JupyterKernelBackend>[0]["onOutput"]) =>
      new JupyterKernelBackend({
        cwd: options.cwd,
        mode,
        sessionId: options.sessionId,
        maxHeapMiB: options.limits.maxHeapMiB,
        startupTimeoutMs: options.limits.startupMs,
        interruptGraceMs: options.limits.interruptMs,
        shutdownGraceMs: options.limits.shutdownMs,
        maxOutputBytes: options.limits.outputBytes,
        maxMessageBytes: options.limits.responseBytes,
        onOutput,
      }),
  };
  return new ExecutionManager(services, options.root);
}

export function projectStateRoot(cwd: string): string {
  const base = process.env.PI_REPL_STATE_DIR?.trim() || join(homedir(), ".pi", "agent", "repl-notebook");
  const project = createHash("sha256").update(resolve(cwd)).digest("hex");
  return join(resolve(base), project);
}

function report(context: ExtensionContext, value: unknown): void {
  const text = JSON.stringify(value, null, 2) ?? "null";
  context.ui.notify(text.length > 16_384 ? `${text.slice(0, 16_384)}\n[truncated]` : text, "info");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : { value };
}

export default createExtension();
