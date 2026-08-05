import { describe, expect, it, vi } from "vitest";

import type { Delegation } from "../../src/domain/types.ts";
import { DelegationCleanup, CleanupBlockedError } from "../../src/security/cleanup.ts";

function delegation(): Delegation {
  return {
    version: 2,
    id: "d1",
    sessionId: "as1",
    parentSessionId: "s1",
    parentPaneId: "parent",
    callbackToken: "token",
    state: "accepted",
    purpose: "execution",
    reviewerIds: [],
    modelResolution: {
      model: "p/m", provider: "p", family: "f", thinking: "medium",
      requestedCapability: "scoped", providedCapability: "scoped",
      degradedCapability: false, exactThinking: true, alternatives: [], reason: "test",
      requestedEffort: "medium", effectiveEffort: "medium", purpose: "execution",
    },
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
    revision: 0,
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

  it("does not close a partial pane when ownership metadata is foreign", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "pane.get") {
        return { pane: { tokens: { delegation: "other-run", owner: "other-owner" } } };
      }
      return { type: "ok" };
    });
    const cleanup = new DelegationCleanup(
      { request } as never,
      { run: vi.fn(async () => ({ stdout: "", stderr: "", code: 0 })) },
    );
    const run = delegation();
    run.request = { ...run.request, topology: "tab", authority: { mode: "read_only", allowedPaths: [] } };
    run.resources = [
      { kind: "tab", id: "t-partial", createdByExtension: true, ownershipToken: "owner" },
      { kind: "pane", id: "p-partial", createdByExtension: true, ownershipToken: "owner" },
    ];

    await expect(cleanup.cleanup(run, { onResource: vi.fn() })).rejects.toBeInstanceOf(CleanupBlockedError);
    expect(request).not.toHaveBeenCalledWith("pane.close", expect.anything());
    expect(request).not.toHaveBeenCalledWith("tab.close", expect.anything());
  });

  it("closes a shared-tab pane without closing the shared tab", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "pane.get") {
        return { pane: { tokens: { delegation: "d1", owner: "owner" } } };
      }
      return { type: "ok" };
    });
    const cleanup = new DelegationCleanup(
      { request } as never,
      { run: vi.fn(async () => ({ stdout: "", stderr: "", code: 0 })) },
    );
    const run = delegation();
    run.request = { ...run.request, topology: "pane", authority: { mode: "read_only", allowedPaths: [] } };
    run.resources = [
      { kind: "pane", id: "p1", createdByExtension: true, ownershipToken: "owner" },
      { kind: "tab", id: "t-shared", createdByExtension: true, ownershipToken: "owner", shared: true },
    ];

    const result = await cleanup.cleanup(run, { onResource: vi.fn() });

    expect(request).toHaveBeenCalledWith("pane.close", { pane_id: "p1" });
    expect(request).not.toHaveBeenCalledWith("tab.close", expect.anything());
    expect(result.preserved).toContainEqual(expect.objectContaining({ kind: "tab", id: "t-shared" }));
  });
});
