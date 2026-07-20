import { describe, expect, it } from "vitest";

import { DelegationRepository, InMemoryDelegationStore } from "../../src/domain/store.ts";
import type { Delegation } from "../../src/domain/types.ts";
import { buildDelegationBrief } from "../../src/protocol/brief.ts";
import { handleCallbackInput } from "../../src/protocol/callback.ts";

function fixture(): Delegation {
  return {
    version: 1,
    id: "d1",
    parentSessionId: "s1",
    parentPaneId: "parent",
    callbackToken: "secret-token",
    state: "working",
    purpose: "execution",
    reviewerIds: [],
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
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function repository() {
  const repo = new DelegationRepository(new InMemoryDelegationStore());
  repo.save(fixture(), "created");
  return repo;
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

  it("makes duplicate handoff callbacks idempotent", () => {
    const repo = repository();
    const signal = "[HOLISTIC_HANDOFF_READY] delegation=d1 pane=p1 token=secret-token";
    expect(handleCallbackInput(signal, repo).delegation?.state).toBe("ready_for_review");
    expect(handleCallbackInput(signal, repo).delegation?.state).toBe("ready_for_review");
  });
});
