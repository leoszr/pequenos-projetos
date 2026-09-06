import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { KernelSession, type RuntimeServices } from "../execution/session.ts";
import { identityOf, type ExecutionResult } from "../execution/engine.ts";
import { codeModule } from "../execution/source.ts";
import { valueFrom } from "../execution/bootstrap.ts";
/** A fresh kernel and module per invocation. No live state crosses executions. */
export class CodeRuntime {
  readonly session: KernelSession;
  constructor(private services: RuntimeServices, onOutput?: ConstructorParameters<typeof KernelSession>[2]) {
    this.session = new KernelSession(services, "code", onOutput);
  }
  async run(record: ExecutionResult, code: string, context: ExtensionContext, signal: AbortSignal): Promise<void> {
    const file = join(this.services.cwd, `.pi-repl-code-${randomUUID()}.ts`);
    try {
      // The module lives directly in cwd so relative imports keep user-facing semantics.
      await writeFile(file, codeModule(code), { mode: 0o600, flag: "wx" });
      const result = await this.session.run(`await __repl.value(await (await import(${JSON.stringify(pathToFileURL(file).href)})).default()); await __repl.drain();`, identityOf(record), context, signal,
        value => record.outputs.push({ kind: "notification", data: { update: value }, origin: identityOf(record), attribution: "execution" }));
      record.value = valueFrom(result.outputs);
      record.state = result.status === "ok" ? "completed" : result.status === "cancelled" ? "cancelled" : "failed";
      record.error = result.error;
    } finally {
      await this.session.close();
      await rm(file, { force: true });
      record.cleanup = await this.services.registry.settle(record.executionId, this.services.limits.interruptMs) ? "completed" : "pending";
    }
  }
  async interrupt(): Promise<void> { await this.session.kernel.interrupt(); }
  async shutdown(): Promise<void> { await this.session.close(); }
}
