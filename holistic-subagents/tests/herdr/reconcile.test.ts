import { describe, expect, it } from "vitest";

import { DelegationRepository, InMemoryDelegationStore } from "../../src/domain/store.ts";
import type { Delegation } from "../../src/domain/types.ts";
import { applyInfrastructureEvent, reconcileSnapshot } from "../../src/herdr/reconcile.ts";

function repo(): DelegationRepository {
  const repository = new DelegationRepository(new InMemoryDelegationStore());
  const delegation: Delegation = {
    version: 1,
    id: "d1",
    parentSessionId: "s1",
    parentPaneId: "parent",
    callbackToken: "secret",
    state: "working",
    purpose: "execution",
    reviewerIds: [],
    request: {
      name: "task",
      mission: "mission",
      cwd: "/repo",
      authority: { mode: "read_only", allowedPaths: [] },
      acceptanceEvidence: [],
      topology: "pane",
      model: { minimumCapability: "scoped", effort: "medium" },
    },
    resources: [{ kind: "pane", id: "p1", createdByExtension: true, ownershipToken: "owner-token" }],
    questions: [],
    evidence: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  repository.save(delegation, "created");
  return repository;
}

describe("Herdr reconciliation", () => {
  it("marks missing active panes as failed and finds orphans", () => {
    const repository = repo();
    const result = reconcileSnapshot(repository, {
      protocol: 16,
      panes: [{
        pane_id: "orphan",
        workspace_id: "w",
        tab_id: "t",
        agent_status: "idle",
        tokens: { delegation: "unknown" },
      }],
    });
    expect(repository.get("d1")?.state).toBe("failed");
    expect(result.orphanPaneIds).toEqual(["orphan"]);
  });

  it("updates health without interpreting idle as handoff", () => {
    const repository = repo();
    const updated = applyInfrastructureEvent(repository, {
      event: "pane.agent_status_changed",
      data: { pane_id: "p1", agent_status: "idle" },
    });
    expect(updated?.state).toBe("working");
    expect(updated?.health).toBe("idle");
  });
});
