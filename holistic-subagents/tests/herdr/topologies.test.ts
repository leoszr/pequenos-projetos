import { describe, expect, it, vi } from "vitest";

import {
  HerdrTopologyManager,
  type HerdrRequester,
  type LaunchSpec,
} from "../../src/herdr/topologies.ts";

function spec(topology: "pane" | "tab" | "worktree"): LaunchSpec {
  return {
    delegationId: "delegation-123456789",
    parentSessionId: "session-123456789",
    ownershipToken: "owner-token-123456789",
    name: "Implement cache",
    cwd: "/repo",
    topology,
    parentPaneId: "p-parent",
    parentWorkspaceId: "w-parent",
    parentTabId: "t-parent",
    argv: ["pi", "--model", "openai-codex/model"],
    env: { HOLISTIC_SUBAGENT_DEPTH: "1" },
    brief: "Do the work",
    onResource: vi.fn(),
  };
}

function requester(topology: "pane" | "tab" | "worktree") {
  const methods: string[] = [];
  const request = vi.fn(async (method: string) => {
    methods.push(method);
    if (method === "tab.create") {
      return {
        type: "tab_created",
        tab: { tab_id: "t-new", workspace_id: "w-parent" },
        root_pane: { pane_id: "p-root", tab_id: "t-new", workspace_id: "w-parent" },
      };
    }
    if (method === "worktree.create") {
      return {
        type: "worktree_created",
        workspace: { workspace_id: "w-new" },
        tab: { tab_id: "t-new", workspace_id: "w-new" },
        root_pane: { pane_id: "p-root", tab_id: "t-new", workspace_id: "w-new" },
        worktree: { path: "/repo-wt", branch: "agent/cache" },
      };
    }
    if (method === "pane.split") {
      return {
        type: "pane_info",
        pane: { pane_id: "p-agent", tab_id: "t-parent", workspace_id: "w-parent" },
      };
    }
    if (method === "agent.start") {
      return {
        type: "agent_started",
        agent: {
          pane_id: topology === "pane" ? "p-agent" : "p-root",
          tab_id: topology === "pane" ? "t-parent" : "t-new",
          workspace_id: topology === "worktree" ? "w-new" : "w-parent",
          agent_status: "idle",
          interactive_ready: true,
          agent_session: { agent: "pi", value: "/tmp/session.jsonl" },
        },
      };
    }
    return { type: "ok" };
  });
  return { request, methods } as unknown as HerdrRequester & { methods: string[] };
}

describe("HerdrTopologyManager", () => {
  it("starts a sibling pane and persists its ledger before dispatch", async () => {
    const client = requester("pane");
    const input = spec("pane");
    const result = await new HerdrTopologyManager(client).launch(input);
    expect(result.paneId).toBe("p-agent");
    expect(input.onResource).toHaveBeenCalledWith(expect.objectContaining({ kind: "pane" }));
    expect(client.methods.slice(0, 3)).toEqual(["pane.split", "pane.process_info", "agent.start"]);
    expect(client.methods.indexOf("agent.start")).toBeLessThan(client.methods.indexOf("agent.prompt"));
    expect(client.methods).toContain("pane.report_metadata");
    expect(client.request).toHaveBeenCalledWith(
      "agent.start",
      expect.objectContaining({ kind: "pi", pane_id: "p-agent", args: input.argv.slice(1) }),
      expect.anything(),
    );
  });

  it("creates a tab before starting Pi", async () => {
    const client = requester("tab");
    const input = spec("tab");
    const result = await new HerdrTopologyManager(client).launch(input);
    expect(result.tabId).toBe("t-new");
    expect(client.methods.slice(0, 3)).toEqual(["tab.create", "pane.process_info", "agent.start"]);
    expect(client.methods.filter((method) => method === "pane.report_metadata")).toHaveLength(1);
    expect(input.onResource).toHaveBeenCalledWith(expect.objectContaining({ kind: "tab", id: "t-new" }));
  });

  it("records every worktree resource and tags its workspace", async () => {
    const client = requester("worktree");
    const input = spec("worktree");
    const result = await new HerdrTopologyManager(client).launch(input);
    expect(result.cwd).toBe("/repo-wt");
    expect(result.resources.map((resource) => resource.kind)).toEqual([
      "workspace",
      "tab",
      "pane",
      "worktree",
      "branch",
      "process",
    ]);
    expect(client.methods).toContain("workspace.report_metadata");
    expect(client.methods).toContain("pane.wait_for_output");
  });

  it("preserves a nested cwd inside a worktree checkout", async () => {
    const client = requester("worktree");
    const input = { ...spec("worktree"), worktreeRelativeCwd: "holistic-subagents" };
    const result = await new HerdrTopologyManager(client).launch(input);
    expect(result.cwd).toBe("/repo-wt/holistic-subagents");
    expect(client.request).toHaveBeenCalledWith(
      "agent.start",
      expect.objectContaining({ kind: "pi", pane_id: "p-root" }),
      expect.anything(),
    );
    expect(result.cwd).toBe("/repo-wt/holistic-subagents");
  });
});
