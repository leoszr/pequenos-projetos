import type {
  DelegationResource,
  DelegationTopology,
} from "../domain/types.ts";
import type { HerdrRequestOptions } from "./client.ts";
import { join } from "node:path";

export interface HerdrRequester {
  request<T = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
    options?: HerdrRequestOptions,
  ): Promise<T>;
}

export interface LaunchSpec {
  delegationId: string;
  parentSessionId: string;
  ownershipToken: string;
  name: string;
  cwd: string;
  topology: DelegationTopology;
  parentWorkspaceId: string;
  parentTabId: string;
  argv: string[];
  env: Record<string, string>;
  brief: string | ((cwd: string) => string);
  split?: "right" | "down";
  baseRef?: string;
  branch?: string;
  worktreeRelativeCwd?: string;
  startupTimeoutMs?: number;
  onResource(resource: DelegationResource): void | Promise<void>;
}

export interface LaunchResult {
  paneId: string;
  tabId: string;
  workspaceId: string;
  cwd: string;
  resources: DelegationResource[];
}

interface AgentInfo {
  pane_id: string;
  tab_id: string;
  workspace_id: string;
  agent_status?: string;
  cwd?: string | null;
}

interface AgentStartedResult {
  type: "agent_started";
  agent: AgentInfo;
}

interface TabCreatedResult {
  type: "tab_created";
  tab: { tab_id: string; workspace_id: string };
  root_pane: AgentInfo;
}

interface WorktreeCreatedResult {
  type: "worktree_created";
  workspace: { workspace_id: string };
  tab: { tab_id: string; workspace_id: string };
  root_pane: AgentInfo;
  worktree: { path: string; branch?: string | null };
}

const METADATA_SOURCE = "holistic-subagents";

export class HerdrTopologyManager {
  readonly #client: HerdrRequester;

  constructor(client: HerdrRequester) {
    this.#client = client;
  }

  async launch(spec: LaunchSpec, signal?: AbortSignal): Promise<LaunchResult> {
    const resources: DelegationResource[] = [];
    const add = async (
      resource: Omit<DelegationResource, "createdByExtension" | "ownershipToken">,
    ) => {
      if (resources.some((item) => item.kind === resource.kind && item.id === resource.id)) {
        return;
      }
      const owned: DelegationResource = {
        ...resource,
        createdByExtension: true,
        ownershipToken: spec.ownershipToken,
      };
      resources.push(owned);
      await spec.onResource(structuredClone(owned));
    };

    let targetWorkspaceId = spec.parentWorkspaceId;
    let targetTabId = spec.parentTabId;
    let targetCwd = spec.cwd;
    let initialPaneId: string | undefined;

    if (spec.topology === "tab") {
      const created = await this.#client.request<TabCreatedResult>(
        "tab.create",
        {
          workspace_id: spec.parentWorkspaceId,
          cwd: spec.cwd,
          label: spec.name,
          env: spec.env,
          focus: false,
        },
        { signal, timeoutMs: 30_000 },
      );
      targetWorkspaceId = created.tab.workspace_id;
      targetTabId = created.tab.tab_id;
      initialPaneId = created.root_pane.pane_id;
      await add({ kind: "tab", id: targetTabId, label: spec.name });
      await add({ kind: "pane", id: initialPaneId, label: spec.name });
    }

    if (spec.topology === "worktree") {
      const created = await this.#client.request<WorktreeCreatedResult>(
        "worktree.create",
        {
          cwd: spec.cwd,
          branch: spec.branch ?? `agent/${slug(spec.name)}-${spec.delegationId.slice(0, 8)}`,
          base: spec.baseRef ?? "HEAD",
          label: spec.name,
          focus: false,
        },
        { signal, timeoutMs: 120_000 },
      );
      targetWorkspaceId = created.workspace.workspace_id;
      targetTabId = created.tab.tab_id;
      targetCwd = spec.worktreeRelativeCwd
        ? join(created.worktree.path, spec.worktreeRelativeCwd)
        : created.worktree.path;
      initialPaneId = created.root_pane.pane_id;
      await add({ kind: "workspace", id: targetWorkspaceId, label: spec.name });
      await add({ kind: "tab", id: targetTabId, label: spec.name });
      await add({ kind: "pane", id: initialPaneId, label: spec.name });
      await add({
        kind: "worktree",
        id: targetWorkspaceId,
        path: created.worktree.path,
        label: spec.name,
      });
      if (created.worktree.branch) {
        await add({
          kind: "branch",
          id: created.worktree.branch,
          path: created.worktree.path,
        });
      }
    }

    const started = await this.#client.request<AgentStartedResult>(
      "agent.start",
      {
        name: spec.name,
        argv: spec.argv,
        cwd: targetCwd,
        env: spec.env,
        workspace_id: targetWorkspaceId,
        tab_id: targetTabId,
        split: spec.topology === "pane" ? (spec.split ?? "right") : null,
        focus: false,
      },
      { signal, timeoutMs: 30_000 },
    );
    const agent = started.agent;
    await add({ kind: "pane", id: agent.pane_id, label: spec.name });
    await add({ kind: "process", id: agent.pane_id, label: "pi" });

    for (const resource of resources.filter((item) => item.kind === "pane")) {
      await this.#tagPaneOwnership(resource.id, spec, signal);
    }
    if (spec.topology === "worktree") {
      await this.#tagWorkspaceOwnership(agent.workspace_id, spec, signal);
    }
    await this.#waitUntilReady(
      agent,
      spec.startupTimeoutMs ?? 90_000,
      signal,
    );
    await this.#client.request(
      "pane.send_input",
      {
        pane_id: agent.pane_id,
        text: typeof spec.brief === "function" ? spec.brief(targetCwd) : spec.brief,
        keys: ["enter"],
      },
      { signal },
    );
    await this.#client.request(
      "events.wait",
      {
        match_event: {
          event: "pane_agent_status_changed",
          pane_id: agent.pane_id,
          agent_status: "working",
        },
        timeout_ms: 30_000,
      },
      { signal, timeoutMs: 35_000 },
    );

    return {
      paneId: agent.pane_id,
      tabId: agent.tab_id,
      workspaceId: agent.workspace_id,
      cwd: targetCwd,
      resources: resources.map((resource) => structuredClone(resource)),
    };
  }

  async #tagPaneOwnership(
    paneId: string,
    spec: LaunchSpec,
    signal?: AbortSignal,
  ): Promise<void> {
    const tokens = {
      delegation: spec.delegationId,
      parent_session: spec.parentSessionId.slice(0, 32),
      owner: spec.ownershipToken.slice(0, 32),
    };
    await this.#client.request(
      "pane.report_metadata",
      {
        pane_id: paneId,
        source: METADATA_SOURCE,
        title: spec.name,
        tokens,
      },
      { signal },
    );
  }

  async #tagWorkspaceOwnership(
    workspaceId: string,
    spec: LaunchSpec,
    signal?: AbortSignal,
  ): Promise<void> {
    const tokens = {
      delegation: spec.delegationId,
      parent_session: spec.parentSessionId.slice(0, 32),
      owner: spec.ownershipToken.slice(0, 32),
    };
    await this.#client.request(
      "workspace.report_metadata",
      { workspace_id: workspaceId, source: METADATA_SOURCE, tokens },
      { signal },
    );
  }

  async #waitUntilReady(
    agent: AgentInfo,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (agent.agent_status !== "idle") {
      await this.#client.request(
        "events.wait",
        {
          match_event: {
            event: "pane_agent_status_changed",
            pane_id: agent.pane_id,
            agent_status: "idle",
          },
          timeout_ms: timeoutMs,
        },
        { signal, timeoutMs: timeoutMs + 2_000 },
      );
    }
    await this.#client.request(
      "pane.wait_for_output",
      {
        pane_id: agent.pane_id,
        source: "visible",
        lines: 80,
        match: {
          type: "regex",
          value: "Welcome back!|Type your message|ctrl\\+",
        },
        timeout_ms: timeoutMs,
      },
      { signal, timeoutMs: timeoutMs + 2_000 },
    );
  }
}

function slug(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32) || "task";
}
