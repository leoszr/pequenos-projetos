import { describe, expect, it } from "vitest";

import type { Delegation } from "../../src/domain/types.ts";
import { buildDelegationBrief } from "../../src/protocol/brief.ts";

function delegation(): Delegation {
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
    handoff: { id: "cycle-1" },
  };
}

describe("delegation brief", () => {
  it("builds a brief with non-blocking and blocking conversation", () => {
    const brief = buildDelegationBrief(delegation());
    expect(brief).toContain("HOLISTIC_QUESTION");
    expect(brief).toContain("HOLISTIC_INPUT_REQUIRED");
    expect(brief).toContain("HOLISTIC_HANDOFF_READY");
  });
});
