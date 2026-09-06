import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Dealer, Subscriber } from "zeromq";

import type {
  ExecutionIdentity,
  KernelBackend,
  KernelOptions,
  KernelOutput,
  KernelResult,
  KernelState,
} from "./backend.ts";
import {
  decodeWireMessage,
  encodeWireMessage,
  type WireHeader,
  type WireMessage,
  type WireObject,
} from "./wire.ts";

const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const DEFAULT_INTERRUPT_GRACE_MS = 3_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 2_000;
export const EXPECTED_DENO_VERSION = "2.9.6";
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
const SOCKET_HIGH_WATER_MARK = 128;
const MAX_PENDING = 128;
const MAX_LATE_IDENTITIES = 256;

type RequestWaiter = {
  expectedType: string;
  resolve: (message: WireMessage) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type OutputContext = {
  identity: ExecutionIdentity;
  bytes: number;
  truncated: boolean;
};

type PendingExecution = OutputContext & {
  requestId: string;
  outputs: KernelOutput[];
  reply?: WireObject;
  idle: boolean;
  cancelRequested: boolean;
  resolve: (result: KernelResult) => void;
  reject: (error: Error) => void;
  removeAbort?: () => void;
};

function isPending(context: OutputContext | PendingExecution): context is PendingExecution {
  return "requestId" in context;
}

type Connection = {
  shell_port: number;
  iopub_port: number;
  stdin_port: number;
  control_port: number;
  hb_port: number;
  ip: "127.0.0.1";
  key: string;
  transport: "tcp";
  signature_scheme: "hmac-sha256";
  kernel_name: "deno";
};

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) throw new RangeError(`${name} must be a positive safe integer`);
  return result;
}

function abortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error("Operation aborted");
  error.name = "AbortError";
  return error;
}

function waitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortError(signal));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function outputBytes(output: KernelOutput): number {
  return Buffer.byteLength(output.text ?? "") + (output.data ? Buffer.byteLength(JSON.stringify(output.data)) : 0) +
    (output.metadata ? Buffer.byteLength(JSON.stringify(output.metadata)) : 0);
}

function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const bytes = Buffer.from(text);
  if (bytes.byteLength <= maxBytes) return text;
  return new TextDecoder().decode(bytes.subarray(0, maxBytes), { stream: true });
}

async function reservePorts(count: number): Promise<number[]> {
  const servers = Array.from({ length: count }, () => createServer());
  try {
    await Promise.all(servers.map((server) => new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    })));
    return servers.map((server) => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Failed to reserve a Jupyter port");
      return address.port;
    });
  } finally {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  }
}

export class JupyterKernelBackend implements KernelBackend {
  readonly generation = randomUUID();

  #state: KernelState = "not_started";
  #options: KernelOptions;
  #startupTimeoutMs: number;
  #interruptGraceMs: number;
  #shutdownGraceMs: number;
  #maxOutputBytes: number;
  #maxMessageBytes: number;
  #epoch = 0;
  #startPromise?: Promise<void>;
  #shutdownPromise?: Promise<void>;
  #startupAbort?: AbortController;
  #child?: ChildProcess;
  #exitPromise?: Promise<void>;
  #shell?: Dealer;
  #control?: Dealer;
  #iopub?: Subscriber;
  #connection?: Connection;
  #tempDirectory?: string;
  #shellWaiters = new Map<string, RequestWaiter>();
  #pending = new Map<string, PendingExecution>();
  #late = new Map<string, OutputContext>();
  #interruptTimer?: NodeJS.Timeout;
  #nativeBytes = 0;
  #nativeTruncated = false;
  #kernelInfo?: WireObject;
  #lastError?: string;
  #callbackErrors = 0;

  constructor(options: KernelOptions) {
    if (!options.cwd) throw new TypeError("cwd is required");
    if (!options.sessionId) throw new TypeError("sessionId is required");
    this.#options = options;
    this.#startupTimeoutMs = positiveInteger(options.startupTimeoutMs, DEFAULT_STARTUP_TIMEOUT_MS, "startupTimeoutMs");
    this.#interruptGraceMs = positiveInteger(options.interruptGraceMs, DEFAULT_INTERRUPT_GRACE_MS, "interruptGraceMs");
    this.#shutdownGraceMs = positiveInteger(options.shutdownGraceMs, DEFAULT_SHUTDOWN_GRACE_MS, "shutdownGraceMs");
    this.#maxOutputBytes = positiveInteger(options.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, "maxOutputBytes");
    this.#maxMessageBytes = positiveInteger(options.maxMessageBytes, DEFAULT_MAX_MESSAGE_BYTES, "maxMessageBytes");
    if (options.maxHeapMiB !== undefined) positiveInteger(options.maxHeapMiB, 1, "maxHeapMiB");
  }

  get state(): KernelState {
    return this.#state;
  }

  start(signal?: AbortSignal): Promise<void> {
    if (["available", "executing", "interrupting", "busy_after_interrupt"].includes(this.#state)) {
      return Promise.resolve();
    }
    if (["closing", "closed", "dead", "incompatible"].includes(this.#state)) {
      return Promise.reject(new Error(`Kernel cannot start from state ${this.#state}`));
    }
    if (!this.#startPromise) {
      this.#state = "starting";
      const epoch = ++this.#epoch;
      this.#startupAbort = new AbortController();
      this.#startPromise = this.#start(epoch, this.#startupAbort.signal).finally(() => {
        if (epoch === this.#epoch) this.#startupAbort = undefined;
      });
      this.#startPromise.catch(() => undefined);
    }
    return waitWithSignal(this.#startPromise, signal);
  }

  async execute(code: string, identity: ExecutionIdentity, signal?: AbortSignal): Promise<KernelResult> {
    if (typeof code !== "string") throw new TypeError("code must be a string");
    if (signal?.aborted) return { status: "cancelled", outputs: [] };
    try {
      await this.start(signal);
    } catch (error) {
      if (signal?.aborted) return { status: "cancelled", outputs: [] };
      throw error;
    }
    return this.#executeStarted(code, identity, signal);
  }

  async #executeStarted(code: string, identity: ExecutionIdentity, signal?: AbortSignal, requestId = randomUUID()): Promise<KernelResult> {
    this.#validateIdentity(identity);
    if (!this.#shell || !this.#connection || this.#state === "dead") throw new Error("Kernel is not available");
    if (this.#pending.size >= MAX_PENDING) throw new Error(`Kernel has ${MAX_PENDING} pending executions`);

    const result = new Promise<KernelResult>((resolve, reject) => {
      const pending: PendingExecution = {
        requestId,
        identity: { ...identity },
        outputs: [],
        bytes: 0,
        truncated: false,
        idle: false,
        cancelRequested: false,
        resolve,
        reject,
      };
      if (signal) {
        const abort = () => {
          pending.cancelRequested = true;
          void this.interrupt().catch(() => undefined);
        };
        signal.addEventListener("abort", abort, { once: true });
        pending.removeAbort = () => signal.removeEventListener("abort", abort);
      }
      this.#pending.set(requestId, pending);
    });

    if (this.#state !== "starting") {
      this.#state = "executing";
    }
    try {
      await this.#send(this.#shell, "execute_request", {
        code,
        silent: false,
        store_history: true,
        user_expressions: {},
        allow_stdin: false,
        stop_on_error: true,
      }, requestId);
    } catch (error) {
      const pending = this.#pending.get(requestId);
      if (pending) {
        this.#pending.delete(requestId);
        pending.removeAbort?.();
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
      if (this.#pending.size === 0 && this.#state === "executing") this.#state = "available";
    }

    if (signal?.aborted) {
      const pending = this.#pending.get(requestId);
      if (pending) pending.cancelRequested = true;
      void this.interrupt().catch(() => undefined);
    }
    return result;
  }

  async interrupt(): Promise<void> {
    if (this.#state === "starting" && this.#startPromise) await this.#startPromise;
    if (!this.#control || this.#pending.size === 0 || ["dead", "closed", "closing"].includes(this.#state)) return;

    for (const pending of this.#pending.values()) pending.cancelRequested = true;
    this.#state = "interrupting";
    await this.#send(this.#control, "interrupt_request", {});
    this.#state = "busy_after_interrupt";

    if (!this.#interruptTimer) {
      this.#interruptTimer = setTimeout(() => {
        this.#interruptTimer = undefined;
        if (this.#pending.size === 0) return;
        const error = new Error(`Kernel did not stop within ${this.#interruptGraceMs}ms after interrupt`);
        this.#lastError = error.message;
        for (const pending of [...this.#pending.values()]) this.#finishExecution(pending, "cancelled", error.message);
        this.#state = "dead";
        this.#closeSockets();
        void this.#killProcess(true);
      }, this.#interruptGraceMs);
      this.#interruptTimer.unref();
    }
  }

  shutdown(): Promise<void> {
    if (this.#shutdownPromise) return this.#shutdownPromise;
    if (this.#state === "closed") return Promise.resolve();
    this.#shutdownPromise = this.#shutdown();
    return this.#shutdownPromise;
  }

  diagnostics(): Record<string, unknown> {
    return {
      backend: "deno-jupyter",
      generation: this.generation,
      state: this.#state,
      pid: this.#child?.pid,
      pendingExecutions: this.#pending.size,
      retainedLateIdentities: this.#late.size,
      kernelInfo: this.#kernelInfo,
      nativeOutputBytes: this.#nativeBytes,
      callbackErrors: this.#callbackErrors,
      lastError: this.#lastError,
    };
  }

  async #start(epoch: number, signal: AbortSignal): Promise<void> {
    const timeout = setTimeout(() => this.#startupAbort?.abort(new Error(`Kernel startup timed out after ${this.#startupTimeoutMs}ms`)), this.#startupTimeoutMs);
    timeout.unref();
    try {
      const ports = await reservePorts(5);
      if (signal.aborted) throw abortError(signal);
      this.#tempDirectory = await mkdtemp(join(tmpdir(), "pi-repl-jupyter-"));
      this.#connection = {
        shell_port: ports[0]!,
        iopub_port: ports[1]!,
        stdin_port: ports[2]!,
        control_port: ports[3]!,
        hb_port: ports[4]!,
        ip: "127.0.0.1",
        key: randomBytes(32).toString("hex"),
        transport: "tcp",
        signature_scheme: "hmac-sha256",
        kernel_name: "deno",
      };
      const connectionPath = join(this.#tempDirectory, "connection.json");
      await writeFile(connectionPath, JSON.stringify(this.#connection), { mode: 0o600 });
      this.#openSockets(epoch);
      this.#spawnKernel(connectionPath, epoch);

      if (signal.aborted) throw abortError(signal);
      const info = await this.#request(this.#shell!, "kernel_info_request", {}, "kernel_info_reply", this.#startupTimeoutMs, signal);
      if (info.content.status !== "ok") throw new Error("Deno Jupyter rejected kernel_info_request");
      const protocol = info.content.protocol_version;
      if (typeof protocol !== "string" || protocol.split(".")[0] !== "5") {
        this.#state = "incompatible";
        throw new Error(`Unsupported Jupyter protocol version: ${String(protocol)}`);
      }
      if (!String(info.content.implementation ?? "").toLowerCase().includes("deno") || info.content.implementation_version !== EXPECTED_DENO_VERSION) {
        this.#state = "incompatible";
        throw new Error(
          `Unsupported Deno runtime: ${String(info.content.implementation)} ${String(info.content.implementation_version)} (expected deno ${EXPECTED_DENO_VERSION})`,
        );
      }
      this.#kernelInfo = info.content;
      if (epoch !== this.#epoch || signal.aborted) throw abortError(signal);
      // The shell reply proves the kernel is alive, but the IOPub SUB
      // subscription is asynchronous: publishes sent before the subscription
      // propagates are silently lost (ZeroMQ slow-joiner). A fixed delay
      // cannot prove readiness, so run a side-effect-free execute until its
      // idle status is observed before admitting real executions.
      await this.#proveIopubReady(epoch, signal);
      if (epoch !== this.#epoch || signal.aborted) throw abortError(signal);
      this.#state = "available";
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.#lastError = failure.message;
      if (this.#state !== "closing" && this.#state !== "incompatible") this.#state = "dead";
      this.#rejectWaiters(failure);
      this.#closeSockets();
      await this.#killProcess(true);
      await this.#removeTempDirectory();
      throw failure;
    } finally {
      clearTimeout(timeout);
    }
  }

  async #proveIopubReady(epoch: number, signal: AbortSignal): Promise<void> {
    const budgetMs = Math.max(1_000, Math.min(this.#startupTimeoutMs, 15_000));
    const deadline = Date.now() + budgetMs;
    let attempt = 0;
    let lastError: unknown = new Error("no attempt made");
    while (Date.now() < deadline) {
      attempt++;
      if (epoch !== this.#epoch) throw abortError(signal);
      signal.throwIfAborted();
      const identity: ExecutionIdentity = {
        sessionId: this.#options.sessionId,
        executionId: `barrier:${this.generation}:${attempt}`,
        mode: this.#options.mode,
        generation: this.generation,
      };
      const requestId = randomUUID();
      try {
        const attemptMs = Math.min(3_000, Math.max(500, deadline - Date.now()));
        const result = await Promise.race([
          this.#executeStarted("void 0", identity, undefined, requestId),
          delay(attemptMs).then((): KernelResult => ({ status: "error", error: "IOPub barrier attempt timed out", outputs: [] })),
        ]);
        if (result.status === "ok") return;
        lastError = result.error ?? `barrier status ${result.status}`;
      } catch (error) {
        lastError = error;
        if (epoch !== this.#epoch) throw abortError(signal);
      } finally {
        const pending = this.#pending.get(requestId);
        if (pending) {
          this.#pending.delete(requestId);
          pending.removeAbort?.();
        }
      }
      await waitWithSignal(delay(Math.min(1_000, 100 * attempt)), signal).catch(() => undefined);
    }
    throw new Error(`Kernel IOPub channel did not become ready: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }

  #openSockets(epoch: number): void {
    if (!this.#connection) throw new Error("Missing Jupyter connection");
    const address = (port: number) => `tcp://${this.#connection!.ip}:${port}`;
    this.#shell = new Dealer({ routingId: `${this.#options.sessionId}-shell-${randomUUID()}` });
    this.#control = new Dealer({ routingId: `${this.#options.sessionId}-control-${randomUUID()}` });
    this.#iopub = new Subscriber();
    for (const socket of [this.#shell, this.#control]) {
      socket.linger = 0;
      socket.sendHighWaterMark = SOCKET_HIGH_WATER_MARK;
      socket.receiveHighWaterMark = SOCKET_HIGH_WATER_MARK;
      socket.sendTimeout = 1_000;
    }
    this.#iopub.linger = 0;
    this.#iopub.receiveHighWaterMark = SOCKET_HIGH_WATER_MARK;
    this.#iopub.subscribe();
    this.#shell.connect(address(this.#connection.shell_port));
    this.#control.connect(address(this.#connection.control_port));
    this.#iopub.connect(address(this.#connection.iopub_port));
    void this.#receiveShell(this.#shell, epoch);
    void this.#receiveControl(this.#control, epoch);
    void this.#receiveIopub(this.#iopub, epoch);
  }

  #spawnKernel(connectionPath: string, epoch: number): void {
    const deno = this.#options.deno ?? "deno";
    const env: NodeJS.ProcessEnv = { ...process.env, DENO_NO_PACKAGE_JSON: "1", DENO_NO_PROMPT: "1", DENO_NO_UPDATE_CHECK: "1" };
    if (this.#options.maxHeapMiB) {
      const heapFlag = `--max-old-space-size=${this.#options.maxHeapMiB}`;
      env.DENO_V8_FLAGS = env.DENO_V8_FLAGS ? `${env.DENO_V8_FLAGS},${heapFlag}` : heapFlag;
    }
    const child = spawn(deno, ["jupyter", "--kernel", "--conn", connectionPath], {
      cwd: this.#options.cwd,
      detached: process.platform !== "win32",
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#child = child;
    child.stdout?.on("data", (chunk: Buffer | string) => this.#emitNative("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer | string) => this.#emitNative("stderr", chunk));
    this.#exitPromise = new Promise((resolve) => {
      child.once("exit", (code, signal) => {
        resolve();
        if (epoch !== this.#epoch) return;
        const expected = this.#state === "closing" || this.#state === "closed";
        const error = new Error(`Deno Jupyter exited (${signal ?? code ?? "unknown"})`);
        if (!expected) {
          this.#lastError = error.message;
          this.#state = "dead";
        }
        this.#rejectWaiters(error);
        this.#rejectPending(error);
        this.#closeSockets();
      });
      child.once("error", (cause) => {
        if (epoch !== this.#epoch) return;
        this.#lastError = cause.message;
        this.#state = this.#state === "closing" ? "closing" : "dead";
        this.#rejectWaiters(cause);
        this.#rejectPending(cause);
        this.#closeSockets();
      });
    });
  }

  async #receiveShell(socket: Dealer, epoch: number): Promise<void> {
    try {
      for await (const frames of socket) {
        if (epoch !== this.#epoch) return;
        const message = decodeWireMessage(frames, this.#connection!.key, this.#maxMessageBytes);
        const parentId = message.parentHeader.msg_id;
        if (typeof parentId !== "string") continue;
        const waiter = this.#shellWaiters.get(parentId);
        if (waiter && message.header.msg_type === waiter.expectedType) {
          this.#shellWaiters.delete(parentId);
          clearTimeout(waiter.timer);
          waiter.resolve(message);
          continue;
        }
        const pending = this.#pending.get(parentId);
        if (pending && message.header.msg_type === "execute_reply") {
          pending.reply = message.content;
          this.#maybeFinishExecution(pending);
        }
      }
    } catch (error) {
      this.#socketFailure(error, epoch);
    }
  }

  async #receiveControl(socket: Dealer, epoch: number): Promise<void> {
    try {
      for await (const frames of socket) {
        if (epoch !== this.#epoch) return;
        decodeWireMessage(frames, this.#connection!.key, this.#maxMessageBytes);
      }
    } catch (error) {
      this.#socketFailure(error, epoch);
    }
  }

  async #receiveIopub(socket: Subscriber, epoch: number): Promise<void> {
    try {
      for await (const frames of socket) {
        if (epoch !== this.#epoch) return;
        const message = decodeWireMessage(frames, this.#connection!.key, this.#maxMessageBytes);
        const parentId = message.parentHeader.msg_id;
        if (message.header.msg_type === "status") {
          if (message.content.execution_state === "idle" && typeof parentId === "string") {
            const pending = this.#pending.get(parentId);
            if (pending) {
              pending.idle = true;
              this.#maybeFinishExecution(pending);
            }
          }
          continue;
        }
        const output = this.#toOutput(message);
        if (!output) continue;
        const context = typeof parentId === "string" ? this.#pending.get(parentId) ?? this.#late.get(parentId) : undefined;
        if (!context) {
          this.#emit({ ...output, attribution: "unattributed" });
        } else if (isPending(context)) {
          this.#recordOutput(context, { ...output, origin: context.identity, attribution: "execution" });
        } else {
          this.#recordOutput(context, { ...output, origin: context.identity, attribution: "background" });
        }
      }
    } catch (error) {
      this.#socketFailure(error, epoch);
    }
  }

  #toOutput(message: WireMessage): Omit<KernelOutput, "attribution"> | undefined {
    const content = message.content;
    switch (message.header.msg_type) {
      case "stream":
        if ((content.name !== "stdout" && content.name !== "stderr") || typeof content.text !== "string") return undefined;
        return { kind: content.name, text: content.text };
      case "display_data":
      case "update_display_data": {
        const data = content.data && typeof content.data === "object" && !Array.isArray(content.data) ? content.data as WireObject : {};
        const metadata = content.metadata && typeof content.metadata === "object" && !Array.isArray(content.metadata)
          ? { ...(content.metadata as WireObject), ...(content.transient ? { transient: content.transient } : {}), ...(message.header.msg_type === "update_display_data" ? { update: true } : {}) }
          : undefined;
        return { kind: "display", text: typeof data["text/plain"] === "string" ? data["text/plain"] : undefined, data, metadata };
      }
      case "execute_result": {
        const data = content.data && typeof content.data === "object" && !Array.isArray(content.data) ? content.data as WireObject : {};
        return {
          kind: "result",
          text: typeof data["text/plain"] === "string" ? data["text/plain"] : undefined,
          data,
          metadata: content.metadata && typeof content.metadata === "object" && !Array.isArray(content.metadata) ? content.metadata as WireObject : undefined,
        };
      }
      case "error": {
        const traceback = Array.isArray(content.traceback) && content.traceback.every((line) => typeof line === "string") ? content.traceback : undefined;
        const text = traceback?.join("\n") ?? [content.ename, content.evalue].filter((part) => typeof part === "string").join(": ");
        return { kind: "error", text, data: content };
      }
      case "clear_output":
        return { kind: "notification", text: "clear_output", data: content };
      default:
        return undefined;
    }
  }

  #recordOutput(context: OutputContext, output: KernelOutput): void {
    const bytes = outputBytes(output);
    if (context.bytes + bytes <= this.#maxOutputBytes) {
      context.bytes += bytes;
      if (isPending(context)) context.outputs.push(output);
      this.#emit(output);
      return;
    }

    if (output.text && context.bytes < this.#maxOutputBytes) {
      const text = truncateUtf8(output.text, this.#maxOutputBytes - context.bytes);
      if (text) {
        const partial = { ...output, text, data: undefined, metadata: undefined };
        context.bytes += Buffer.byteLength(text);
        if (isPending(context)) context.outputs.push(partial);
        this.#emit(partial);
      }
    }
    if (!context.truncated) {
      context.truncated = true;
      const notification: KernelOutput = {
        kind: "notification",
        text: `Output truncated after ${this.#maxOutputBytes} bytes`,
        origin: context.identity,
        attribution: output.attribution,
      };
      if (isPending(context)) context.outputs.push(notification);
      this.#emit(notification);
    }
  }

  #emitNative(kind: "stdout" | "stderr", chunk: Buffer | string): void {
    if (this.#nativeTruncated) return;
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const remaining = this.#maxOutputBytes - this.#nativeBytes;
    const bounded = truncateUtf8(text, remaining);
    if (bounded) {
      this.#nativeBytes += Buffer.byteLength(bounded);
      this.#emit({ kind, text: bounded, attribution: "unattributed" });
    }
    if (Buffer.byteLength(text) > remaining) {
      this.#nativeTruncated = true;
      this.#emit({ kind: "notification", text: `Native kernel output truncated after ${this.#maxOutputBytes} bytes`, attribution: "unattributed" });
    }
  }

  #emit(output: KernelOutput): void {
    try {
      this.#options.onOutput?.(output);
    } catch {
      this.#callbackErrors++;
    }
  }

  #maybeFinishExecution(pending: PendingExecution): void {
    if (!pending.reply || !pending.idle) return;
    const replyStatus = pending.reply.status;
    const status = pending.cancelRequested ? "cancelled" : replyStatus === "ok" ? "ok" : "error";
    const error = status === "error"
      ? (typeof pending.reply.evalue === "string" ? pending.reply.evalue : typeof pending.reply.ename === "string" ? pending.reply.ename : "Kernel execution failed")
      : undefined;
    this.#finishExecution(pending, status, error);
  }

  #finishExecution(pending: PendingExecution, status: KernelResult["status"], error?: string): void {
    if (!this.#pending.delete(pending.requestId)) return;
    pending.removeAbort?.();
    this.#late.delete(pending.requestId);
    this.#late.set(pending.requestId, { identity: pending.identity, bytes: pending.bytes, truncated: pending.truncated });
    while (this.#late.size > MAX_LATE_IDENTITIES) this.#late.delete(this.#late.keys().next().value!);
    pending.resolve({ status, error, outputs: pending.outputs });
    if (this.#pending.size === 0) {
      if (this.#interruptTimer) {
        clearTimeout(this.#interruptTimer);
        this.#interruptTimer = undefined;
      }
      if (!["dead", "closing", "closed", "starting"].includes(this.#state)) this.#state = "available";
    } else if (!["interrupting", "busy_after_interrupt", "starting"].includes(this.#state)) {
      this.#state = "executing";
    }
  }

  #validateIdentity(identity: ExecutionIdentity): void {
    if (identity.generation !== this.generation) throw new Error("Execution identity belongs to another kernel generation");
    if (identity.sessionId !== this.#options.sessionId) throw new Error("Execution identity belongs to another session");
    if (identity.mode !== this.#options.mode) throw new Error("Execution identity has the wrong mode");
    if (!identity.executionId) throw new Error("Execution identity is missing executionId");
  }

  #header(msgType: string, msgId = randomUUID()): WireHeader {
    return {
      msg_id: msgId,
      username: "pi-repl",
      session: this.#options.sessionId,
      date: new Date().toISOString(),
      msg_type: msgType,
      version: "5.3",
    };
  }

  async #send(socket: Dealer, msgType: string, content: WireObject, msgId = randomUUID()): Promise<string> {
    if (!this.#connection) throw new Error("Kernel connection is unavailable");
    const frames = encodeWireMessage(this.#connection.key, { header: this.#header(msgType, msgId), content });
    const bytes = frames.reduce((total, frame) => total + frame.byteLength, 0);
    if (bytes > this.#maxMessageBytes) throw new Error(`Jupyter message exceeds ${this.#maxMessageBytes} bytes`);
    await socket.send(frames);
    return msgId;
  }

  #request(
    socket: Dealer,
    msgType: string,
    content: WireObject,
    expectedType: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<WireMessage> {
    const msgId = randomUUID();
    const response = new Promise<WireMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#shellWaiters.delete(msgId);
        reject(new Error(`${expectedType} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref();
      this.#shellWaiters.set(msgId, { expectedType, resolve, reject, timer });
    });
    void this.#send(socket, msgType, content, msgId).catch((error: unknown) => {
      const waiter = this.#shellWaiters.get(msgId);
      if (!waiter) return;
      this.#shellWaiters.delete(msgId);
      clearTimeout(waiter.timer);
      waiter.reject(error instanceof Error ? error : new Error(String(error)));
    });
    return waitWithSignal(response, signal);
  }

  #socketFailure(error: unknown, epoch: number): void {
    if (epoch !== this.#epoch || ["closing", "closed", "dead"].includes(this.#state)) return;
    const failure = error instanceof Error ? error : new Error(String(error));
    this.#lastError = failure.message;
    this.#state = "dead";
    this.#rejectWaiters(failure);
    this.#rejectPending(failure);
    this.#closeSockets();
    void this.#killProcess(true);
  }

  #rejectWaiters(error: Error): void {
    for (const waiter of this.#shellWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.#shellWaiters.clear();
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      pending.removeAbort?.();
      pending.reject(error);
    }
    this.#pending.clear();
    if (this.#interruptTimer) {
      clearTimeout(this.#interruptTimer);
      this.#interruptTimer = undefined;
    }
  }

  #closeSockets(): void {
    for (const socket of [this.#shell, this.#control, this.#iopub]) {
      try {
        socket?.close();
      } catch {
        // Closing is idempotent from the backend's perspective.
      }
    }
    this.#shell = undefined;
    this.#control = undefined;
    this.#iopub = undefined;
  }

  async #shutdown(): Promise<void> {
    this.#state = "closing";
    this.#startupAbort?.abort(new Error("Kernel shutdown during startup"));
    if (this.#startPromise) await this.#startPromise.catch(() => undefined);

    const child = this.#child;
    if (child?.exitCode === null && child.signalCode === null && this.#control && this.#connection) {
      await this.#send(this.#control, "shutdown_request", { restart: false }).catch(() => undefined);
      await Promise.race([this.#exitPromise ?? Promise.resolve(), delay(this.#shutdownGraceMs)]);
    }
    if (child?.exitCode === null && child.signalCode === null) {
      await this.#killProcess(true);
      await Promise.race([this.#exitPromise ?? Promise.resolve(), delay(this.#shutdownGraceMs)]);
    }

    this.#rejectWaiters(new Error("Kernel shut down"));
    this.#rejectPending(new Error("Kernel shut down"));
    this.#closeSockets();
    await this.#removeTempDirectory();
    this.#child = undefined;
    this.#connection = undefined;
    this.#state = "closed";
  }

  async #killProcess(force: boolean): Promise<void> {
    const child = this.#child;
    const pid = child?.pid;
    if (!child || !pid || child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === "win32") {
      await new Promise<void>((resolve) => {
        const killer = spawn("taskkill", ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])], { windowsHide: true, stdio: "ignore" });
        killer.once("exit", () => resolve());
        killer.once("error", () => resolve());
      });
      return;
    }
    try {
      process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
    } catch {
      try {
        child.kill(force ? "SIGKILL" : "SIGTERM");
      } catch {
        // The process already exited.
      }
    }
  }

  async #removeTempDirectory(): Promise<void> {
    if (!this.#tempDirectory) return;
    const directory = this.#tempDirectory;
    this.#tempDirectory = undefined;
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function createJupyterKernel(options: KernelOptions): KernelBackend {
  return new JupyterKernelBackend(options);
}
