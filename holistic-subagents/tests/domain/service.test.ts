import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

import { DelegationService } from "../../src/domain/service.ts";
import { DelegationRepository, InMemoryDelegationStore } from "../../src/domain/store.ts";
import type { DelegationRequest } from "../../src/domain/types.ts";
import { createModelPolicyResolver, parseModelPolicy } from "../../src/models/policy.ts";

const modelPolicy = createModelPolicyResolver(parseModelPolicy(
  readFileSync(new URL("../../src/models/default-policy.json", import.meta.url), "utf8"),
));

function request(): DelegationRequest {
  return {
    name: "task",
    mission: "Do work",
    cwd: "/repo",
    authority: { mode: "read_only", allowedPaths: [] },
    acceptanceEvidence: ["answer"],
    topology: "pane",
    model: { minimumCapability: "scoped" },
  };
}

function service() {
  const repository = new DelegationRepository(new InMemoryDelegationStore());
  const requestMock = vi.fn(async (method: string) => {
    if (method === "pane.split") {
      return { type: "pane_info", pane: { pane_id: "p1", tab_id: "t1", workspace_id: "w1" } };
    }
    if (method === "agent.start") {
      return { type: "agent_started", agent: { pane_id: "p1", tab_id: "t1", workspace_id: "w1", agent_status: "idle", interactive_ready: true, agent_session: { agent: "pi", value: "/tmp/session.jsonl" } } };
    }
    if (method === "pane.get") return { pane: { tokens: {} } };
    if (method === "pane.read") return { read: { text: "handoff evidence" } };
    return { type: "ok" };
  });
  const herdr = { request: requestMock } as never;
  const runner = {
    run: vi.fn(async (_command: string, args: string[]) => ({
      stdout: args[0] === "rev-parse" ? "/repo\n" : "",
      stderr: "",
      code: 0,
    })),
  };
  return {
    repository,
    requestMock,
    value: new DelegationService({
      repository,
      herdr,
      runner,
      identity: {
        parentSessionId: "s1",
        parentPaneId: "parent",
        parentWorkspaceId: "w1",
        parentTabId: "t1",
      },
      availableModels: () => [
        { provider: "openai-codex", id: "gpt-5.6-luna", contextWindow: 200_000, input: ["text", "image"] },
        { provider: "openai-codex", id: "gpt-5.6-sol", contextWindow: 200_000, input: ["text", "image"] },
      ],
      modelPolicy,
    }),
  };
}

describe("DelegationService", () => {
  it("creates and launches a persisted delegation", async () => {
    const fixture = service();
    const delegation = await fixture.value.create(request());
    expect(delegation.state).toBe("working");
    expect(delegation.resources.some((resource) => resource.kind === "pane")).toBe(true);
    expect(fixture.requestMock).toHaveBeenCalledWith(
      "agent.prompt",
      expect.objectContaining({ target: expect.stringMatching(/^task-/) }),
      expect.anything(),
    );
  });

  it("requires inspection before parent acceptance", async () => {
    const fixture = service();
    const delegation = await fixture.value.create(request());
    fixture.repository.save({ ...delegation, state: "ready_for_review" }, "transition");
    await expect(fixture.value.manage(delegation.id, "accept")).rejects.toThrow("Inspect evidence");
    await fixture.value.inspect(delegation.id);
    expect((await fixture.value.manage(delegation.id, "accept")).state).toBe("accepted");
  });

  it("passes verification purpose to model routing", async () => {
    const fixture = service();
    const original = await fixture.value.create(request());
    const reviewer = await fixture.value.create({
      ...request(),
      name: "review",
      purpose: "verification",
      reviewOf: original.id,
    });
    expect(reviewer.modelResolution).toMatchObject({
      model: "openai-codex/gpt-5.6-sol",
      purpose: "verification",
      effectiveEffort: "medium",
    });
  });

  it("infers verification purpose when reviewOf is provided", async () => {
    const fixture = service();
    const original = await fixture.value.create(request());
    const reviewer = await fixture.value.create({
      ...request(),
      name: "review",
      reviewOf: original.id,
    });
    expect(reviewer).toMatchObject({
      purpose: "verification",
      request: { purpose: "verification", reviewOf: original.id },
      modelResolution: {
        model: "openai-codex/gpt-5.6-sol",
        purpose: "verification",
        effectiveEffort: "medium",
      },
    });
  });

  it("rejects reviewOf with an explicit execution purpose", async () => {
    const fixture = service();
    const original = await fixture.value.create(request());
    await expect(
      fixture.value.create({
        ...request(),
        name: "invalid-review",
        purpose: "execution",
        reviewOf: original.id,
      }),
    ).rejects.toThrow("reviewOf requires verification purpose");
  });
});
