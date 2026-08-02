import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { DelegationService } from "../../src/domain/service.ts";
import {
  DelegationRepository,
  InMemoryDelegationStore,
  PiSessionDelegationStore,
} from "../../src/domain/store.ts";
import {
  LEGACY_HANDOFF_PROTOCOL_VERSION,
  LEGACY_STORE_CUSTOM_TYPE,
  type Delegation,
  type DelegationRequest,
} from "../../src/domain/types.ts";
import { createModelPolicyResolver, parseModelPolicy } from "../../src/models/policy.ts";
import {
  serializeManifest,
  sha256HexOf,
  type HandoffManifest,
} from "../../src/protocol/handoff.ts";

const repositories: DelegationRepository[] = [];

afterEach(async () => {
  const roots = repositories.splice(0).flatMap((repository) =>
    repository.listSessions().flatMap((session) => session.artifactRoots),
  );
  await Promise.all(roots.filter((root) => !root.durable).map((root) =>
    rm(root.path, { recursive: true, force: true }),
  ));
});

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

function service(available = { value: [
  { provider: "openai-codex", id: "gpt-5.6-luna", contextWindow: 200_000, input: ["text", "image"] as Array<"text" | "image"> },
  { provider: "openai-codex", id: "gpt-5.6-sol", contextWindow: 200_000, input: ["text", "image"] as Array<"text" | "image"> },
] }, options: {
  repository?: DelegationRepository;
  gitRoot?: (cwd: string) => string;
  gitStatus?: { value: string };
} = {}) {
  const repository = options.repository ?? new DelegationRepository(new InMemoryDelegationStore());
  repositories.push(repository);
  let paneSequence = 0;
  let tabSequence = 1;
  const paneLocations = new Map<string, { pane_id: string; tab_id: string; workspace_id: string }>([
    ["parent", { pane_id: "parent", tab_id: "t1", workspace_id: "w1" }],
  ]);
  const requestMock = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === "pane.split") {
      const target = paneLocations.get(String(params?.target_pane_id));
      const pane = {
        pane_id: `p${++paneSequence}`,
        tab_id: target?.tab_id ?? "t1",
        workspace_id: target?.workspace_id ?? "w1",
      };
      paneLocations.set(pane.pane_id, pane);
      return { type: "pane_info", pane };
    }
    if (method === "agent.start") {
      const pane = paneLocations.get(String(params?.pane_id))!;
      return { type: "agent_started", agent: { ...pane, agent_status: "idle", interactive_ready: true, agent_session: { agent: "pi", value: "/tmp/session.jsonl" } } };
    }
    if (method === "tab.create") {
      const tabId = `t${++tabSequence}`;
      const pane = { pane_id: `p${++paneSequence}`, tab_id: tabId, workspace_id: "w1" };
      paneLocations.set(pane.pane_id, pane);
      return {
        type: "tab_created",
        tab: { tab_id: tabId, workspace_id: "w1" },
        root_pane: pane,
      };
    }
    if (method === "worktree.create") {
      const pane = { pane_id: `p${++paneSequence}`, tab_id: "tw1", workspace_id: "ww1" };
      paneLocations.set(pane.pane_id, pane);
      return {
        type: "worktree_created",
        workspace: { workspace_id: "ww1" },
        tab: { tab_id: "tw1", workspace_id: "ww1" },
        root_pane: pane,
        worktree: { path: "/tmp/worktree", branch: params?.branch },
      };
    }
    if (method === "pane.get") {
      const session = repository.listSessions()[0];
      return {
        pane: {
          agent_status: "idle",
          tokens: session ? { delegation: session.ownershipId, owner: session.callbackToken.slice(0, 32) } : {},
        },
      };
    }
    if (method === "workspace.get") {
      const session = repository.listSessions()[0];
      return { workspace: { tokens: session ? { delegation: session.ownershipId } : {} } };
    }
    if (method === "pane.read") return { read: { text: "handoff evidence" } };
    return { type: "ok" };
  });
  const herdr = { request: requestMock } as never;
  const runner = {
    run: vi.fn(async (_command: string, args: string[], cwd: string) => ({
      stdout: args[0] === "rev-parse"
        ? `${options.gitRoot?.(cwd) ?? "/repo"}\n`
        : args[0] === "status" ? options.gitStatus?.value ?? "" : "",
      stderr: "",
      code: 0,
    })),
  };
  return {
    repository,
    requestMock,
    runner,
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
      availableModels: () => available.value,
      modelPolicy,
    }),
  };
}

async function publishManifest(repository: DelegationRepository, run: Delegation) {
  const session = repository.getSession(run.sessionId)!;
  const root = session.artifactRoots.find((item) => !item.durable)!;
  const cycleId = repository.get(run.id)!.handoff!.id!;
  const manifest: HandoffManifest = {
    protocolVersion: 1,
    cycleId,
    summary: "structured evidence",
    commands: ["npm test"],
    files: [],
    commits: [],
    risks: [],
    artifacts: [],
  };
  const bytes = serializeManifest(manifest);
  const manifestId = "manifest-1";
  const dir = join(root.path, run.id, cycleId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(join(root.path, run.id), 0o700);
  await chmod(dir, 0o700);
  const temporary = join(dir, ".manifest.tmp");
  await writeFile(temporary, bytes, { mode: 0o600 });
  await rename(temporary, join(dir, manifestId));
  return { manifest, manifestId, sha256: sha256HexOf(bytes), cycleId };
}

function markLegacyActive(repository: DelegationRepository, run: Delegation): Delegation {
  const legacy = { ...run, handoffProtocolVersion: LEGACY_HANDOFF_PROTOCOL_VERSION };
  repository.save(legacy, "transition");
  return legacy;
}

function markLegacyReviewable(
  repository: DelegationRepository,
  run: Delegation,
  extras: Partial<Delegation> = {},
): Delegation {
  const legacy: Delegation = {
    ...run,
    handoffProtocolVersion: LEGACY_HANDOFF_PROTOCOL_VERSION,
    state: "ready_for_review",
    handoff: undefined,
    ...extras,
  };
  repository.save(legacy, "transition");
  return legacy;
}

describe("DelegationService", () => {
  it("creates and launches a persisted delegation", async () => {
    const fixture = service();
    const delegation = await fixture.value.create(request());
    expect(delegation.state).toBe("working");
    expect(delegation.resources.some((resource) => resource.kind === "pane")).toBe(true);
    expect(delegation.resources).toContainEqual(expect.objectContaining({
      kind: "tab",
      id: "t2",
      shared: true,
    }));
    expect(delegation.resources.some((resource) =>
      resource.kind === "tab" && resource.id === "t1"
    )).toBe(false);
    expect(fixture.requestMock).toHaveBeenCalledWith(
      "agent.prompt",
      expect.objectContaining({ target: expect.stringMatching(/^task-/) }),
      expect.anything(),
    );
  });

  it("packs at most three clean-context subagents into each auxiliary tab", async () => {
    const fixture = service();
    const delegations = await Promise.all(
      Array.from({ length: 4 }, (_, index) => fixture.value.create({
        ...request(),
        name: `task-${index + 1}`,
        requiresCleanContext: true,
      })),
    );

    const panesByTab = new Map<string, number>();
    for (const delegation of delegations) {
      const tab = delegation.resources.find((resource) => resource.kind === "tab")!;
      expect(tab.id).not.toBe("t1");
      panesByTab.set(tab.id, (panesByTab.get(tab.id) ?? 0) + 1);
    }
    expect([...panesByTab.values()].sort()).toEqual([1, 3]);
    expect(fixture.requestMock.mock.calls.filter(([method]) => method === "tab.create")).toHaveLength(2);
    expect(fixture.requestMock.mock.calls.filter(([method]) => method === "pane.split")).toHaveLength(2);
  });

  it("requires inspection before parent acceptance", async () => {
    const fixture = service();
    const delegation = await fixture.value.create(request());
    markLegacyReviewable(fixture.repository, delegation);
    await expect(fixture.value.manage(delegation.id, "accept")).rejects.toThrow("Inspect evidence");
    await fixture.value.inspect(delegation.id);
    const accepted = await fixture.value.manage(delegation.id, "accept");
    expect(accepted).toMatchObject({ state: "accepted", health: undefined });
    expect(fixture.repository.getSession(delegation.sessionId)).toMatchObject({
      state: "idle",
      health: "idle",
      failure: undefined,
    });
  });

  it("validates a structured manifest without reading the pane transcript", async () => {
    const fixture = service();
    const run = await fixture.value.create(request());
    const claim = await publishManifest(fixture.repository, run);
    const paneId = run.resources.find((resource) => resource.kind === "pane")!.id;
    fixture.value.handleCallbackInput(
      `[HOLISTIC_HANDOFF_READY] delegation=${run.id} pane=${paneId} token=${run.callbackToken} cycle=${claim.cycleId} manifest=${claim.manifestId} sha256=${claim.sha256}`,
    );
    await fixture.value.onInfrastructureEvent({
      event: "pane.agent_status_changed",
      data: { pane_id: paneId, agent_status: "idle" },
    });

    const inspected = await fixture.value.inspect(run.id);

    expect(inspected.paneOutput).toBe("structured evidence");
    expect(inspected.delegation.handoff?.manifest).toEqual(claim.manifest);
    expect(inspected.delegation.acceptanceTicket).toMatchObject({
      cycleId: claim.cycleId,
      revision: run.revision,
      manifestSha256: claim.sha256,
      mutationSequence: fixture.repository.getSession(run.sessionId)!.mutationSequence,
    });
    expect(fixture.requestMock.mock.calls.some(([method]) => method === "pane.read")).toBe(false);
  });

  it("rejects an inspection result invalidated by a concurrent runtime event", async () => {
    const fixture = service();
    const run = await fixture.value.create(request());
    const claim = await publishManifest(fixture.repository, run);
    const paneId = run.resources.find((resource) => resource.kind === "pane")!.id;
    fixture.value.handleCallbackInput(
      `[HOLISTIC_HANDOFF_READY] delegation=${run.id} pane=${paneId} token=${run.callbackToken} cycle=${claim.cycleId} manifest=${claim.manifestId} sha256=${claim.sha256}`,
    );
    await fixture.value.onInfrastructureEvent({
      event: "pane.agent_status_changed",
      data: { pane_id: paneId, agent_status: "idle" },
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    fixture.requestMock.mockImplementationOnce(async () => {
      await gate;
      return {
        type: "pane_info",
        pane: { pane_id: paneId, tab_id: "t2", workspace_id: "w1" },
      };
    });

    const pending = fixture.value.inspect(run.id);
    await Promise.resolve();
    await fixture.value.onInfrastructureEvent({
      event: "pane.agent_status_changed",
      data: { pane_id: paneId, agent_status: "blocked" },
    });
    release();

    await expect(pending).rejects.toMatchObject({
      code: "STALE_SESSION_MUTATION",
      effectMayHaveOccurred: true,
    });
    expect(fixture.repository.get(run.id)?.acceptanceTicket).toBeUndefined();
  });

  it("does not inspect or ticket a handoff before the child agent settles", async () => {
    const fixture = service();
    const delegation = await fixture.value.create(request());
    markLegacyActive(fixture.repository, delegation);
    const paneId = delegation.resources.find((resource) => resource.kind === "pane")!.id;
    fixture.value.handleCallbackInput(
      `[HOLISTIC_HANDOFF_READY] delegation=${delegation.id} pane=${paneId} token=${delegation.callbackToken}`,
    );

    await expect(fixture.value.inspect(delegation.id)).rejects.toThrow("HANDOFF_CLAIM_PENDING");
    await expect(fixture.value.manage(delegation.id, "accept")).rejects.toThrow("HANDOFF_CLAIM_PENDING");
    expect(fixture.repository.get(delegation.id)?.acceptanceTicket).toBeUndefined();

    let confirmIdle!: () => void;
    const idleGate = new Promise<void>((resolve) => { confirmIdle = resolve; });
    fixture.requestMock.mockImplementationOnce(async (method: string) => {
      expect(method).toBe("pane.get");
      await idleGate;
      return { pane: { agent_status: "idle", tokens: {} } };
    });
    const delayedIdle = fixture.value.onInfrastructureEvent({
      event: "pane.agent_status_changed",
      data: { pane_id: paneId, agent_status: "idle" },
    });
    await Promise.resolve();
    await fixture.value.onInfrastructureEvent({
      event: "pane.agent_status_changed",
      data: { pane_id: paneId, agent_status: "working" },
    });
    confirmIdle();
    await expect(delayedIdle).rejects.toMatchObject({ code: "STALE_SESSION_MUTATION" });
    expect(fixture.repository.get(delegation.id)?.state).toBe("working");

    await fixture.value.onInfrastructureEvent({
      event: "pane.agent_status_changed",
      data: { pane_id: paneId, agent_status: "idle" },
    });
    const inspection = await fixture.value.inspect(delegation.id);
    expect(inspection).toMatchObject({
      paneOutput: "handoff evidence",
      delegation: { state: "ready_for_review" },
    });
    expect(inspection.delegation.acceptanceTicket).toBeDefined();
  });

  it("distinguishes a pending claim, a non-reviewable Run and stale inspection", async () => {
    const fixture = service();
    const delegation = await fixture.value.create(request());
    markLegacyActive(fixture.repository, delegation);
    const paneId = delegation.resources.find((resource) => resource.kind === "pane")!.id;

    await expect(fixture.value.manage(delegation.id, "accept")).rejects.toThrow("RUN_NOT_REVIEWABLE");
    fixture.value.handleCallbackInput(
      `[HOLISTIC_HANDOFF_READY] delegation=${delegation.id} pane=${paneId} token=${delegation.callbackToken}`,
    );
    await expect(fixture.value.manage(delegation.id, "accept")).rejects.toThrow("HANDOFF_CLAIM_PENDING");
    await fixture.value.onInfrastructureEvent({
      event: "pane.agent_status_changed",
      data: { pane_id: paneId, agent_status: "idle" },
    });
    await expect(fixture.value.manage(delegation.id, "accept")).rejects.toThrow("STALE_INSPECTION");
  });

  it("rejects inspection while the Run is still working", async () => {
    const fixture = service();
    const delegation = await fixture.value.create(request());

    await expect(fixture.value.inspect(delegation.id)).rejects.toThrow("RUN_NOT_REVIEWABLE");
    expect(fixture.repository.get(delegation.id)?.acceptanceTicket).toBeUndefined();
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

  it("rejects an unknown reviewOf before persisting or dispatching", async () => {
    const fixture = service();
    await expect(fixture.value.create({
      ...request(),
      name: "missing-review",
      reviewOf: "unknown-run",
    })).rejects.toThrow("Unknown delegation");
    expect(fixture.repository.list()).toEqual([]);
    expect(fixture.repository.listSessions()).toEqual([]);
    expect(fixture.requestMock.mock.calls.filter(([method]) => method === "agent.prompt")).toEqual([]);
  });

  it("reuses the MRU compatible warm Session and keeps the Run ID distinct", async () => {
    const fixture = service();
    const first = await fixture.value.create({ ...request(), requiresCleanContext: true });
    markLegacyReviewable(fixture.repository, first);
    await fixture.value.inspect(first.id);
    await fixture.value.manage(first.id, "accept");
    await new Promise((resolve) => setTimeout(resolve, 2));
    const second = await fixture.value.create({ ...request(), name: "second", requiresCleanContext: true });
    markLegacyReviewable(fixture.repository, second);
    await fixture.value.inspect(second.id);
    await fixture.value.manage(second.id, "accept");
    const third = await fixture.value.create({ ...request(), name: "third" });
    expect(third.id).not.toBe(second.id);
    expect(third.sessionId).toBe(second.sessionId);
    expect(third.sessionId).not.toBe(first.sessionId);
    expect(fixture.repository.listSessions()).toHaveLength(2);
    expect(fixture.requestMock).toHaveBeenLastCalledWith(
      "agent.prompt",
      expect.objectContaining({ text: expect.stringContaining(`delegation=${third.id}`) }),
      expect.objectContaining({ timeoutMs: 35_000 }),
    );
  });

  it("does not warm-reuse a legacy pane Session from the coordinator tab", async () => {
    const fixture = service();
    const first = await fixture.value.create(request());
    markLegacyReviewable(fixture.repository, first);
    await fixture.value.inspect(first.id);
    await fixture.value.manage(first.id, "accept");
    const session = fixture.repository.getSession(first.sessionId)!;
    fixture.repository.saveSession({
      ...session,
      resources: session.resources
        .filter((resource) => resource.kind !== "tab")
        .concat({
          kind: "tab",
          id: "t1",
          createdByExtension: true,
          ownershipToken: session.callbackToken,
        }),
    }, "resource");

    const next = await fixture.value.create({ ...request(), name: "outside-main-tab" });

    expect(next.sessionId).not.toBe(first.sessionId);
    expect(next.resources.find((resource) => resource.kind === "tab")?.id).not.toBe("t1");
  });

  it("requires a new Session for clean context and rejects cleanup while busy", async () => {
    const fixture = service();
    const first = await fixture.value.create(request());
    await expect(fixture.value.manage(first.id, "cleanup")).rejects.toThrow("SESSION_BUSY");
    markLegacyReviewable(fixture.repository, first);
    await fixture.value.inspect(first.id);
    await fixture.value.manage(first.id, "accept");
    const clean = await fixture.value.create({ ...request(), name: "clean", requiresCleanContext: true });
    expect(clean.sessionId).not.toBe(first.sessionId);
  });

  it("does not reuse a Session above its immutable authority ceiling", async () => {
    const fixture = service();
    const first = await fixture.value.create(request());
    markLegacyReviewable(fixture.repository, first);
    await fixture.value.inspect(first.id);
    await fixture.value.manage(first.id, "accept");
    const elevated = await fixture.value.create({
      ...request(), name: "write", authority: { mode: "controlled_mutation", allowedPaths: ["src"] },
    });
    expect(elevated.sessionId).not.toBe(first.sessionId);
  });

  it("starts a new Session when the fixed model is no longer eligible", async () => {
    const available = { value: [
      { provider: "openai-codex", id: "gpt-5.6-luna", contextWindow: 200_000, input: ["text", "image"] as Array<"text" | "image"> },
      { provider: "openai-codex", id: "gpt-5.6-sol", contextWindow: 200_000, input: ["text", "image"] as Array<"text" | "image"> },
    ] };
    const fixture = service(available);
    const first = await fixture.value.create(request());
    markLegacyReviewable(fixture.repository, first);
    await fixture.value.inspect(first.id);
    await fixture.value.manage(first.id, "accept");
    available.value = [available.value[1]!];
    const second = await fixture.value.create({ ...request(), name: "rerouted" });
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(second.modelResolution?.model).toBe("openai-codex/gpt-5.6-sol");
  });

  it("reuses a fixed model only when its translated thinking is unchanged", async () => {
    const fixture = service();
    const first = await fixture.value.create({ ...request(), model: { minimumCapability: "scoped", effort: "medium" } });
    markLegacyReviewable(fixture.repository, first);
    await fixture.value.inspect(first.id);
    await fixture.value.manage(first.id, "accept");

    const compatibleThinking = await fixture.value.create({
      ...request(),
      name: "same-thinking",
      model: { minimumCapability: "scoped", effort: "low" },
    });
    expect(compatibleThinking.modelResolution.thinking).toBe("xhigh");
    expect(compatibleThinking.sessionId).toBe(first.sessionId);
    markLegacyReviewable(fixture.repository, compatibleThinking);
    await fixture.value.inspect(compatibleThinking.id);
    await fixture.value.manage(compatibleThinking.id, "accept");

    const incompatibleThinking = await fixture.value.create({
      ...request(),
      name: "different-thinking",
      model: { minimumCapability: "scoped", effort: "max" },
    });
    expect(incompatibleThinking.modelResolution.thinking).toBe("max");
    expect(incompatibleThinking.sessionId).not.toBe(first.sessionId);
  });

  it("invalidates acceptance tickets and handoff latches after a correction", async () => {
    const fixture = service();
    const run = await fixture.value.create(request());
    markLegacyReviewable(fixture.repository, run, { health: "idle" });
    await fixture.value.inspect(run.id);
    fixture.requestMock.mockImplementationOnce(async (method: string) => {
      expect(method).toBe("agent.prompt");
      expect(fixture.repository.get(run.id)).toMatchObject({
        state: "working",
        health: "working",
        handoff: { id: expect.any(String) },
      });
      return { type: "ok" };
    });
    const correcting = await fixture.value.send(run.id, "fix it", { correction: true });
    expect(correcting).toMatchObject({
      state: "working",
      health: "working",
      handoff: { working: true },
    });
    const paneId = run.resources.find((resource) => resource.kind === "pane")!.id;
    const claimed = fixture.value.handleCallbackInput(
      `[HOLISTIC_HANDOFF_READY] delegation=${run.id} pane=${paneId} token=${run.callbackToken}`,
    );
    expect(claimed.delegation?.state).toBe("working");
    await fixture.value.onInfrastructureEvent({
      event: "pane.agent_status_changed",
      data: { pane_id: paneId, agent_status: "idle" },
    });
    await expect(fixture.value.manage(run.id, "accept")).rejects.toThrow("STALE_INSPECTION");
    await fixture.value.inspect(run.id);
    await fixture.value.manage(run.id, "accept");
    await expect(fixture.value.send(run.id, "more")).rejects.toThrow("holistic_create");
  });

  it("invalidates acceptance tickets and handoff latches after a follow-up", async () => {
    const fixture = service();
    const run = await fixture.value.create(request());
    markLegacyReviewable(fixture.repository, run, { health: "idle" });
    await fixture.value.inspect(run.id);

    const followedUp = await fixture.value.send(run.id, "Please add the command output.");

    expect(followedUp).toMatchObject({
      state: "working",
      revision: 2,
      acceptanceTicket: undefined,
      handoff: { working: true },
    });
    expect(fixture.requestMock).toHaveBeenLastCalledWith(
      "agent.prompt",
      expect.objectContaining({ wait: { until: ["working"], timeout_ms: 30_000 } }),
      expect.objectContaining({ timeoutMs: 35_000 }),
    );
  });

  it("fails the Run and Session when a pre-dispatch follow-up cannot be confirmed", async () => {
    const fixture = service();
    const run = await fixture.value.create(request());
    fixture.requestMock.mockImplementationOnce(async () => {
      throw new Error("socket disconnected");
    });

    await expect(fixture.value.send(run.id, "continue")).rejects.toThrow("socket disconnected");
    expect(fixture.repository.get(run.id)).toMatchObject({
      state: "failed",
      health: "failed",
      failure: expect.stringContaining("agent.prompt failed after starting revision 2"),
    });
    expect(fixture.repository.getSession(run.sessionId)).toMatchObject({
      state: "failed",
      activeRunId: undefined,
    });
  });

  it("cleans Session resources after its Run is terminal", async () => {
    const fixture = service();
    const run = await fixture.value.create(request());
    markLegacyReviewable(fixture.repository, run);
    await fixture.value.inspect(run.id);
    await fixture.value.manage(run.id, "accept");
    await fixture.value.manage(run.id, "cleanup");
    expect(fixture.repository.getSession(run.sessionId!)?.state).toBe("closed");
    expect(fixture.requestMock).toHaveBeenCalledWith("pane.close", { pane_id: "p1" });
  });

  it("rejects a delayed callback from the prior Run after warm reuse", async () => {
    const fixture = service();
    const first = await fixture.value.create(request());
    markLegacyReviewable(fixture.repository, first);
    await fixture.value.inspect(first.id);
    await fixture.value.manage(first.id, "accept");
    const second = await fixture.value.create({ ...request(), name: "second" });
    const pane = fixture.repository.getSession(second.sessionId)!.resources
      .find((resource) => resource.kind === "pane")!;
    expect(fixture.value.handleCallbackInput(
      `[HOLISTIC_HANDOFF_READY] delegation=${first.id} pane=${pane.id} token=${first.callbackToken}`,
    )).toMatchObject({ valid: false, reason: "delegation is not the active Run of its Session" });
    await expect(fixture.value.manage(first.id, "fail")).rejects.toThrow("RUN_NOT_ACTIVE");
    await expect(fixture.value.manage(first.id, "close")).rejects.toThrow("SESSION_BUSY");
    expect(fixture.repository.get(second.id)?.state).toBe("working");
  });

  it("quarantines a failed Session instead of returning it to the warm pool", async () => {
    const fixture = service();
    const failed = await fixture.value.create(request());
    await fixture.value.manage(failed.id, "fail", { reason: "uncertain dispatch" });
    expect(fixture.repository.getSession(failed.sessionId)?.state).toBe("failed");
    const next = await fixture.value.create({ ...request(), name: "replacement" });
    expect(next.sessionId).not.toBe(failed.sessionId);
  });

  it("uses canonical Git root as trust scope", async () => {
    const fixture = service(undefined, {
      gitRoot: (cwd) => cwd.startsWith("/other") ? "/other" : "/repo",
    });
    const first = await fixture.value.create({ ...request(), cwd: "/repo/packages/a" });
    markLegacyReviewable(fixture.repository, first);
    await fixture.value.inspect(first.id);
    await fixture.value.manage(first.id, "accept");
    const sameRoot = await fixture.value.create({ ...request(), name: "same-root", cwd: "/repo/packages/b" });
    expect(sameRoot.sessionId).not.toBe(first.sessionId);
    expect(sameRoot.request.cwd).toBe("/repo/packages/b");
    expect(sameRoot.runtimeCwd).toBe("/repo/packages/b");
    expect(fixture.requestMock).toHaveBeenLastCalledWith(
      "agent.prompt",
      expect.objectContaining({ text: expect.stringContaining("- cwd: /repo/packages/b") }),
      expect.anything(),
    );
    markLegacyReviewable(fixture.repository, sameRoot);
    await fixture.value.inspect(sameRoot.id);
    const auditCall = fixture.runner.run.mock.calls
      .filter(([, args]) => args[0] === "status")
      .at(-1);
    expect(auditCall?.[2]).toBe("/repo/packages/b");
    await fixture.value.manage(sameRoot.id, "accept");
    const otherRoot = await fixture.value.create({ ...request(), name: "other-root", cwd: "/other/app" });
    expect(otherRoot.sessionId).not.toBe(first.sessionId);
  });

  it("does not reuse across topologies", async () => {
    const fixture = service();
    const pane = await fixture.value.create(request());
    markLegacyReviewable(fixture.repository, pane);
    await fixture.value.inspect(pane.id);
    await fixture.value.manage(pane.id, "accept");
    const tab = await fixture.value.create({ ...request(), name: "tab", topology: "tab" });
    expect(tab.sessionId).not.toBe(pane.sessionId);
    const worktree = await fixture.value.create({
      ...request(),
      name: "worktree",
      topology: "worktree",
      authority: { mode: "isolated_mutation", allowedPaths: [] },
      baseRef: "main",
      branch: "agent/worktree",
    });
    expect(worktree.sessionId).not.toBe(tab.sessionId);
  });

  it("defers worktree warm reuse even with the same requested base and branch", async () => {
    const fixture = service();
    const worktreeRequest = {
      ...request(),
      name: "worktree-one",
      topology: "worktree" as const,
      authority: { mode: "isolated_mutation" as const, allowedPaths: [] },
      baseRef: "main",
      branch: "agent/worktree",
    };
    const first = await fixture.value.create(worktreeRequest);
    markLegacyReviewable(fixture.repository, first);
    await fixture.value.inspect(first.id);
    await fixture.value.manage(first.id, "accept");
    const second = await fixture.value.create({ ...worktreeRequest, name: "worktree-two" });
    expect(second.sessionId).not.toBe(first.sessionId);
  });

  it("reserves a warm Session before concurrent prompts", async () => {
    const fixture = service();
    const seed = await fixture.value.create(request());
    markLegacyReviewable(fixture.repository, seed);
    await fixture.value.inspect(seed.id);
    await fixture.value.manage(seed.id, "accept");
    const results = await Promise.allSettled([
      fixture.value.create({ ...request(), name: "left" }),
      fixture.value.create({ ...request(), name: "right" }),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(String((rejected[0] as PromiseRejectedResult).reason)).toContain("SESSION_BUSY");
    expect(fixture.repository.listSessions()).toHaveLength(1);
    const prompts = fixture.requestMock.mock.calls.filter(([method]) => method === "agent.prompt");
    expect(prompts).toHaveLength(2); // seed plus exactly one successful concurrent dispatch
  });

  it("never reuses resources adapted from a terminal v1 delegation", async () => {
    const legacy = {
      version: 1,
      eventId: "legacy-accepted",
      delegationId: "legacy-run",
      kind: "transition",
      at: "2026-01-01T00:00:00.000Z",
      snapshot: {
        version: 1,
        id: "legacy-run",
        parentSessionId: "s1",
        parentPaneId: "parent",
        callbackToken: "legacy-token",
        state: "accepted",
        purpose: "execution",
        reviewerIds: [],
        request: request(),
        modelResolution: modelPolicy.resolve(request().model, [
          { provider: "openai-codex", id: "gpt-5.6-luna", contextWindow: 200_000, input: ["text", "image"] },
        ]),
        resources: [{ kind: "pane", id: "legacy-pane", createdByExtension: true, ownershipToken: "legacy-token" }],
        questions: [],
        evidence: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    };
    const repository = new DelegationRepository(new PiSessionDelegationStore([
      { type: "custom", customType: LEGACY_STORE_CUSTOM_TYPE, data: legacy },
    ], () => undefined));
    const fixture = service(undefined, { repository });
    await fixture.value.manage("legacy-run", "cleanup");
    expect(fixture.requestMock).toHaveBeenCalledWith(
      "pane.close",
      { pane_id: "legacy-pane" },
    );
    const fresh = await fixture.value.create({ ...request(), name: "fresh-after-v1" });
    expect(fresh.sessionId).not.toBe("legacy-session-legacy-run");
    expect(repository.getSession("legacy-session-legacy-run")?.sealed).toBe(true);
  });

  it("cleans v1 resources using their original Herdr ownership identity", async () => {
    const legacyRequest = {
      ...request(),
      topology: "worktree" as const,
      authority: { mode: "isolated_mutation" as const, allowedPaths: [] },
    };
    const legacy = {
      version: 1,
      eventId: "legacy-worktree",
      delegationId: "legacy-owner",
      kind: "transition",
      at: "2026-01-01T00:00:00.000Z",
      snapshot: {
        version: 1,
        id: "legacy-owner",
        parentSessionId: "s1",
        parentPaneId: "parent",
        callbackToken: "legacy-token",
        state: "accepted",
        purpose: "execution",
        reviewerIds: [],
        request: legacyRequest,
        modelResolution: modelPolicy.resolve(legacyRequest.model, [
          { provider: "openai-codex", id: "gpt-5.6-luna", contextWindow: 200_000, input: ["text", "image"] },
        ]),
        resources: [
          { kind: "workspace", id: "legacy-workspace", createdByExtension: true, ownershipToken: "legacy-token" },
          { kind: "pane", id: "legacy-pane", createdByExtension: true, ownershipToken: "legacy-token" },
          { kind: "worktree", id: "legacy-workspace", path: "/tmp/legacy-worktree", createdByExtension: true, ownershipToken: "legacy-token" },
        ],
        questions: [],
        evidence: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    };
    const repository = new DelegationRepository(new PiSessionDelegationStore([
      { type: "custom", customType: LEGACY_STORE_CUSTOM_TYPE, data: legacy },
    ], () => undefined));
    const fixture = service(undefined, { repository });
    expect(repository.getSession("legacy-session-legacy-owner")?.ownershipId).toBe("legacy-owner");
    await fixture.value.manage("legacy-owner", "cleanup");
    expect(fixture.requestMock).toHaveBeenCalledWith(
      "workspace.get",
      { workspace_id: "legacy-workspace" },
    );
    expect(fixture.requestMock).toHaveBeenCalledWith(
      "worktree.remove",
      { workspace_id: "legacy-workspace", force: false },
      expect.anything(),
    );
  });

  it("cancels an active Run on close but keeps cleanup busy rejection", async () => {
    const fixture = service();
    const cleanupRun = await fixture.value.create(request());
    await expect(fixture.value.manage(cleanupRun.id, "cleanup")).rejects.toThrow("SESSION_BUSY");
    const closed = await fixture.value.manage(cleanupRun.id, "close", { reason: "stop now" });
    expect(closed).toMatchObject({ state: "cancelled", health: "failed", failure: "stop now" });
    expect(fixture.repository.getSession(cleanupRun.sessionId)?.state).toBe("closed");
  });

  it("does not issue an acceptance ticket for an authority violation", async () => {
    const gitStatus = { value: "" };
    const fixture = service(undefined, { gitStatus });
    const run = await fixture.value.create(request());
    markLegacyReviewable(fixture.repository, run);
    gitStatus.value = "?? violation.txt\n";
    const inspection = await fixture.value.inspect(run.id);
    expect(inspection.audit.ok).toBe(false);
    expect(inspection.delegation.acceptanceTicket).toBeUndefined();
    await expect(fixture.value.manage(run.id, "accept")).rejects.toThrow("STALE_INSPECTION");
  });
});
