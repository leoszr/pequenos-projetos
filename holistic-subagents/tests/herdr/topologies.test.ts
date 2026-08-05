import { describe, expect, it, vi } from "vitest";

import {
  HerdrTopologyManager,
  type HerdrRequester,
  type LaunchSpec,
} from "../../src/herdr/topologies.ts";
import { HerdrRequestError } from "../../src/herdr/client.ts";

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

function requester(topology: "pane" | "tab" | "worktree", failStartup = false, readyAfter = 0) {
  const methods: string[] = [];
  let agentGets = 0;
  const panes = new Map([
    ["p-parent", { pane_id: "p-parent", tab_id: "t-parent", workspace_id: "w-parent" }],
    ["p-anchor", { pane_id: "p-anchor", tab_id: "t-shared", workspace_id: "w-parent" }],
  ]);
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    methods.push(method);
    if (method === "tab.create") {
      const pane = { pane_id: "p-root", tab_id: "t-new", workspace_id: "w-parent" };
      panes.set(pane.pane_id, pane);
      return {
        type: "tab_created",
        tab: { tab_id: "t-new", workspace_id: "w-parent" },
        root_pane: pane,
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
      const target = panes.get(String(params?.target_pane_id));
      const pane = {
        pane_id: "p-agent",
        tab_id: target?.tab_id ?? "t-parent",
        workspace_id: target?.workspace_id ?? "w-parent",
      };
      panes.set(pane.pane_id, pane);
      return {
        type: "pane_info",
        pane,
      };
    }
    if (method === "agent.start") {
      if (failStartup) throw new HerdrRequestError("startup failed", "agent_start_failed");
      const pane = panes.get(String(params?.pane_id)) ?? {
        pane_id: "p-root",
        tab_id: "t-new",
        workspace_id: topology === "worktree" ? "w-new" : "w-parent",
      };
      return {
        type: "agent_started",
        agent: {
          ...pane,
          agent_status: "idle",
          ...(readyAfter === 0
            ? { interactive_ready: true, agent_session: { agent: "pi", value: "/tmp/session.jsonl" } }
            : {}),
        },
      };
    }
    if (method === "agent.get") {
      agentGets += 1;
      return {
        type: "agent_info",
        agent: {
          pane_id: "p-root",
          tab_id: "t-new",
          workspace_id: "w-parent",
          agent_status: "idle",
          ...(agentGets >= readyAfter
            ? { interactive_ready: true, agent_session: { agent: "pi", value: "/tmp/session.jsonl" } }
            : {}),
        },
      };
    }
    return { type: "ok" };
  });
  return { request, methods } as unknown as HerdrRequester & { methods: string[] };
}

describe("HerdrTopologyManager", () => {
  it("creates a shared auxiliary tab instead of splitting the coordinator tab", async () => {
    const client = requester("pane");
    const input = spec("pane");
    const result = await new HerdrTopologyManager(client).launch(input);
    expect(result.paneId).toBe("p-root");
    expect(result.tabId).toBe("t-new");
    expect(result.tabId).not.toBe(input.parentTabId);
    expect(input.onResource).toHaveBeenCalledWith(expect.objectContaining({ kind: "pane" }));
    expect(input.onResource).toHaveBeenCalledWith(expect.objectContaining({
      kind: "tab",
      id: "t-new",
      shared: true,
    }));
    expect(client.methods.slice(0, 4)).toEqual(["tab.create", "pane.report_metadata", "pane.process_info", "agent.start"]);
    expect(client.methods.indexOf("agent.start")).toBeLessThan(client.methods.indexOf("agent.prompt"));
    expect(client.methods).toContain("pane.report_metadata");
    expect(client.request).toHaveBeenCalledWith(
      "agent.start",
      expect.objectContaining({ kind: "pi", pane_id: "p-root", args: input.argv.slice(1) }),
      expect.anything(),
    );
  });

  it("splits an existing shared auxiliary tab", async () => {
    const client = requester("pane");
    const input = {
      ...spec("pane"),
      sharedTab: { tabId: "t-shared", anchorPaneId: "p-anchor" },
    };
    const result = await new HerdrTopologyManager(client).launch(input);
    expect(result).toMatchObject({ paneId: "p-agent", tabId: "t-shared" });
    expect(client.methods.slice(0, 4)).toEqual(["pane.split", "pane.report_metadata", "pane.process_info", "agent.start"]);
    expect(client.request).toHaveBeenCalledWith(
      "pane.split",
      expect.objectContaining({ target_pane_id: "p-anchor", focus: false }),
      expect.anything(),
    );
  });

  it("creates a tab before starting Pi", async () => {
    const client = requester("tab");
    const input = spec("tab");
    const result = await new HerdrTopologyManager(client).launch(input);
    expect(result.tabId).toBe("t-new");
    expect(client.methods.slice(0, 4)).toEqual(["tab.create", "pane.report_metadata", "pane.process_info", "agent.start"]);
    expect(client.methods.filter((method) => method === "pane.report_metadata")).toHaveLength(1);
    expect(input.onResource).toHaveBeenCalledWith(expect.objectContaining({ kind: "tab", id: "t-new" }));
  });

  it("records ownership before a startup failure can skip interactive_ready", async () => {
    const client = requester("tab", true);
    const input = spec("tab");

    await expect(new HerdrTopologyManager(client).launch(input)).rejects.toThrow("startup failed");

    expect(client.methods).toEqual([
      "tab.create",
      "pane.report_metadata",
      "pane.process_info",
      "agent.start",
    ]);
    expect(input.onResource).toHaveBeenCalledWith(expect.objectContaining({ kind: "tab", id: "t-new" }));
    expect(input.onResource).toHaveBeenCalledWith(expect.objectContaining({ kind: "pane", id: "p-root" }));
  });

  it("waits for the delayed Herdr session hook after agent.start", async () => {
    const client = requester("tab", false, 2);
    const result = await new HerdrTopologyManager(client).launch(spec("tab"));

    expect(result.paneId).toBe("p-root");
    expect(client.methods.filter((method) => method === "agent.get")).toHaveLength(2);
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
