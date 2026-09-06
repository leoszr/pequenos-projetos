import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { KernelOutput, Mode } from "../kernel/backend.ts";
import { CodeRuntime } from "../code-mode/runtime.ts";
import { NotebookRuntime } from "../notebook-mode/runtime.ts";
import type { RuntimeServices } from "./session.ts";
import { boundedWait, isTerminal, type ExecutionResult } from "./engine.ts";
interface Job { result: ExecutionResult; controller: AbortController; done: Promise<void>; code?: CodeRuntime; bytes: number }
export class ExecutionManager {
  readonly notebook: NotebookRuntime;
  private jobs = new Map<string, Job>();
  private accepting = true;
  private notebookBusy = false;
  private background: KernelOutput[] = [];
  private backgroundBytes = 0;
  constructor(private services: RuntimeServices, root: string) {
    this.notebook = new NotebookRuntime(services, root, output => this.output(output));
  }
  private output(output: KernelOutput): void {
    if (output.origin?.executionId.startsWith("internal:")) return;
    const size = Buffer.byteLength(JSON.stringify(output));
    const job = output.origin && this.jobs.get(output.origin.executionId);
    if (job && output.origin?.generation === job.result.generation && !isTerminal(job.result.state)) {
      if (job.bytes + size <= this.services.limits.outputBytes) { job.result.outputs.push(output); job.bytes += size; }
      else if (!job.controller.signal.aborted) job.controller.abort(new Error("Output limit exceeded"));
    } else if (this.backgroundBytes + size <= this.services.limits.backgroundBytes) {
      this.background.push({ ...output, attribution: output.origin ? "background" : "unattributed" }); this.backgroundBytes += size;
    }
  }
  start(mode: Mode, code: string, context: ExtensionContext, signal?: AbortSignal, yieldMs = 1000): Promise<ExecutionResult> {
    if (!this.accepting) throw new Error("Runtime disabled or shutting down");
    signal?.throwIfAborted();
    if (Buffer.byteLength(code) > this.services.limits.requestBytes) throw new Error("Code payload limit");
    if (mode === "notebook" && this.notebookBusy) throw new Error("Notebook busy: wait or interrupt current execution");
    const activeCode = [...this.jobs.values()].filter(j => j.result.mode === "code" && !isTerminal(j.result.state)).length;
    if (mode === "code" && activeCode >= this.services.limits.concurrentCode) throw new Error("Concurrent Code Mode limit");
    if (this.jobs.size >= this.services.limits.retainedExecutions) {
      const oldest = [...this.jobs].find(([, job]) => isTerminal(job.result.state) && job.result.cleanup === "completed");
      if (!oldest) throw new Error("Execution retention limit; cleanup still pending");
      this.jobs.delete(oldest[0]);
    }
    const executionId = randomUUID();
    const result: ExecutionResult = { executionId, cellId: mode === "notebook" ? randomUUID() : undefined, sessionId: this.services.sessionId, generation: "starting", mode, state: "created", cleanup: "pending", outputs: [], startedAt: new Date().toISOString(), durationMs: 0 };
    const controller = new AbortController();
    const job: Job = { result, controller, bytes: 0, done: Promise.resolve() };
    if (mode === "code") {
      job.code = new CodeRuntime(this.services, output => this.output(output));
      result.generation = job.code.session.kernel.generation;
    } else this.notebookBusy = true;
    this.jobs.set(executionId, job);
    const abort = () => controller.abort(signal?.reason ?? new Error("Cancelled by Pi"));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => controller.abort(new Error(`${mode} duration limit`)), mode === "code" ? this.services.limits.codeMs : this.services.limits.cellMs);
    result.state = "queued";
    job.done = (async () => {
      try {
        controller.signal.throwIfAborted(); result.state = "running";
        if (job.code) await job.code.run(result, code, context, controller.signal);
        else await this.notebook.run(result, code, context, controller.signal);
      } catch (error) { result.error = String(error); if (result.state !== "terminated") result.state = controller.signal.aborted ? "cancelled" : "failed"; }
      finally {
        clearTimeout(timer); signal?.removeEventListener("abort", abort);
        if (controller.signal.aborted && result.state !== "terminated") { result.state = "cancelled"; result.error = String(controller.signal.reason); }
        result.durationMs = Date.now() - Date.parse(result.startedAt);
        if (mode === "notebook") this.notebookBusy = false;
      }
    })();
    return this.wait(mode, executionId, yieldMs);
  }
  async wait(mode: Mode, executionId: string, ms = 1000, signal?: AbortSignal): Promise<ExecutionResult> {
    const job = this.get(mode, executionId);
    const abort = () => job.controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try {
      await boundedWait(job.done, Math.min(Math.max(0, ms), this.services.limits.waitMs));
      if (!isTerminal(job.result.state)) job.result.state = "yielded";
      return structuredClone(job.result);
    } finally { signal?.removeEventListener("abort", abort); }
  }
  private get(mode: Mode, id: string): Job {
    const job = this.jobs.get(id);
    if (!job || job.result.mode !== mode) throw new Error("Unknown execution for this session/mode (possibly expired)");
    return job;
  }
  async interrupt(mode: Mode, id: string, terminate = false): Promise<ExecutionResult> {
    const job = this.get(mode, id);
    if (isTerminal(job.result.state)) return structuredClone(job.result);
    if (terminate) job.result.state = "terminated";
    job.controller.abort(new Error(terminate ? "Terminated" : "Interrupted"));
    if (job.code) { if (terminate) await job.code.shutdown(); else await job.code.interrupt(); }
    else await this.notebook.interrupt();
    await boundedWait(job.done, this.services.limits.shutdownMs);
    return structuredClone(job.result);
  }
  async administer<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.accepting || this.notebookBusy) throw new Error("Notebook busy or disabled");
    this.notebookBusy = true;
    try { return await operation(); } finally { this.notebookBusy = false; }
  }
  status() { return { enabled: this.accepting, notebook: this.notebook.status(), executions: [...this.jobs.values()].map(({ result }) => ({ ...result, outputs: undefined, value: undefined })), background: this.background, limits: this.services.limits }; }
  async shutdown(): Promise<void> {
    this.accepting = false;
    for (const job of this.jobs.values()) if (!isTerminal(job.result.state)) job.controller.abort(new Error("Session shutdown"));
    await Promise.allSettled([...this.jobs.values()].map(job => job.code?.shutdown()));
    await this.notebook.shutdown();
    await boundedWait(Promise.allSettled([...this.jobs.values()].map(job => job.done)), this.services.limits.shutdownMs);
    await this.services.bridge.shutdown();
  }
}
