import type { Delegation, DelegationResource } from "../domain/types.ts";
import type { HerdrRequester } from "../herdr/topologies.ts";
import type { CommandRunner } from "./authority.ts";

export interface CleanupOptions {
  discardBranch?: boolean;
  preserveArtifacts?: boolean;
  onResource(resource: DelegationResource): void | Promise<void>;
}

export interface CleanupResult {
  removed: DelegationResource[];
  preserved: DelegationResource[];
}

export class CleanupBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CleanupBlockedError";
  }
}

export class DelegationCleanup {
  readonly #herdr: HerdrRequester;
  readonly #runner: CommandRunner;

  constructor(herdr: HerdrRequester, runner: CommandRunner) {
    this.#herdr = herdr;
    this.#runner = runner;
  }

  async cleanup(delegation: Delegation, options: CleanupOptions): Promise<CleanupResult> {
    const removed: DelegationResource[] = [];
    const preserved: DelegationResource[] = [];
    const resources = delegation.resources.filter((resource) => !resource.removedAt);
    const worktree = resources.find((resource) => resource.kind === "worktree");

    if (worktree?.path) {
      const status = await this.#runner.run(
        "git",
        ["status", "--porcelain=v1", "-uall"],
        worktree.path,
      );
      if (status.code !== 0 || status.stdout.trim()) {
        throw new CleanupBlockedError("Worktree is dirty; preserve, integrate or explicitly discard it first");
      }

      await this.#assertWorkspaceOwnership(worktree.id, delegation.id);
      await this.#herdr.request("worktree.remove", {
        workspace_id: worktree.id,
        force: false,
      }, { timeoutMs: 120_000 });
      for (const resource of resources.filter((item) =>
        ["process", "pane", "tab", "workspace", "worktree"].includes(item.kind),
      )) {
        const finished = { ...resource, removedAt: new Date().toISOString() };
        removed.push(finished);
        await options.onResource(finished);
      }
    }

    for (const resource of cleanupOrder(resources).filter((item) =>
      !worktree || !["process", "pane", "tab", "workspace", "worktree"].includes(item.kind),
    )) {
      if (!resource.createdByExtension || resource.ownershipToken !== delegation.resources[0]?.ownershipToken) {
        throw new CleanupBlockedError(`Resource ${resource.kind}:${resource.id} has no matching ownership`);
      }
      if (resource.kind === "artifact" && options.preserveArtifacts !== false) {
        const kept = { ...resource, preserved: true };
        preserved.push(kept);
        await options.onResource(kept);
        continue;
      }
      if (resource.kind === "process") continue;
      if (resource.kind === "pane") {
        await this.#assertPaneOwnership(resource, delegation.id);
        await ignoreMissing(() => this.#herdr.request("pane.close", { pane_id: resource.id }));
      } else if (resource.kind === "tab" && !worktree) {
        await ignoreMissing(() => this.#herdr.request("tab.close", { tab_id: resource.id }));
      } else if (resource.kind === "branch") {
        const args = ["branch", options.discardBranch ? "-D" : "-d", resource.id];
        const result = await this.#runner.run("git", args, delegation.request.cwd);
        if (result.code !== 0) {
          throw new CleanupBlockedError(
            `Branch ${resource.id} was not safely removed: ${result.stderr.trim() || result.stdout.trim()}`,
          );
        }
      } else if (resource.kind === "workspace" && !worktree) {
        await ignoreMissing(() => this.#herdr.request("workspace.close", { workspace_id: resource.id }));
      } else if (resource.kind === "artifact") {
        continue;
      }
      const finished = { ...resource, removedAt: new Date().toISOString() };
      removed.push(finished);
      await options.onResource(finished);
    }
    return { removed, preserved };
  }

  async #assertPaneOwnership(resource: DelegationResource, delegationId: string): Promise<void> {
    const result = await this.#herdr.request<{ pane?: { tokens?: Record<string, string> } }>(
      "pane.get",
      { pane_id: resource.id },
    );
    if (result.pane?.tokens?.delegation !== delegationId || result.pane.tokens.owner !== resource.ownershipToken.slice(0, 32)) {
      throw new CleanupBlockedError(`Pane ${resource.id} ownership metadata does not match`);
    }
  }

  async #assertWorkspaceOwnership(workspaceId: string, delegationId: string): Promise<void> {
    const result = await this.#herdr.request<{ workspace?: { tokens?: Record<string, string> } }>(
      "workspace.get",
      { workspace_id: workspaceId },
    );
    if (result.workspace?.tokens?.delegation !== delegationId) {
      throw new CleanupBlockedError(`Workspace ${workspaceId} ownership metadata does not match`);
    }
  }
}

function cleanupOrder(resources: DelegationResource[]): DelegationResource[] {
  const rank: Record<DelegationResource["kind"], number> = {
    process: 0,
    pane: 1,
    tab: 2,
    worktree: 3,
    branch: 4,
    workspace: 5,
    artifact: 6,
  };
  return [...resources].sort((left, right) => rank[left.kind] - rank[right.kind]);
}

async function ignoreMissing(operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : String(error);
    if (!message.includes("not found") && !message.includes("unknown")) throw error;
  }
}
