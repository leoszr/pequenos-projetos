import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ExecutionIdentity } from "../kernel/backend.ts";
import type { BridgeExecution } from "./types.ts";
import { ToolRegistry } from "./registry.ts";

const PROTOCOL_VERSION = 1;
const HARD_MAX_BYTES = 1024 * 1024;
const MAX_REQUESTS = 8;
const BODY_TIMEOUT_MS = 5_000;
const SHUTDOWN_GRACE_MS = 1_500;

type RequestType = "hello" | "tools" | "call";
interface BridgeRequest extends ExecutionIdentity {
  version: number;
  type: RequestType;
  requestId: string;
  name?: string;
  args?: unknown;
}

export class BridgeServer {
  private readonly maxBytes: number;
  private readonly executions = new Map<string, BridgeExecution>();
  private readonly handshakes = new Set<string>();
  private server?: Server;
  private startPromise?: Promise<{ url: string; token: string }>;
  private started?: { url: string; token: string };
  private activeRequests = 0;

  constructor(private readonly registry: ToolRegistry, maxBytes = HARD_MAX_BYTES, private readonly bodyTimeoutMs = BODY_TIMEOUT_MS) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("Bridge maxBytes must be a positive integer");
    if (!Number.isSafeInteger(bodyTimeoutMs) || bodyTimeoutMs <= 0) throw new Error("Bridge bodyTimeoutMs must be a positive integer");
    this.maxBytes = Math.min(maxBytes, HARD_MAX_BYTES);
  }

  async start(): Promise<{ url: string; token: string }> {
    if (this.started) return this.started;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.listen();
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = undefined;
    }
  }

  open(execution: BridgeExecution): void {
    const id = execution.identity.executionId;
    const current = this.executions.get(id);
    if (current && !sameIdentity(current.identity, execution.identity)) {
      throw new Error(`Bridge execution id is already open: ${id}`);
    }
    if (!current) this.registry.openExecution(id);
    this.executions.set(id, { ...execution, identity: { ...execution.identity } });
    this.handshakes.delete(identityKey(execution.identity));
  }

  closeExecution(id: string): void {
    const execution = this.executions.get(id);
    if (execution) this.handshakes.delete(identityKey(execution.identity));
    this.executions.delete(id);
    this.registry.closeExecution(id);
  }

  async shutdown(): Promise<void> {
    if (this.startPromise) {
      try {
        await this.startPromise;
      } catch {
        return;
      }
    }
    const ids = [...this.executions.keys()];
    for (const id of ids) this.closeExecution(id);
    // Let cooperatively-cancellable work finish before tearing down sockets.
    await Promise.all(ids.map((id) => this.registry.settle(id, SHUTDOWN_GRACE_MS)));
    await this.drainRequests();
    const server = this.server;
    this.server = undefined;
    this.started = undefined;
    if (!server) return;

    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeIdleConnections();
    if (await settlesWithin(closed, SHUTDOWN_GRACE_MS)) return;
    server.closeAllConnections();
    await settlesWithin(closed, SHUTDOWN_GRACE_MS);
  }

  private async drainRequests(): Promise<void> {
    const deadline = Date.now() + SHUTDOWN_GRACE_MS;
    while (this.activeRequests > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  private async listen(): Promise<{ url: string; token: string }> {
    const token = randomBytes(32).toString("hex");
    const server = createServer((request, response) => void this.handle(request, response, token));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("Bridge did not bind a loopback TCP port");
    }
    this.server = server;
    return this.started = { url: `http://127.0.0.1:${address.port}/bridge`, token };
  }

  private async handle(request: IncomingMessage, response: ServerResponse, token: string): Promise<void> {
    let requestId = "";
    try {
      if (request.method !== "POST" || request.url !== "/bridge") {
        this.write(response, 404, requestId, false, "Not found", request);
        return;
      }
      if (!authorized(request.headers.authorization, token)) {
        this.write(response, 401, requestId, false, "Unauthorized", request);
        return;
      }
      if (this.activeRequests >= MAX_REQUESTS) {
        this.write(response, 429, requestId, false, "Bridge concurrency limit exceeded", request);
        return;
      }

      this.activeRequests++;
      // Response 'close' before finish means the client went away mid-call.
      // (IncomingMessage 'close' also fires on normal message completion,
      // so it must not be used as a disconnect signal.)
      let clientGone = false;
      const onClose = () => { if (!response.writableEnded) clientGone = true; };
      response.on("close", onClose);
      try {
        const value = JSON.parse(await readBody(request, this.maxBytes, this.bodyTimeoutMs)) as unknown;
        if (isObject(value) && typeof value.requestId === "string") requestId = value.requestId;
        const message = parseRequest(value);
        requestId = message.requestId;
        if (message.version !== PROTOCOL_VERSION) throw new Error(`Unsupported bridge version: ${message.version}`);

        const execution = this.executions.get(message.executionId);
        if (!execution || !sameIdentity(execution.identity, message)) throw new Error("Stale bridge execution identity");
        const key = identityKey(message);

        if (message.type === "hello") {
          this.handshakes.add(key);
          this.write(response, 200, requestId, true, { version: PROTOCOL_VERSION, policies: this.registry.policies() }, request);
          return;
        }
        if (!this.handshakes.has(key)) throw new Error("Bridge handshake required");
        if (message.type === "tools") {
          this.write(response, 200, requestId, true, this.registry.list(message.mode), request);
          return;
        }
        if (typeof message.name !== "string" || message.name.length === 0) throw new Error("Bridge call requires a tool name");
        const result = await this.registry.invoke(message.name, message.args, execution);
        // The client may have gone away while the tool ran; the nested call
        // already settled in the registry, so just drop the orphaned response.
        if (!clientGone) this.write(response, 200, requestId, true, result, request);
      } finally {
        response.off("close", onClose);
        this.activeRequests--;
      }
    } catch (error) {
      this.write(response, statusFor(error), requestId, false, error instanceof Error ? error.message : String(error), request);
    }
  }

  private write(
    response: ServerResponse,
    status: number,
    requestId: string,
    ok: boolean,
    value: unknown,
    request?: IncomingMessage,
  ): void {
    if (response.headersSent || response.destroyed) return;
    let body: string;
    try {
      body = JSON.stringify(ok
        ? { version: PROTOCOL_VERSION, requestId, ok: true, value: value === undefined ? null : value }
        : { version: PROTOCOL_VERSION, requestId, ok: false, error: String(value) });
    } catch {
      status = 500;
      body = JSON.stringify({ version: PROTOCOL_VERSION, requestId, ok: false, error: "Bridge response is not JSON serializable" });
    }
    if (Buffer.byteLength(body) > this.maxBytes) {
      status = 413;
      body = JSON.stringify({ version: PROTOCOL_VERSION, requestId: "", ok: false, error: "Bridge response exceeds byte limit" });
      if (Buffer.byteLength(body) > this.maxBytes) body = "";
    }
    const shouldClose = status === 408 || status === 413 || Boolean(request && !request.complete);
    const headers: Record<string, string | number> = {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    };
    if (shouldClose) headers["connection"] = "close";
    response.writeHead(status, headers);
    const cleanup = () => {
      if (request && !request.destroyed) request.destroy();
      if (!response.destroyed) response.destroy();
    };
    if (shouldClose) {
      response.end(body, cleanup);
      response.once("close", cleanup);
      const timer = setTimeout(cleanup, 500);
      timer.unref();
    } else {
      response.end(body);
    }
  }
}

class BodyTooLargeError extends Error {}

class BodyTimeoutError extends Error {}

function statusFor(error: unknown): number {
  if (error instanceof BodyTimeoutError) return 408;
  if (error instanceof BodyTooLargeError) return 413;
  const message = error instanceof Error ? error.message : String(error);
  if (/concurrency limit|call limit|parallel limit/i.test(message)) return 429;
  if (/Stale bridge execution identity|execution is closed|provider changed/i.test(message)) return 409;
  if (/unavailable|inactive/i.test(message)) return 404;
  if (/not allowed/i.test(message)) return 403;
  if (/handshake required|Invalid|schema|arguments|tool name|Unsupported bridge version/i.test(message)) return 400;
  return 500;
}

async function readBody(request: IncomingMessage, maxBytes: number, timeoutMs: number): Promise<string> {
  const length = Number(request.headers["content-length"]);
  if (Number.isFinite(length) && length > maxBytes) {
    request.resume();
    throw new BodyTooLargeError("Bridge request exceeds byte limit");
  }
  const pending = readChunks(request, maxBytes);
  // Avoid an unhandled rejection once the timeout below wins and the
  // stalled stream settles after the 408 response tears it down.
  pending.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new BodyTimeoutError("Bridge request body timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readChunks(request: IncomingMessage, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let tooLarge = false;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) {
      tooLarge = true;
      chunks.length = 0;
    } else if (!tooLarge) {
      chunks.push(buffer);
    }
  }
  if (tooLarge) throw new BodyTooLargeError("Bridge request exceeds byte limit");
  return Buffer.concat(chunks).toString("utf8");
}

function parseRequest(value: unknown): BridgeRequest {
  if (!isObject(value)) throw new Error("Invalid bridge request");
  const { version, type, requestId, sessionId, executionId, cellId, mode, generation, name, args } = value;
  if (typeof version !== "number" || !["hello", "tools", "call"].includes(String(type)) ||
      typeof requestId !== "string" || requestId.length === 0 || typeof sessionId !== "string" ||
      typeof executionId !== "string" || typeof generation !== "string" ||
      (mode !== "code" && mode !== "notebook") || (cellId !== undefined && typeof cellId !== "string")) {
    throw new Error("Invalid bridge request");
  }
  return { version, type: type as RequestType, requestId, sessionId, executionId, cellId, mode, generation, name: typeof name === "string" ? name : undefined, args };
}

function sameIdentity(left: ExecutionIdentity, right: ExecutionIdentity): boolean {
  return left.sessionId === right.sessionId && left.executionId === right.executionId &&
    left.cellId === right.cellId && left.mode === right.mode && left.generation === right.generation;
}

function identityKey(identity: ExecutionIdentity): string {
  return JSON.stringify([identity.sessionId, identity.executionId, identity.cellId, identity.mode, identity.generation]);
}

function authorized(header: string | undefined, token: string): boolean {
  const expected = `Bearer ${token}`;
  if (!header || header.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function settlesWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
