import type {
  DelegationResource,
  DelegationTopology,
} from "../domain/types.ts";
import { HerdrRequestError, type HerdrRequestOptions } from "./client.ts";
import { randomUUID } from "node:crypto";
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
  parentPaneId: string;
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
  agent_session?: unknown;
  interactive_ready?: boolean;
  cwd?: string | null;
}

interface AgentStartedResult {
  type: "agent_started";
  agent: AgentInfo;
}

interface AgentInfoResult {
  type: "agent_info";
  agent: AgentInfo;
}

interface PaneCreatedResult {
  type: "pane_info";
  pane: AgentInfo;
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

    if (spec.topology === "pane") {
      const created = await this.#client.request<PaneCreatedResult>(
        "pane.split",
        {
          target_pane_id: spec.parentPaneId,
          direction: spec.split ?? "right",
          cwd: spec.cwd,
          env: spec.env,
          focus: false,
        },
        { signal, timeoutMs: 30_000 },
      );
      initialPaneId = created.pane.pane_id;
      targetTabId = created.pane.tab_id;
      targetWorkspaceId = created.pane.workspace_id;
      await add({ kind: "pane", id: initialPaneId, label: spec.name });
    }

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
      await this.#installEnvironment(initialPaneId, targetCwd, spec.env, signal);
    }

    if (!initialPaneId) throw new Error(`Unsupported Herdr topology: ${spec.topology}`);
    const [executable, ...args] = spec.argv;
    if (executable !== "pi") {
      throw new Error(`Unsupported Herdr agent executable: ${executable ?? "missing"}`);
    }
    const targetName = agentName(spec.name, spec.delegationId);
    const started = await this.#startAgent(
      initialPaneId,
      targetName,
      args,
      spec.startupTimeoutMs ?? 90_000,
      signal,
    );
    const agent = await this.#waitForIntegratedAgent(targetName, started.agent, signal);
    await add({ kind: "pane", id: agent.pane_id, label: spec.name });
    await add({ kind: "process", id: agent.pane_id, label: "pi" });

    for (const resource of resources.filter((item) => item.kind === "pane")) {
      await this.#tagPaneOwnership(resource.id, spec, signal);
    }
    if (spec.topology === "worktree") {
      await this.#tagWorkspaceOwnership(agent.workspace_id, spec, signal);
    }
    await this.#client.request(
      "agent.prompt",
      {
        target: targetName,
        text: typeof spec.brief === "function" ? spec.brief(targetCwd) : spec.brief,
        wait: { until: ["working"], timeout_ms: 30_000 },
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

  async #waitForIntegratedAgent(
    target: string,
    initial: AgentInfo,
    signal?: AbortSignal,
  ): Promise<AgentInfo> {
    if (initial.interactive_ready && initial.agent_session) return initial;
    // Herdr 0.7.5 can finish agent.start just before Pi's session hook report.
    // Bound this startup barrier; normal supervision remains event-driven.
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await delay(250, signal);
      const result = await this.#client.request<AgentInfoResult>(
        "agent.get",
        { target },
        { signal, timeoutMs: 5_000 },
      );
      if (result.agent.interactive_ready && result.agent.agent_session) return result.agent;
    }
    throw new Error(`Herdr agent ${target} did not publish an interactive Pi session`);
  }

  async #startAgent(
    paneId: string,
    name: string,
    args: string[],
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<AgentStartedResult> {
    // A freshly created pane can precede Herdr's foreground-shell snapshot.
    // Retry only that explicit transient; all other launch failures remain fatal.
    for (let attempt = 0; ; attempt += 1) {
      await this.#client.request(
        "pane.process_info",
        { pane_id: paneId },
        { signal, timeoutMs: 5_000 },
      );
      try {
        return await this.#client.request<AgentStartedResult>(
          "agent.start",
          { name, kind: "pi", pane_id: paneId, args, timeout_ms: timeoutMs },
          { signal, timeoutMs: timeoutMs + 2_000 },
        );
      } catch (error) {
        if (!(error instanceof HerdrRequestError) || error.code !== "agent_pane_busy" || attempt >= 19) {
          throw error;
        }
        await delay(100, signal);
      }
    }
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

  async #installEnvironment(
    paneId: string,
    cwd: string,
    env: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<void> {
    for (const key of Object.keys(env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        throw new Error(`Invalid child environment key: ${key}`);
      }
    }
    const marker = `HOLISTIC_ENV_READY_${randomUUID()}`;
    const exports = Object.entries(env)
      .map(([key, value]) => `${key}=${shellQuote(value)}`)
      .join(" ");
    await this.#client.request(
      "pane.send_input",
      {
        pane_id: paneId,
        text: `cd -- ${shellQuote(cwd)} && export ${exports} && printf '%s\\n' ${shellQuote(marker)}`,
        keys: ["enter"],
      },
      { signal },
    );
    await this.#client.request(
      "pane.wait_for_output",
      {
        pane_id: paneId,
        source: "recent_unwrapped",
        lines: 40,
        match: { type: "substring", value: marker },
        timeout_ms: 10_000,
      },
      { signal, timeoutMs: 12_000 },
    );
  }
}

function agentName(name: string, delegationId: string): string {
  const base = slug(name).slice(0, 20) || "task";
  return `${base}-${delegationId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8).toLowerCase()}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
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
