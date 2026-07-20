import { describe, expect, it, vi } from "vitest";

import type { Delegation } from "../../src/domain/types.ts";
import { DelegationCleanup, CleanupBlockedError } from "../../src/security/cleanup.ts";

function delegation(): Delegation {
  return {
    version: 1,
    id: "d1",
    parentSessionId: "s1",
    parentPaneId: "parent",
    callbackToken: "token",
    state: "closing",
    purpose: "execution",
    reviewerIds: [],
    request: {
      name: "task",
      mission: "mission",
      cwd: "/repo",
      authority: { mode: "isolated_mutation", allowedPaths: ["src"] },
      acceptanceEvidence: [],
      topology: "worktree",
      model: { minimumCapability: "scoped", effort: "medium" },
    },
    resources: [
      { kind: "workspace", id: "w1", createdByExtension: true, ownershipToken: "owner" },
      { kind: "pane", id: "p1", createdByExtension: true, ownershipToken: "owner" },
      { kind: "worktree", id: "w1", path: "/wt", createdByExtension: true, ownershipToken: "owner" },
      { kind: "branch", id: "agent/task", path: "/wt", createdByExtension: true, ownershipToken: "owner" },
    ],
    questions: [],
    evidence: [],
    createdAt: "now",
    updatedAt: "now",
  };
}

describe("cleanup", () => {
  it("removes only resources with matching Herdr metadata", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "pane.get") return { pane: { tokens: { delegation: "d1", owner: "owner" } } };
      if (method === "workspace.get") return { workspace: { tokens: { delegation: "d1" } } };
      return { type: "ok" };
    });
    const onResource = vi.fn();
    const run = vi.fn(async () => ({ stdout: "", stderr: "", code: 0 }));
    const cleanup = new DelegationCleanup(
      { request } as never,
      { run },
    );
    const result = await cleanup.cleanup(delegation(), { onResource });
    expect(result.removed.map((resource) => resource.kind)).toContain("worktree");
    expect(request).toHaveBeenCalledWith(
      "worktree.remove",
      { workspace_id: "w1", force: false },
      { timeoutMs: 120_000 },
    );
    expect(run).toHaveBeenCalledWith("git", ["branch", "-d", "agent/task"], "/repo");
  });

  it("blocks dirty worktree cleanup", async () => {
    const cleanup = new DelegationCleanup(
      { request: vi.fn() } as never,
      { run: async () => ({ stdout: " M src/file.ts\n", stderr: "", code: 0 }) },
    );
    await expect(cleanup.cleanup(delegation(), { onResource: vi.fn() })).rejects.toBeInstanceOf(
      CleanupBlockedError,
    );
  });
});
