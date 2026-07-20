import { describe, expect, it, vi } from "vitest";

import { DelegationService } from "../../src/domain/service.ts";
import { DelegationRepository, InMemoryDelegationStore } from "../../src/domain/store.ts";
import type { DelegationRequest } from "../../src/domain/types.ts";

function request(): DelegationRequest {
  return {
    name: "task",
    mission: "Do work",
    cwd: "/repo",
    authority: { mode: "read_only", allowedPaths: [] },
    acceptanceEvidence: ["answer"],
    topology: "pane",
    model: { minimumCapability: "scoped", effort: "medium" },
  };
}

function service() {
  const repository = new DelegationRepository(new InMemoryDelegationStore());
  const requestMock = vi.fn(async (method: string) => {
    if (method === "agent.start") {
      return { type: "agent_started", agent: { pane_id: "p1", tab_id: "t1", workspace_id: "w1", agent_status: "idle" } };
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
      ],
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
      "pane.send_input",
      expect.objectContaining({ pane_id: "p1" }),
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
});
