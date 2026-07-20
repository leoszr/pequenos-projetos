import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";

export interface HerdrRequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface HerdrClientOptions {
  minimumProtocol?: number;
  requestTimeoutMs?: number;
  connectTimeoutMs?: number;
}

export interface HerdrSnapshot {
  protocol: number;
  version?: string;
  panes?: HerdrPane[];
  tabs?: Array<Record<string, unknown>>;
  workspaces?: Array<Record<string, unknown>>;
  agents?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface HerdrPane {
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  agent_status: "idle" | "working" | "blocked" | "done" | "unknown";
  cwd?: string | null;
  tokens?: Record<string, string>;
  [key: string]: unknown;
}

export interface HerdrSubscriptionEvent {
  event: string;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

export class HerdrProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HerdrProtocolError";
  }
}

export class HerdrRequestError extends Error {
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "HerdrRequestError";
    this.code = code;
  }
}

/**
 * Herdr's socket accepts one ordinary request per connection. Event
 * subscriptions are the exception and keep their own dedicated connection.
 */
export class HerdrClient {
  readonly #socketPath: string;
  readonly #options: Required<HerdrClientOptions>;
  readonly #subscriptionSockets = new Set<Socket>();
  #closed = false;
  #snapshot?: HerdrSnapshot;

  constructor(socketPath: string, options: HerdrClientOptions = {}) {
    if (!socketPath) throw new Error("HERDR_SOCKET_PATH is required");
    this.#socketPath = socketPath;
    this.#options = {
      minimumProtocol: options.minimumProtocol ?? 16,
      requestTimeoutMs: options.requestTimeoutMs ?? 5_000,
      connectTimeoutMs: options.connectTimeoutMs ?? 2_000,
    };
  }

  get snapshot(): HerdrSnapshot | undefined {
    return this.#snapshot ? structuredClone(this.#snapshot) : undefined;
  }

  async connect(): Promise<HerdrSnapshot> {
    if (this.#closed) throw new Error("Herdr client is closed");
    const result = await this.request<{ snapshot: HerdrSnapshot }>("session.snapshot", {});
    const snapshot = result.snapshot;
    if (!snapshot || !Number.isInteger(snapshot.protocol)) {
      throw new HerdrProtocolError("Herdr snapshot did not include a protocol version");
    }
    if (snapshot.protocol < this.#options.minimumProtocol) {
      throw new HerdrProtocolError(
        `Herdr protocol ${snapshot.protocol} is older than required ${this.#options.minimumProtocol}`,
      );
    }
    this.#snapshot = structuredClone(snapshot);
    return structuredClone(snapshot);
  }

  request<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    options: HerdrRequestOptions = {},
  ): Promise<T> {
    if (this.#closed) return Promise.reject(new Error("Herdr client is closed"));
    if (options.signal?.aborted) return Promise.reject(abortError());
    const id = `holistic:${randomUUID()}`;
    return new Promise<T>((resolve, reject) => {
      const socket = createConnection(this.#socketPath);
      let buffer = "";
      let settled = false;
      const timeoutMs = options.timeoutMs ?? this.#options.requestTimeoutMs;
      const timeout = setTimeout(
        () => finish(new HerdrRequestError(`Herdr request timed out: ${method}`)),
        timeoutMs,
      );
      timeout.unref?.();
      const connectTimeout = setTimeout(
        () => finish(new HerdrRequestError("Timed out connecting to Herdr socket")),
        this.#options.connectTimeoutMs,
      );
      connectTimeout.unref?.();

      const onAbort = () => finish(abortError());
      options.signal?.addEventListener("abort", onAbort, { once: true });

      const finish = (error?: Error, value?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearTimeout(connectTimeout);
        options.signal?.removeEventListener("abort", onAbort);
        socket.destroy();
        if (error) reject(error);
        else resolve(value as T);
      };

      socket.setEncoding("utf8");
      socket.on("connect", () => {
        clearTimeout(connectTimeout);
        socket.write(`${JSON.stringify({ id, method, params })}\n`);
      });
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        let messages: Array<Record<string, unknown>>;
        try {
          messages = takeMessages(() => buffer, (next) => (buffer = next));
        } catch (error) {
          finish(error instanceof Error ? error : new HerdrProtocolError(String(error)));
          return;
        }
        for (const message of messages) {
          if (message.id !== id) continue;
          if (message.error && typeof message.error === "object") {
            const body = message.error as { code?: string; message?: string };
            finish(new HerdrRequestError(body.message ?? "Herdr request failed", body.code));
          } else {
            finish(undefined, message.result);
          }
          return;
        }
      });
      socket.on("error", (error) => finish(error));
      socket.on("end", () => finish(new HerdrRequestError("Herdr socket ended before response")));
    });
  }

  subscribe(
    subscriptions: Array<Record<string, unknown>>,
    listener: (event: HerdrSubscriptionEvent) => void,
  ): Promise<() => void> {
    if (this.#closed) return Promise.reject(new Error("Herdr client is closed"));
    const id = `holistic:subscription:${randomUUID()}`;
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.#socketPath);
      this.#subscriptionSockets.add(socket);
      let buffer = "";
      let acknowledged = false;
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new HerdrRequestError("Herdr subscription timed out"));
      }, this.#options.requestTimeoutMs);
      timeout.unref?.();

      socket.setEncoding("utf8");
      socket.on("connect", () => {
        socket.write(`${JSON.stringify({ id, method: "events.subscribe", params: { subscriptions } })}\n`);
      });
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        let messages: Array<Record<string, unknown>>;
        try {
          messages = takeMessages(() => buffer, (next) => (buffer = next));
        } catch (error) {
          clearTimeout(timeout);
          socket.destroy();
          if (!acknowledged) reject(error);
          return;
        }
        for (const message of messages) {
          if (message.id === id) {
            if (message.error && typeof message.error === "object") {
              clearTimeout(timeout);
              const body = message.error as { code?: string; message?: string };
              socket.destroy();
              reject(new HerdrRequestError(body.message ?? "Herdr subscription failed", body.code));
              return;
            }
            if (!acknowledged) {
              acknowledged = true;
              clearTimeout(timeout);
              resolve(() => {
                this.#subscriptionSockets.delete(socket);
                socket.destroy();
              });
            }
          } else if (typeof message.event === "string") {
            try {
              listener(message as unknown as HerdrSubscriptionEvent);
            } catch {
              // Consumer errors do not tear down transport.
            }
          }
        }
      });
      socket.on("error", (error) => {
        clearTimeout(timeout);
        this.#subscriptionSockets.delete(socket);
        if (!acknowledged) reject(error);
      });
      socket.on("close", () => this.#subscriptionSockets.delete(socket));
    });
  }

  close(): void {
    this.#closed = true;
    this.#snapshot = undefined;
    for (const socket of this.#subscriptionSockets) socket.destroy();
    this.#subscriptionSockets.clear();
  }
}

function takeMessages(
  getBuffer: () => string,
  setBuffer: (value: string) => void,
): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];
  let buffer = getBuffer();
  for (;;) {
    const index = buffer.indexOf("\n");
    if (index < 0) break;
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    try {
      messages.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      throw new HerdrProtocolError("Herdr sent invalid NDJSON");
    }
  }
  setBuffer(buffer);
  return messages;
}

function abortError(): Error {
  const error = new Error("Operation aborted");
  error.name = "AbortError";
  return error;
}
