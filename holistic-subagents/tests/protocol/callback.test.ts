import { describe, expect, it } from "vitest";

import { DelegationRepository, InMemoryDelegationStore } from "../../src/domain/store.ts";
import type { Delegation } from "../../src/domain/types.ts";
import { applyInfrastructureEvent } from "../../src/herdr/reconcile.ts";
import { buildDelegationBrief } from "../../src/protocol/brief.ts";
import { handleCallbackInput } from "../../src/protocol/callback.ts";

function fixture(): Delegation {
  return {
    version: 2,
    id: "d1",
    sessionId: "as1",
    parentSessionId: "s1",
    parentPaneId: "parent",
    callbackToken: "secret-token",
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
      mission: "Investigate",
      cwd: "/repo",
      authority: { mode: "read_only", allowedPaths: [] },
      acceptanceEvidence: ["evidence"],
      topology: "pane",
      model: { minimumCapability: "scoped", effort: "medium" },
    },
    resources: [{ kind: "pane", id: "p1", createdByExtension: true, ownershipToken: "owner" }],
    questions: [],
    evidence: [],
    revision: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function repository() {
  const repo = new DelegationRepository(new InMemoryDelegationStore());
  const run = fixture();
  repo.saveSession({
    version: 2,
    id: run.sessionId,
    ownershipId: run.sessionId,
    parentSessionId: run.parentSessionId,
    parentPaneId: run.parentPaneId,
    state: "busy",
    activeRunId: run.id,
    trustScope: "/repo",
    authorityCeiling: run.request.authority,
    modelResolution: run.modelResolution,
    topology: run.request.topology,
    cwd: run.request.cwd,
    resources: run.resources,
    callbackToken: run.callbackToken,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    lastUsedAt: run.updatedAt,
  }, "created");
  repo.save(run, "created");
  return repo;
}

function reportWorking(repo: DelegationRepository): void {
  applyInfrastructureEvent(repo, {
    event: "pane.agent_status_changed",
    data: { pane_id: "p1", agent_status: "working" },
  });
}

describe("parent/child protocol", () => {
  it("builds a brief with non-blocking and blocking conversation", () => {
    const brief = buildDelegationBrief(fixture());
    expect(brief).toContain("HOLISTIC_QUESTION");
    expect(brief).toContain("HOLISTIC_INPUT_REQUIRED");
    expect(brief).toContain("HOLISTIC_HANDOFF_READY");
  });

  it("records a non-blocking question without changing working", () => {
    const repo = repository();
    const result = handleCallbackInput(
      "[HOLISTIC_QUESTION] delegation=d1 pane=p1 token=secret-token question=q1",
      repo,
    );
    expect(result.valid).toBe(true);
    expect(result.delegation?.state).toBe("working");
    expect(result.delegation?.questions[0]).toMatchObject({ id: "q1", blocking: false });
  });

  it("starts a new cycle when a new question follows a settled handoff", () => {
    const repo = repository();
    const run = repo.get("d1")!;
    repo.save({
      ...run,
      state: "ready_for_review",
      health: "idle",
      handoff: { claimed: true, working: true, settled: true },
      acceptanceTicket: { token: "ticket", revision: 0, inspectedAt: run.updatedAt },
    }, "health");

    const result = handleCallbackInput(
      "[HOLISTIC_QUESTION] delegation=d1 pane=p1 token=secret-token question=q1",
      repo,
    );

    expect(result.delegation).toMatchObject({
      state: "working",
      revision: 1,
      acceptanceTicket: undefined,
      handoff: { working: true },
    });
  });

  it("settles a handoff after a non-blocking question in the same turn", () => {
    const repo = repository();
    const handoff = "[HOLISTIC_HANDOFF_READY] delegation=d1 pane=p1 token=secret-token";
    reportWorking(repo);

    handleCallbackInput(
      "[HOLISTIC_QUESTION] delegation=d1 pane=p1 token=secret-token question=q1",
      repo,
    );
    const claimed = handleCallbackInput(handoff, repo);
    const settled = applyInfrastructureEvent(repo, {
      event: "pane.agent_status_changed",
      data: { pane_id: "p1", agent_status: "idle" },
    });

    expect(claimed.delegation).toMatchObject({
      state: "working",
      revision: 1,
      handoff: { claimed: true, working: true },
    });
    expect(settled?.state).toBe("ready_for_review");
  });

  it("moves a blocking question to awaiting_input", () => {
    const result = handleCallbackInput(
      "[HOLISTIC_INPUT_REQUIRED] delegation=d1 pane=p1 token=secret-token question=q2",
      repository(),
    );
    expect(result.delegation?.state).toBe("awaiting_input");
  });

  it("authenticates token and pane ownership", () => {
    expect(
      handleCallbackInput(
        "[HOLISTIC_HANDOFF_READY] delegation=d1 pane=p1 token=wrong",
        repository(),
      ),
    ).toMatchObject({ matched: true, valid: false, reason: "invalid callback token" });
  });

  it("records an early handoff claim but waits for agent_settled", () => {
    const repo = repository();
    const signal = "[HOLISTIC_HANDOFF_READY] delegation=d1 pane=p1 token=secret-token";
    reportWorking(repo);
    const claimed = handleCallbackInput(signal, repo);
    expect(claimed.delegation).toMatchObject({
      state: "working",
      handoff: { claimed: true, working: true },
    });
    expect(claimed.delegation?.acceptanceTicket).toBeUndefined();

    const settled = applyInfrastructureEvent(repo, {
      event: "pane.agent_status_changed",
      data: { pane_id: "p1", agent_status: "idle" },
    });
    expect(settled?.state).toBe("ready_for_review");
  });

  it("makes a handoff reviewable when agent_settled was observed first", () => {
    const repo = repository();
    const handoff = "[HOLISTIC_HANDOFF_READY] delegation=d1 pane=p1 token=secret-token";

    reportWorking(repo);
    expect(applyInfrastructureEvent(repo, {
      event: "pane.agent_status_changed",
      data: { pane_id: "p1", agent_status: "idle" },
    })?.state).toBe("working");
    expect(handleCallbackInput(handoff, repo).delegation?.state).toBe("ready_for_review");
  });

  it("makes duplicate handoff and agent_settled status events idempotent", () => {
    const repo = repository();
    const handoff = "[HOLISTIC_HANDOFF_READY] delegation=d1 pane=p1 token=secret-token";
    const settled = {
      event: "pane.agent_status_changed",
      data: { pane_id: "p1", agent_status: "idle" },
    };
    reportWorking(repo);
    handleCallbackInput(handoff, repo);
    applyInfrastructureEvent(repo, settled);
    expect(handleCallbackInput(handoff, repo).delegation?.state).toBe("ready_for_review");
    expect(applyInfrastructureEvent(repo, settled)?.state).toBe("ready_for_review");
  });
});
