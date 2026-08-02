import { describe, expect, it } from "vitest";

import { DelegationRepository, InMemoryDelegationStore } from "../../src/domain/store.ts";
import type { Delegation } from "../../src/domain/types.ts";
import { applyInfrastructureEvent, reconcileSnapshot } from "../../src/herdr/reconcile.ts";

function repo(): DelegationRepository {
  const repository = new DelegationRepository(new InMemoryDelegationStore());
  const delegation: Delegation = {
    version: 2,
    id: "d1",
    sessionId: "as1",
    parentSessionId: "s1",
    parentPaneId: "parent",
    callbackToken: "secret",
    state: "working",
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
      authority: { mode: "read_only", allowedPaths: [] },
      acceptanceEvidence: [],
      topology: "pane",
      model: { minimumCapability: "scoped", effort: "medium" },
    },
    resources: [{ kind: "pane", id: "p1", createdByExtension: true, ownershipToken: "owner-token" }],
    questions: [],
    evidence: [],
    revision: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  repository.saveSession({
    version: 2,
    id: delegation.sessionId,
    ownershipId: delegation.sessionId,
    parentSessionId: delegation.parentSessionId,
    parentPaneId: delegation.parentPaneId,
    state: "busy",
    activeRunId: delegation.id,
    trustScope: "/repo",
    authorityCeiling: delegation.request.authority,
    modelResolution: delegation.modelResolution,
    topology: delegation.request.topology,
    cwd: delegation.request.cwd,
    resources: delegation.resources,
    callbackToken: delegation.callbackToken,
    createdAt: delegation.createdAt,
    updatedAt: delegation.updatedAt,
    lastUsedAt: delegation.updatedAt,
  }, "created");
  repository.save(delegation, "created");
  return repository;
}

describe("Herdr reconciliation", () => {
  it("marks missing active panes as failed and finds orphans", () => {
    const repository = repo();
    const result = reconcileSnapshot(repository, {
    protocol: 17,
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

  it("routes warm-pane events only to the Session active Run", () => {
    const repository = repo();
    const first = repository.get("d1")!;
    repository.save({ ...first, state: "accepted", health: "completed" }, "transition");
    const second = {
      ...first,
      id: "d2",
      state: "working" as const,
      health: "working",
      createdAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    };
    repository.save(second, "created");
    const session = repository.getSession(first.sessionId)!;
    repository.saveSession({ ...session, activeRunId: second.id }, "transition");

    applyInfrastructureEvent(repository, {
      event: "pane.agent_status_changed",
      data: { pane_id: "p1", agent_status: "idle" },
    });
    expect(repository.get(first.id)).toMatchObject({ state: "accepted", health: "completed" });
    expect(repository.get(second.id)).toMatchObject({ state: "working", health: "idle" });

    applyInfrastructureEvent(repository, {
      event: "pane.exited",
      data: { pane_id: "p1", type: "pane.exited" },
    });
    expect(repository.get(first.id)?.state).toBe("accepted");
    expect(repository.get(second.id)?.state).toBe("failed");
  });
});
