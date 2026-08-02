import { describe, expect, it } from "vitest";

import {
  beginHandoffCycle,
  InvalidDelegationTransition,
  recordHandoffClaim,
  recordRuntimeStatus,
  transitionDelegation,
} from "../../src/domain/state-machine.ts";
import type { Delegation } from "../../src/domain/types.ts";

function fixture(state: Delegation["state"] = "prepared"): Delegation {
  return {
    version: 2,
    id: "d1",
    sessionId: "as1",
    parentSessionId: "s1",
    parentPaneId: "p1",
    callbackToken: "secret",
    state,
    purpose: "execution",
    reviewerIds: [],
    modelResolution: {
      model: "p/m", provider: "p", family: "f", thinking: "low",
      requestedCapability: "bounded", providedCapability: "bounded",
      degradedCapability: false, exactThinking: true, alternatives: [], reason: "test",
      requestedEffort: "low", effectiveEffort: "low", purpose: "execution",
    },
    request: {
      name: "test",
      mission: "Do the thing",
      cwd: "/tmp/project",
      authority: { mode: "read_only", allowedPaths: [] },
      acceptanceEvidence: ["answer"],
      topology: "pane",
      model: { minimumCapability: "bounded", effort: "low" },
    },
    resources: [],
    questions: [],
    evidence: [],
    revision: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("delegation state machine", () => {
  it("supports execution, input, correction and acceptance", () => {
    let value = fixture();
    for (const state of [
      "starting",
      "working",
      "awaiting_input",
      "working",
      "ready_for_review",
      "correcting",
      "working",
      "ready_for_review",
      "accepted",
    ] as const) {
      value = transitionDelegation(value, state);
    }
    expect(value.state).toBe("accepted");
  });

  it("treats repeated transitions as idempotent", () => {
    const value = fixture("working");
    expect(transitionDelegation(value, "working")).toBe(value);
  });

  it("rejects acceptance before review", () => {
    expect(() => transitionDelegation(fixture("working"), "accepted")).toThrow(
      InvalidDelegationTransition,
    );
  });

  it("does not let a prior cycle's settle promote a new handoff claim", () => {
    const started = recordRuntimeStatus(fixture("working"), "working");
    const settled = recordRuntimeStatus(started, "idle");
    const nextCycle = beginHandoffCycle(settled);
    const claimed = recordHandoffClaim(nextCycle);

    expect(settled).toMatchObject({ handoff: { working: true, settled: true } });
    expect(claimed).toMatchObject({
      state: "working",
      revision: started.revision + 1,
      handoff: { claimed: true },
    });
  });

  it("keeps a claim when a working status arrives late, then settles it", () => {
    const cycle = beginHandoffCycle(fixture("working"));
    const claimed = recordHandoffClaim(cycle);
    const lateWorking = recordRuntimeStatus(claimed, "working");
    const settled = recordRuntimeStatus(lateWorking, "idle");

    expect(lateWorking).toMatchObject({
      state: "working",
      revision: cycle.revision,
      handoff: { claimed: true, working: true },
    });
    expect(settled.state).toBe("ready_for_review");
  });

  it("does not let a late working status answer a blocking question", () => {
    const working = recordRuntimeStatus(fixture("working"), "working");
    const awaitingInput = transitionDelegation(working, "awaiting_input");

    const lateWorking = recordRuntimeStatus(awaitingInput, "working");

    expect(lateWorking).toMatchObject({
      state: "awaiting_input",
      health: "working",
      handoff: { working: true },
    });
  });
});
