import { describe, expect, it } from "vitest";

import { parseCallback } from "../../src/protocol/callback.ts";

describe("callback parser", () => {
  it("parses the three protocol markers", () => {
    expect(parseCallback(
      "[HOLISTIC_QUESTION] delegation=d1 pane=p1 token=t cycle=cycle-1 question=q1",
    )?.kind).toBe("question");
    expect(parseCallback(
      "[HOLISTIC_INPUT_REQUIRED] delegation=d1 pane=p1 token=t cycle=cycle-1 question=q2",
    )?.kind).toBe("input_required");
    expect(parseCallback(
      `[HOLISTIC_HANDOFF_READY] delegation=d1 pane=p1 token=t cycle=cycle-1 manifest=m1 sha256=${"a".repeat(64)}`,
    )?.kind).toBe("handoff_ready");
  });

  it("extracts identity, token, cycle and claim fields", () => {
    const parsed = parseCallback(
      `[HOLISTIC_HANDOFF_READY] delegation=d1 pane=p1 token=secret cycle=cycle-1 manifest=m1 sha256=${"a".repeat(64)}`,
    );
    expect(parsed).toMatchObject({
      delegationId: "d1",
      paneId: "p1",
      token: "secret",
      cycleId: "cycle-1",
      questionId: undefined,
      manifestId: "m1",
      manifestSha256: "a".repeat(64),
    });
  });

  it("returns undefined for non-callback text and missing required fields", () => {
    expect(parseCallback("plain agent output")).toBeUndefined();
    expect(parseCallback("[HOLISTIC_QUESTION] delegation=d1")).toBeUndefined();
    expect(parseCallback("[HOLISTIC_QUESTION] pane=p1 token=t")).toBeUndefined();
    expect(parseCallback("[HOLISTIC_QUESTION] delegation=d1 pane=p1")).toBeUndefined();
  });
});
