import { afterEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ArtifactStore } from "../../src/artifacts/store.ts";
import { HandoffCycle } from "../../src/domain/handoff-cycle.ts";
import { SessionMutations } from "../../src/domain/session-mutations.ts";
import {
  DelegationRepository,
  InMemoryDelegationStore,
} from "../../src/domain/store.ts";
import { captureAuthorityBaseline } from "../../src/security/authority.ts";
import type { AgentSession, Delegation } from "../../src/domain/types.ts";
import {
  serializeManifest,
  sha256HexOf,
  type ArtifactRef,
  type HandoffManifest,
} from "../../src/protocol/handoff.ts";

const rootPaths: string[] = [];

afterEach(async () => {
  await Promise.all(rootPaths.splice(0).map((path) =>
    rm(path, { recursive: true, force: true }),
  ));
});

function delegation(id = "d1", sessionId = "as1"): Delegation {
  return {
    version: 2,
    id,
    sessionId,
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
    revision: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    handoff: { id: "cycle-1" },
  };
}

function session(
  run: Delegation,
  root?: { id: string; path: string },
): AgentSession {
  return {
    version: 2,
    id: run.sessionId,
    ownershipId: run.sessionId,
    parentSessionId: run.parentSessionId,
    parentPaneId: run.parentPaneId,
    state: "busy",
    mutationSequence: 0,
    activeRunId: run.id,
    trustScope: "/repo",
    authorityCeiling: run.request.authority,
    modelResolution: run.modelResolution,
    topology: "pane",
    cwd: "/repo",
    resources: run.resources,
    artifactRoots: root
      ? [{
          id: root.id,
          path: root.path,
          durable: false,
          createdAt: "2026-01-01T00:00:00.000Z",
          ownershipToken: run.callbackToken,
        }]
      : [],
    callbackToken: run.callbackToken,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    lastUsedAt: run.updatedAt,
  };
}

interface Fixture {
  repository: DelegationRepository;
  cycle: HandoffCycle;
  requestMock: ReturnType<typeof vi.fn>;
  runner: { run: ReturnType<typeof vi.fn> };
  artifacts: ArtifactStore;
  root: { id: string; path: string };
  run: Delegation;
}

async function fixture(store = new InMemoryDelegationStore()): Promise<Fixture> {
  const repository = new DelegationRepository(store);
  const mutations = new SessionMutations(repository);
  const artifacts = new ArtifactStore();
  const requestMock = vi.fn(async () => ({ type: "ok", pane: { agent_status: "idle" } }));
  const runner = {
    run: vi.fn(async (_command: string, args: string[]) => ({
      stdout: args[0] === "rev-parse" ? "/repo\n" : "",
      stderr: "",
      code: 0,
    })),
  };
  const cycle = new HandoffCycle({ repository, mutations, herdr: { request: requestMock } as never, artifacts, runner });
  const root = await artifacts.createRoot("holistic-test");
  rootPaths.push(root.path);
  const authorityBaseline = await captureAuthorityBaseline(runner, "/repo");
  const run = { ...delegation(), authorityBaseline };
  if (repository.listSessions().length === 0) {
    repository.saveSession(session(run, root), "created");
    repository.save(run, "created");
  }
  return {
    repository,
    cycle,
    requestMock,
    runner,
    artifacts,
    root,
    run: repository.get("d1")!,
  };
}

async function writeArtifact(
  rootPath: string,
  runId: string,
  cycleId: string,
  id: string,
  data: Uint8Array,
): Promise<void> {
  const dir = join(rootPath, runId, cycleId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(join(rootPath, runId), 0o700);
  await chmod(dir, 0o700);
  const temporary = join(dir, `.tmp-${id}`);
  await writeFile(temporary, data, { mode: 0o600 });
  await rename(temporary, join(dir, id));
}

async function publishManifest(
  fx: Fixture,
  run: Delegation,
  manifestPatch: Partial<HandoffManifest> = {},
): Promise<{ manifest: HandoffManifest; manifestId: string; sha256: string; cycleId: string }> {
  const session = fx.repository.getSession(run.sessionId)!;
  const root = session.artifactRoots.find((item) => !item.durable)!;
  const cycleId = fx.repository.get(run.id)!.handoff!.id!;
  const manifest: HandoffManifest = {
    protocolVersion: 1,
    cycleId,
    summary: "structured evidence",
    commands: [],
    files: [],
    commits: [],
    risks: [],
    artifacts: [],
    ...manifestPatch,
  };
  const bytes = serializeManifest(manifest);
  const manifestId = "manifest-1";
  await writeArtifact(root.path, run.id, cycleId, manifestId, bytes);
  return { manifest, manifestId, sha256: sha256HexOf(bytes), cycleId };
}

async function markReviewable(
  fx: Fixture,
  run: Delegation,
  extras: Partial<Delegation> = {},
  manifestPatch: Partial<HandoffManifest> = {},
): Promise<Delegation> {
  const claim = await publishManifest(fx, run, manifestPatch);
  const reviewable: Delegation = {
    ...run,
    state: "ready_for_review",
    handoff: {
      id: claim.cycleId,
      claimed: true,
      working: true,
      settled: true,
      manifestId: claim.manifestId,
      manifestSha256: claim.sha256,
    },
    ...extras,
  };
  fx.repository.save(reviewable, "transition");
  return reviewable;
}

function claimSignal(run: Delegation, overrides: Record<string, string> = {}): string {
  return `[HOLISTIC_HANDOFF_READY] delegation=${run.id} pane=${overrides.pane ?? "p1"} token=${overrides.token ?? run.callbackToken} cycle=${overrides.cycle ?? run.handoff!.id} manifest=${overrides.manifest ?? "m1"} sha256=${overrides.sha256 ?? "a".repeat(64)}`;
}

function idleEvent(paneId = "p1") {
  return { event: "pane.agent_status_changed", data: { pane_id: paneId, agent_status: "idle" } };
}

function workingEvent(paneId = "p1") {
  return { event: "pane.agent_status_changed", data: { pane_id: paneId, agent_status: "working" } };
}

function doneEvent(paneId = "p1") {
  return { event: "pane.agent_status_changed", data: { pane_id: paneId, agent_status: "done" } };
}

describe("HandoffCycle > callback authentication", () => {
  it("authenticates token, pane and cycle and rejects invalid signals", async () => {
    const fx = await fixture();

    expect(fx.cycle.handleCallbackInput(claimSignal(fx.run))).toMatchObject({
      matched: true,
      valid: true,
    });
    expect(fx.cycle.handleCallbackInput(claimSignal(fx.run, { token: "wrong" }))).toMatchObject({
      valid: false,
      reason: "invalid callback token",
    });
    expect(fx.cycle.handleCallbackInput(claimSignal(fx.run, { pane: "p2" }))).toMatchObject({
      valid: false,
      reason: "pane is not owned by delegation",
    });
    expect(fx.cycle.handleCallbackInput(claimSignal(fx.run, { cycle: "cycle-9" }))).toMatchObject({
      valid: false,
      reason: expect.stringContaining("stale"),
    });
    expect(fx.cycle.handleCallbackInput(claimSignal(fx.run, { manifest: "", sha256: "" })))
      .toMatchObject({ valid: false, reason: "structured handoff claim is incomplete" });
    expect(fx.cycle.handleCallbackInput(
      `[HOLISTIC_HANDOFF_READY] delegation=unknown pane=p1 token=x cycle=cycle-1 manifest=m1 sha256=${"a".repeat(64)}`,
    )).toMatchObject({ valid: false, reason: "unknown delegation" });

    const second = {
      ...fx.run,
      id: "d2",
      state: "working" as const,
      updatedAt: "2026-01-02T00:00:00.000Z",
    };
    fx.repository.save(second, "created");
    fx.repository.saveSession(
      { ...fx.repository.getSession("as1")!, activeRunId: "d2" },
      "transition",
    );
    expect(fx.cycle.handleCallbackInput(claimSignal(fx.run))).toMatchObject({
      valid: false,
      reason: "delegation is not the active Run of its Session",
    });
  });

  it("records questions and blocks on input_required", async () => {
    const fx = await fixture();
    const question = fx.cycle.handleCallbackInput(
      "[HOLISTIC_QUESTION] delegation=d1 pane=p1 token=secret-token cycle=cycle-1 question=q1",
    );
    expect(question.valid).toBe(true);
    expect(question.delegation).toMatchObject({
      state: "working",
      questions: [{ id: "q1", blocking: false }],
    });

    const blocked = fx.cycle.handleCallbackInput(
      "[HOLISTIC_INPUT_REQUIRED] delegation=d1 pane=p1 token=secret-token cycle=cycle-1 question=q2",
    );
    expect(blocked.delegation?.state).toBe("awaiting_input");

    await fx.cycle.onInfrastructureEvent(workingEvent());
    expect(fx.repository.get("d1")).toMatchObject({
      state: "awaiting_input",
      health: "working",
      handoff: { working: true },
    });
  });
});

describe("HandoffCycle > claim and settled correlation", () => {
  it("claims a handoff before agent_settled and waits for idle", async () => {
    const fx = await fixture();
    await fx.cycle.onInfrastructureEvent(workingEvent());
    const claimed = fx.cycle.handleCallbackInput(claimSignal(fx.run));
    expect(claimed.delegation).toMatchObject({
      state: "working",
      handoff: { claimed: true, working: true },
    });
    expect(claimed.delegation?.acceptanceTicket).toBeUndefined();
    await expect(fx.cycle.inspect("d1")).rejects.toThrow("HANDOFF_CLAIM_PENDING");

    const settled = await fx.cycle.onInfrastructureEvent(idleEvent());
    expect(settled?.state).toBe("ready_for_review");
  });

  it("promotes a claim that arrives after settlement", async () => {
    const fx = await fixture();
    await fx.cycle.onInfrastructureEvent(workingEvent());
    expect((await fx.cycle.onInfrastructureEvent(idleEvent()))?.state).toBe("working");
    const claimed = fx.cycle.handleCallbackInput(claimSignal(fx.run));
    expect(claimed.delegation?.state).toBe("ready_for_review");
  });

  it("correlates a late working status after a claim, then settles", async () => {
    const fx = await fixture();
    const claimed = fx.cycle.handleCallbackInput(claimSignal(fx.run));
    expect(claimed.delegation).toMatchObject({ state: "working", revision: 1 });
    await fx.cycle.onInfrastructureEvent(workingEvent());
    expect(fx.repository.get("d1")).toMatchObject({
      state: "working",
      revision: 1,
      handoff: { claimed: true, working: true },
    });
    const settled = await fx.cycle.onInfrastructureEvent(idleEvent());
    expect(settled?.state).toBe("ready_for_review");
  });

  it("makes duplicate claims and idle events idempotent", async () => {
    const fx = await fixture();
    await fx.cycle.onInfrastructureEvent(workingEvent());
    fx.cycle.handleCallbackInput(claimSignal(fx.run));
    await fx.cycle.onInfrastructureEvent(idleEvent());
    const sequence = fx.repository.getSession("as1")!.mutationSequence;

    expect(fx.cycle.handleCallbackInput(claimSignal(fx.run)).delegation?.state)
      .toBe("ready_for_review");
    expect((await fx.cycle.onInfrastructureEvent(idleEvent()))?.state).toBe("ready_for_review");
    expect(fx.repository.getSession("as1")!.mutationSequence).toBe(sequence);
  });

  it("settles a claimed handoff on a done status correlated with working", async () => {
    const fx = await fixture();
    fx.requestMock.mockResolvedValue({ type: "ok", pane: { agent_status: "done" } });
    await fx.cycle.onInfrastructureEvent(workingEvent());
    fx.cycle.handleCallbackInput(claimSignal(fx.run));

    const settled = await fx.cycle.onInfrastructureEvent(doneEvent());
    expect(settled).toMatchObject({ state: "ready_for_review", health: "done" });
    expect(settled?.handoff).toMatchObject({ claimed: true, working: true, settled: true });
  });

  it("settles on done before the claim and promotes when the claim arrives", async () => {
    const fx = await fixture();
    fx.requestMock.mockResolvedValue({ type: "ok", pane: { agent_status: "done" } });
    await fx.cycle.onInfrastructureEvent(workingEvent());

    const settled = await fx.cycle.onInfrastructureEvent(doneEvent());
    expect(settled).toMatchObject({ state: "working", health: "done" });
    expect(settled?.handoff?.settled).toBe(true);

    const claimed = fx.cycle.handleCallbackInput(claimSignal(fx.run));
    expect(claimed.delegation?.state).toBe("ready_for_review");
  });

  it("does not settle a done status without observed working", async () => {
    const fx = await fixture();
    fx.requestMock.mockResolvedValue({ type: "ok", pane: { agent_status: "done" } });
    fx.cycle.handleCallbackInput(claimSignal(fx.run));

    const updated = await fx.cycle.onInfrastructureEvent(doneEvent());
    expect(updated).toMatchObject({ state: "working", health: "done" });
    expect(updated?.handoff?.settled).toBeUndefined();
    expect(updated?.handoff?.working).toBeUndefined();
  });

  it("does not settle an event done whose live read is working", async () => {
    const fx = await fixture();
    fx.requestMock.mockResolvedValue({ type: "ok", pane: { agent_status: "working" } });
    await fx.cycle.onInfrastructureEvent(workingEvent());
    fx.cycle.handleCallbackInput(claimSignal(fx.run));

    const updated = await fx.cycle.onInfrastructureEvent(doneEvent());
    expect(updated).toMatchObject({ state: "working", health: "working" });
    expect(updated?.handoff?.settled).toBeUndefined();
  });

  it("never settles on blocked or unknown runtime status", async () => {
    const fx = await fixture();
    await fx.cycle.onInfrastructureEvent(workingEvent());
    fx.cycle.handleCallbackInput(claimSignal(fx.run));

    await fx.cycle.onInfrastructureEvent({
      event: "pane.agent_status_changed",
      data: { pane_id: "p1", agent_status: "blocked" },
    });
    await fx.cycle.onInfrastructureEvent({
      event: "pane.agent_status_changed",
      data: { pane_id: "p1", agent_status: "unknown" },
    });
    expect(fx.repository.get("d1")).toMatchObject({ state: "working" });
    expect(fx.repository.get("d1")?.handoff?.settled).toBeUndefined();
  });
});

describe("HandoffCycle > new cycle and ticket invalidation", () => {
  it("begins the first cycle for a prepared Run: generates the id and moves to starting", async () => {
    const fx = await fixture();
    const prepared = {
      ...fx.run,
      id: "d2",
      state: "prepared" as const,
      handoff: undefined,
    };

    const started = fx.cycle.begin(prepared);
    expect(started).toMatchObject({ id: "d2", state: "starting", revision: 1 });
    expect(started.handoff?.id).toBeTruthy();
    // Transformação pura: o módulo não persiste nada; o caller grava o run
    // resultante no mesmo commit de criação da Session.
    expect(fx.repository.get("d2")).toBeUndefined();
  });

  it("associates a reviewer, bumps the revision and invalidates the ticket", async () => {
    const fx = await fixture();
    const reviewed = await markReviewable(fx, fx.run);
    await fx.cycle.inspect(reviewed.id);
    expect(fx.repository.get("d1")?.acceptanceTicket).toBeDefined();

    const reviewer = {
      ...fx.run,
      id: "d-review",
      sessionId: "as-review",
      state: "working" as const,
      createdAt: "2026-01-03T00:00:00.000Z",
      updatedAt: "2026-01-03T00:00:00.000Z",
    };
    fx.repository.saveSession(session(reviewer), "created");
    fx.repository.save(reviewer, "created");

    const updated = fx.cycle.attachReviewer("d1", "d-review");
    expect(updated).toMatchObject({ revision: 2, reviewerIds: ["d-review"] });
    expect(fx.repository.get("d1")?.acceptanceTicket).toBeUndefined();

    fx.cycle.attachReviewer("d1", "d-review");
    expect(fx.repository.get("d1")?.reviewerIds).toEqual(["d-review"]);
    expect(fx.repository.get("d1")?.revision).toBe(3);
    expect(() => fx.cycle.attachReviewer("unknown", "d-review")).toThrow(
      "Unknown delegation: unknown",
    );
  });

  it("skips reviewer association when the reviewed Run is no longer active", async () => {
    const fx = await fixture();
    const gone = {
      ...fx.run,
      id: "gone",
      sessionId: "as-gone",
      state: "prepared" as const,
      createdAt: "2026-01-03T00:00:00.000Z",
      updatedAt: "2026-01-03T00:00:00.000Z",
    };
    fx.repository.saveSession(session(gone), "created");
    fx.repository.save(gone, "created");
    fx.repository.save({ ...gone, state: "cancelled", health: "failed" }, "transition");
    fx.repository.saveSession(
      { ...fx.repository.getSession("as-gone")!, activeRunId: undefined, state: "idle" },
      "transition",
    );

    expect(fx.cycle.attachReviewer("gone", "d1")).toBeUndefined();
  });

  it("invalidates the previous ticket and latches on a new cycle", async () => {
    const fx = await fixture();
    const run = await markReviewable(fx, fx.run);
    const inspected = await fx.cycle.inspect(run.id);
    expect(inspected.delegation.acceptanceTicket).toMatchObject({
      cycleId: "cycle-1",
      revision: 1,
    });
    const oldCycle = fx.repository.get(run.id)!.handoff!.id!;

    const next = await fx.cycle.dispatch(run.id, "Please add the command output.");
    expect(next).toMatchObject({
      state: "working",
      revision: 2,
      acceptanceTicket: undefined,
    });
    expect(next.handoff?.working).toBeUndefined();
    expect(next.handoff?.dispatchPending).toBeUndefined();
    expect(next.handoff!.id).not.toBe(oldCycle);
    expect(fx.cycle.handleCallbackInput(claimSignal(fx.run, { cycle: oldCycle })).reason)
      .toContain("stale");
    await fx.cycle.onInfrastructureEvent(workingEvent());

    const claim = await publishManifest(fx, fx.repository.get(run.id)!);
    const claimed = fx.cycle.handleCallbackInput(
      `[HOLISTIC_HANDOFF_READY] delegation=${run.id} pane=p1 token=${run.callbackToken} cycle=${claim.cycleId} manifest=${claim.manifestId} sha256=${claim.sha256}`,
    );
    expect(claimed.delegation?.state).toBe("working");
    await fx.cycle.onInfrastructureEvent(idleEvent());
    expect(() => fx.cycle.accept(run.id)).toThrow("STALE_INSPECTION");
    await fx.cycle.inspect(run.id);
    expect(fx.cycle.accept(run.id).state).toBe("accepted");
  });

  it("keeps the Run uncertain when a dispatch cannot be confirmed", async () => {
    const fx = await fixture();
    fx.requestMock.mockImplementationOnce(async () => {
      throw new Error("socket disconnected");
    });

    await expect(fx.cycle.dispatch("d1", "continue")).rejects.toThrow("socket disconnected");
    expect(fx.requestMock).toHaveBeenCalledWith("agent.prompt", expect.not.objectContaining({
      wait: expect.anything(),
    }), expect.anything());
    const uncertain = fx.repository.get("d1")!;
    expect(uncertain).toMatchObject({
      state: "working",
      health: "dispatch_uncertain",
      handoff: { effectMayHaveOccurred: true },
      failure: expect.stringContaining("agent.prompt failed after starting revision 2"),
    });
    expect(uncertain.handoff?.dispatchPending).toBeUndefined();
    expect(fx.repository.getSession("as1")).toMatchObject({
      state: "busy",
      activeRunId: "d1",
    });
    await expect(fx.cycle.dispatch("d1", "retry")).rejects.toThrow("HANDOFF_RECONCILIATION_REQUIRED");
  });

  it("does not record working or settle from a follow-up ack alone", async () => {
    const fx = await fixture();
    const next = await fx.cycle.dispatch("d1", "continue");
    expect(next.state).toBe("working");
    expect(next.handoff?.working).toBeUndefined();
    expect(next.handoff?.settled).toBeUndefined();
    expect(next.handoff?.dispatchPending).toBeUndefined();

    const afterIdle = await fx.cycle.onInfrastructureEvent(idleEvent());
    expect(afterIdle?.state).toBe("working");
    expect(afterIdle?.health).toBe("idle");
    expect(afterIdle?.handoff?.working).toBeUndefined();
    expect(afterIdle?.handoff?.settled).toBeUndefined();
  });

  it("keeps an uncertain dispatch blocked without conclusive evidence", async () => {
    const fx = await fixture();
    fx.requestMock.mockRejectedValueOnce(new Error("request timeout"));
    await expect(fx.cycle.dispatch("d1", "continue")).rejects.toThrow("request timeout");

    // Correlate the owned pane with its session tab/workspace resources so
    // the metadata checks are the only remaining gate.
    const session = fx.repository.getSession("as1")!;
    fx.repository.saveSession({
      ...session,
      resources: [
        { kind: "pane", id: "p1", createdByExtension: true, ownershipToken: "owner" },
        { kind: "tab", id: "t", createdByExtension: true, ownershipToken: "owner" },
        { kind: "workspace", id: "w", createdByExtension: true, ownershipToken: "owner" },
      ],
    }, "transition");

    const completePane = {
      pane_id: "p1",
      workspace_id: "w",
      tab_id: "t",
      agent_status: "idle" as const,
      tokens: { owner: "owner", delegation: "as1" },
    };
    const withSnapshot = (panes: unknown[]) => {
      fx.requestMock.mockImplementationOnce(async (method: string) =>
        method === "session.snapshot"
          ? { snapshot: { protocol: 19, panes } }
          : { type: "ok", pane: { agent_status: "idle" } },
      );
    };
    // Pane present with complete metadata, but no claim: still uncertain.
    withSnapshot([completePane]);
    await expect(fx.cycle.reconcileDispatch("d1")).rejects.toThrow("HANDOFF_RECONCILIATION_REQUIRED");
    // Pane missing from the snapshot: rejected.
    withSnapshot([]);
    await expect(fx.cycle.reconcileDispatch("d1")).rejects.toThrow("HANDOFF_RECONCILIATION_REQUIRED");
    // Incomplete ownership (no owner token): rejected.
    withSnapshot([{ ...completePane, tokens: undefined }]);
    await expect(fx.cycle.reconcileDispatch("d1")).rejects.toThrow("HANDOFF_RECONCILIATION_REQUIRED");
    // Divergent ownership: rejected.
    withSnapshot([{ ...completePane, tokens: { owner: "other" } }]);
    await expect(fx.cycle.reconcileDispatch("d1")).rejects.toThrow("HANDOFF_RECONCILIATION_REQUIRED");
    // Incomplete delegation metadata: rejected.
    withSnapshot([{ ...completePane, tokens: { owner: "owner" } }]);
    await expect(fx.cycle.reconcileDispatch("d1")).rejects.toThrow("HANDOFF_RECONCILIATION_REQUIRED");
    // Divergent delegation metadata: rejected.
    withSnapshot([{ ...completePane, tokens: { owner: "owner", delegation: "other" } }]);
    await expect(fx.cycle.reconcileDispatch("d1")).rejects.toThrow("HANDOFF_RECONCILIATION_REQUIRED");
    // Session tab/workspace resources diverged from the pane: rejected.
    fx.repository.saveSession({
      ...fx.repository.getSession("as1")!,
      resources: [
        { kind: "pane", id: "p1", createdByExtension: true, ownershipToken: "owner" },
        { kind: "tab", id: "other-tab", createdByExtension: true, ownershipToken: "owner" },
        { kind: "workspace", id: "w", createdByExtension: true, ownershipToken: "owner" },
      ],
    }, "transition");
    withSnapshot([completePane]);
    await expect(fx.cycle.reconcileDispatch("d1")).rejects.toThrow("HANDOFF_RECONCILIATION_REQUIRED");

    expect(fx.repository.get("d1")?.handoff?.effectMayHaveOccurred).toBe(true);
    await expect(fx.cycle.dispatch("d1", "retry")).rejects.toThrow("HANDOFF_RECONCILIATION_REQUIRED");
  });

  it("releases an uncertain dispatch on a conclusive claim with complete metadata", async () => {
    const fx = await fixture();
    fx.requestMock.mockRejectedValueOnce(new Error("request timeout"));
    await expect(fx.cycle.dispatch("d1", "continue")).rejects.toThrow("request timeout");

    const uncertain = fx.repository.get("d1")!;
    const claim = await publishManifest(fx, uncertain);
    // Persist the conclusive claim alongside the uncertainty (crash/reload
    // edge); the claim proves the child received the follow-up.
    fx.repository.save({
      ...uncertain,
      handoff: {
        ...uncertain.handoff,
        claimed: true,
        manifestId: claim.manifestId,
        manifestSha256: claim.sha256,
      },
    }, "transition");
    const session = fx.repository.getSession("as1")!;
    fx.repository.saveSession({
      ...session,
      resources: [
        { kind: "pane", id: "p1", createdByExtension: true, ownershipToken: "owner" },
        { kind: "tab", id: "t", createdByExtension: true, ownershipToken: "owner" },
        { kind: "workspace", id: "w", createdByExtension: true, ownershipToken: "owner" },
      ],
    }, "transition");

    fx.requestMock.mockImplementationOnce(async (method: string) =>
      method === "session.snapshot"
        ? {
            snapshot: {
              protocol: 19,
              panes: [{
                pane_id: "p1",
                workspace_id: "w",
                tab_id: "t",
                agent_status: "idle",
                tokens: { owner: "owner", delegation: "as1" },
              }],
            },
          }
        : { type: "ok", pane: { agent_status: "idle" } },
    );
    const reconciled = await fx.cycle.reconcileDispatch("d1");
    expect(reconciled.handoff?.effectMayHaveOccurred).toBeUndefined();
    expect(reconciled.handoff?.dispatchPending).toBeUndefined();
    expect(reconciled.handoff?.claimed).toBe(true);
    expect(fx.repository.get("d1")?.health).toBe("idle");

    const redelivered = await fx.cycle.dispatch("d1", "follow-up after recovery");
    expect(redelivered.handoff?.effectMayHaveOccurred).toBeUndefined();
  });

  it("clears uncertainty only on a conclusive claim for the current cycle", async () => {
    const fx = await fixture();
    fx.requestMock.mockRejectedValueOnce(new Error("request timeout"));
    await expect(fx.cycle.dispatch("d1", "continue")).rejects.toThrow("request timeout");
    expect(fx.repository.get("d1")?.handoff?.effectMayHaveOccurred).toBe(true);

    const claim = await publishManifest(fx, fx.repository.get("d1")!);
    const claimed = fx.cycle.handleCallbackInput(
      `[HOLISTIC_HANDOFF_READY] delegation=d1 pane=p1 token=secret-token cycle=${claim.cycleId} manifest=${claim.manifestId} sha256=${claim.sha256}`,
    );
    expect(claimed.valid).toBe(true);
    expect(claimed.delegation?.handoff?.effectMayHaveOccurred).toBeUndefined();
    expect(fx.repository.get("d1")?.handoff?.effectMayHaveOccurred).toBeUndefined();

    const redelivered = await fx.cycle.dispatch("d1", "follow-up after conclusive claim");
    expect(redelivered.handoff?.effectMayHaveOccurred).toBeUndefined();
  });
});

describe("HandoffCycle > dispatch concurrency", () => {
  it("persists an in-flight guard and rejects a concurrent dispatch without I/O", async () => {
    const fx = await fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    fx.requestMock.mockImplementation(async (method: string) => {
      if (method === "agent.prompt") await gate;
      return { type: "ok", pane: { agent_status: "idle" } };
    });

    const first = fx.cycle.dispatch("d1", "first");
    await Promise.resolve();
    await expect(fx.cycle.dispatch("d1", "second")).rejects.toThrow("DISPATCH_IN_PROGRESS");
    release();

    await expect(first).resolves.toMatchObject({
      state: "working",
      handoff: { id: expect.any(String) },
    });
    const prompts = fx.requestMock.mock.calls.filter(([method]) => method === "agent.prompt");
    expect(prompts).toHaveLength(1);
    expect(fx.repository.get("d1")?.handoff?.dispatchPending).toBeUndefined();
  });

  it("keeps a stale dispatch uncertain unless conclusive evidence was persisted", async () => {
    const fx = await fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    fx.requestMock.mockImplementation(async (method: string) => {
      if (method === "agent.prompt") await gate;
      return { type: "ok", pane: { agent_status: "idle" } };
    });

    const pending = fx.cycle.dispatch("d1", "continue");
    await Promise.resolve();
    await fx.cycle.onInfrastructureEvent(workingEvent());
    release();

    await expect(pending).rejects.toMatchObject({
      code: "STALE_SESSION_MUTATION",
      effectMayHaveOccurred: true,
    });
    const stale = fx.repository.get("d1")!;
    expect(stale).toMatchObject({
      state: "working",
      health: "dispatch_uncertain",
      revision: 2,
      handoff: { working: true, effectMayHaveOccurred: true },
    });
    expect(stale.handoff?.dispatchPending).toBeUndefined();
    expect(stale.failure).toContain("delivery is uncertain");
    expect(fx.repository.getSession("as1")).toMatchObject({
      state: "busy",
      health: "dispatch_uncertain",
      activeRunId: "d1",
    });
    await expect(fx.cycle.dispatch("d1", "retry")).rejects.toThrow("HANDOFF_RECONCILIATION_REQUIRED");
  });

  it("does not mark a stale dispatch uncertain when conclusive evidence was persisted", async () => {
    const fx = await fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    fx.requestMock.mockImplementation(async (method: string) => {
      if (method === "agent.prompt") await gate;
      return { type: "ok", pane: { agent_status: "idle" } };
    });

    const pending = fx.cycle.dispatch("d1", "continue");
    await Promise.resolve();
    const claim = await publishManifest(fx, fx.repository.get("d1")!);
    const claimed = fx.cycle.handleCallbackInput(
      `[HOLISTIC_HANDOFF_READY] delegation=d1 pane=p1 token=secret-token cycle=${claim.cycleId} manifest=${claim.manifestId} sha256=${claim.sha256}`,
    );
    expect(claimed.valid).toBe(true);
    release();

    await expect(pending).rejects.toMatchObject({
      code: "STALE_SESSION_MUTATION",
      effectMayHaveOccurred: true,
    });
    const after = fx.repository.get("d1")!;
    expect(after.handoff?.effectMayHaveOccurred).toBeUndefined();
    expect(after.handoff?.claimed).toBe(true);
    expect(after.handoff?.dispatchPending).toBeUndefined();
    expect(after.failure).toBeUndefined();
  });
});

describe("HandoffCycle > inspection integrity", () => {
  it("loads the manifest, verifies artifact refs and issues a ticket", async () => {
    const fx = await fixture();
    const run = fx.repository.get("d1")!;
    const root = fx.repository.getSession(run.sessionId)!.artifactRoots[0]!;
    const bytes = Buffer.from("abc");
    await writeArtifact(root.path, run.id, "cycle-1", "art-1", bytes);
    const ref: ArtifactRef = {
      id: "art-1",
      rootId: root.id,
      mediaType: "text/plain",
      size: 3,
      sha256: sha256HexOf(bytes),
    };
    const reviewable = await markReviewable(fx, run, {}, { artifacts: [ref] });

    const inspected = await fx.cycle.inspect(reviewable.id);
    expect(inspected.paneOutput).toBe("structured evidence");
    expect(inspected.delegation.handoff?.manifest).toMatchObject({
      cycleId: "cycle-1",
      artifacts: [ref],
    });
    expect(inspected.delegation.acceptanceTicket).toMatchObject({
      cycleId: "cycle-1",
      revision: 1,
      manifestSha256: reviewable.handoff?.manifestSha256,
      mutationSequence: fx.repository.getSession("as1")!.mutationSequence,
    });
  });

  it("rejects a tampered manifest", async () => {
    const fx = await fixture();
    const run = await markReviewable(fx, fx.run);
    const root = fx.repository.getSession(run.sessionId)!.artifactRoots[0]!;
    await writeArtifact(root.path, run.id, "cycle-1", "manifest-1", Buffer.from("tampered"));

    await expect(fx.cycle.inspect(run.id)).rejects.toMatchObject({ code: "HASH_MISMATCH" });
    expect(fx.repository.get(run.id)?.acceptanceTicket).toBeUndefined();
  });

  it("rejects a manifest whose cycle does not match the active cycle", async () => {
    const fx = await fixture();
    const run = await markReviewable(fx, fx.run, {}, { cycleId: "other-cycle" });

    await expect(fx.cycle.inspect(run.id)).rejects.toThrow(
      "INVALID_HANDOFF_MANIFEST: manifest cycle does not match",
    );
  });

  it("rejects artifacts from unregistered roots and above total size limits", async () => {
    const fx = await fixture();
    const run = await markReviewable(fx, fx.run, {}, {
      artifacts: [{
        id: "art-1",
        rootId: "unknown-root",
        mediaType: "text/plain",
        size: 3,
        sha256: "a".repeat(64),
      }],
    });
    await expect(fx.cycle.inspect(run.id)).rejects.toThrow(
      "INVALID_HANDOFF_MANIFEST: unregistered artifact root unknown-root",
    );

    const oversized = await markReviewable(fx, fx.run, {}, {
      artifacts: [{
        id: "art-1",
        rootId: fx.root.id,
        mediaType: "text/plain",
        size: 64 * 1024 * 1024 + 1,
        sha256: "a".repeat(64),
      }],
    });
    await expect(fx.cycle.inspect(oversized.id)).rejects.toThrow(
      "INVALID_HANDOFF_MANIFEST: total artifact size exceeds limit",
    );
  });

  it("rejects an oversized manifest and a missing manifest file", async () => {
    const fx = await fixture();
    const oversized = await markReviewable(
      fx,
      fx.run,
      {},
      { summary: "x".repeat(100_001) },
    );
    await expect(fx.cycle.inspect(oversized.id)).rejects.toThrow("invalid HandoffManifest");

    const missing = await markReviewable(fx, fx.run);
    const root = fx.repository.getSession(missing.sessionId)!.artifactRoots[0]!;
    await rm(join(root.path, missing.id, "cycle-1", "manifest-1"));
    await expect(fx.cycle.inspect(missing.id)).rejects.toMatchObject({
      code: "UNKNOWN_ARTIFACT",
    });
  });

  it("fails the inspection when a concurrent runtime event changes the Session", async () => {
    const fx = await fixture();
    const run = await markReviewable(fx, fx.run);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    fx.requestMock.mockImplementationOnce(async () => {
      await gate;
      return { type: "pane_info", pane: { pane_id: "p1", tab_id: "t2", workspace_id: "w1" } };
    });

    const pending = fx.cycle.inspect(run.id);
    await Promise.resolve();
    await fx.cycle.onInfrastructureEvent({
      event: "pane.agent_status_changed",
      data: { pane_id: "p1", agent_status: "blocked" },
    });
    release();

    await expect(pending).rejects.toMatchObject({
      code: "STALE_SESSION_MUTATION",
      effectMayHaveOccurred: true,
    });
    expect(fx.repository.get(run.id)?.acceptanceTicket).toBeUndefined();
  });
});

describe("HandoffCycle > audit and acceptance", () => {
  it("does not issue a ticket on an authority violation", async () => {
    const fx = await fixture();
    fx.runner.run.mockImplementation(async (_command: string, args: string[]) => ({
      stdout: args[0] === "status" ? "?? violation.txt\n" : "",
      stderr: "",
      code: 0,
    }));
    const run = await markReviewable(fx, fx.run);

    const inspection = await fx.cycle.inspect(run.id);
    expect(inspection.audit.ok).toBe(false);
    expect(inspection.delegation.acceptanceTicket).toBeUndefined();
    expect(() => fx.cycle.accept(run.id)).toThrow("STALE_INSPECTION");
  });

  it("fails closed when the run has no captured authority baseline", async () => {
    const fx = await fixture();
    const run = await markReviewable(fx, fx.run);
    fx.repository.save({ ...run, authorityBaseline: undefined }, "transition");

    const inspection = await fx.cycle.inspect(run.id);
    expect(inspection.audit.ok).toBe(false);
    expect(inspection.audit.violations).toEqual([
      "authority baseline invalid: no authority baseline captured before delegation",
    ]);
    expect(inspection.delegation.acceptanceTicket).toBeUndefined();
  });

  it("blocks acceptance while a reviewer is pending", async () => {
    const fx = await fixture();
    const reviewRun = delegation("d-review", "as-review");
    fx.repository.saveSession(session(reviewRun), "created");
    fx.repository.save(reviewRun, "created");
    const run = await markReviewable(fx, fx.run, { reviewerIds: ["d-review"] });

    expect(() => fx.cycle.accept(run.id)).toThrow(
      "Reviewer delegation d-review has not been accepted by the parent",
    );
  });

  it("accepts with a current ticket and returns the Session to idle", async () => {
    const fx = await fixture();
    const run = await markReviewable(fx, fx.run);
    await fx.cycle.inspect(run.id);

    const accepted = fx.cycle.accept(run.id);
    expect(accepted).toMatchObject({ state: "accepted", health: undefined });
    expect(fx.repository.getSession(run.sessionId)).toMatchObject({
      state: "idle",
      health: "idle",
      activeRunId: undefined,
    });
  });

  it("gates acceptance on review state, claim and a fresh ticket", async () => {
    const fx = await fixture();
    expect(() => fx.cycle.accept("d1")).toThrow("RUN_NOT_REVIEWABLE");
    await fx.cycle.onInfrastructureEvent(workingEvent());
    fx.cycle.handleCallbackInput(claimSignal(fx.run));
    expect(() => fx.cycle.accept("d1")).toThrow("HANDOFF_CLAIM_PENDING");
    await fx.cycle.onInfrastructureEvent(idleEvent());
    expect(() => fx.cycle.accept("d1")).toThrow("STALE_INSPECTION");
  });
});

describe("HandoffCycle > Herdr runtime status", () => {
  it("fails Runs whose pane is missing from the snapshot and finds orphans", async () => {
    const fx = await fixture();
    const result = fx.cycle.reconcileSnapshot({
      protocol: 17,
      panes: [{
        pane_id: "orphan",
        workspace_id: "w",
        tab_id: "t",
        agent_status: "idle",
        tokens: { delegation: "unknown" },
      }],
    });
    expect(fx.repository.get("d1")?.state).toBe("failed");
    expect(result.orphanPaneIds).toEqual(["orphan"]);
  });

  it("updates health without interpreting idle as a handoff", async () => {
    const fx = await fixture();
    const updated = await fx.cycle.onInfrastructureEvent(idleEvent());
    expect(updated).toMatchObject({ state: "working", health: "idle" });
  });

  it("ignores unknown runtime status values", async () => {
    const fx = await fixture();
    const updated = await fx.cycle.onInfrastructureEvent({
      event: "pane.agent_status_changed",
      data: { pane_id: "p1", agent_status: "paused" },
    });
    expect(updated).toBeUndefined();
    expect(fx.repository.get("d1")).toMatchObject({ state: "working" });
    expect(fx.repository.get("d1")?.health).toBeUndefined();
  });

  it("promotes a claimed handoff from an idle reload snapshot", async () => {
    const store = new InMemoryDelegationStore();
    const fx = await fixture(store);
    await fx.cycle.onInfrastructureEvent(workingEvent());
    fx.cycle.handleCallbackInput(claimSignal(fx.run));

    const reloaded = await fixture(store);
    reloaded.cycle.reconcileSnapshot({
      protocol: 17,
      panes: [{
        pane_id: "p1",
        workspace_id: "w",
        tab_id: "t",
        agent_status: "idle",
        tokens: { owner: "owner" },
      }],
    });
    expect(reloaded.repository.get("d1")).toMatchObject({
      state: "ready_for_review",
      health: "idle",
    });
  });

  it("settles a claimed handoff from a done reload snapshot and is idempotent", async () => {
    const store = new InMemoryDelegationStore();
    const fx = await fixture(store);
    await fx.cycle.onInfrastructureEvent(workingEvent());
    fx.cycle.handleCallbackInput(claimSignal(fx.run));

    const reloaded = await fixture(store);
    const snapshot = {
      protocol: 17,
      panes: [{
        pane_id: "p1",
        workspace_id: "w",
        tab_id: "t",
        agent_status: "done" as const,
        tokens: { owner: "owner" },
      }],
    };
    reloaded.cycle.reconcileSnapshot(snapshot);
    expect(reloaded.repository.get("d1")).toMatchObject({
      state: "ready_for_review",
      health: "done",
      handoff: { claimed: true, working: true, settled: true },
    });
    const sequence = reloaded.repository.getSession("as1")!.mutationSequence;

    reloaded.cycle.reconcileSnapshot(snapshot);
    expect(reloaded.repository.get("d1")?.state).toBe("ready_for_review");
    expect(reloaded.repository.getSession("as1")!.mutationSequence).toBe(sequence);
  });

  it("routes warm-pane events only to the Session active Run", async () => {
    const fx = await fixture();
    const first = fx.repository.get("d1")!;
    fx.repository.save({ ...first, state: "accepted", health: "completed" }, "transition");
    const second = {
      ...first,
      id: "d2",
      state: "working" as const,
      health: "working",
      createdAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    };
    fx.repository.save(second, "created");
    fx.repository.saveSession(
      { ...fx.repository.getSession("as1")!, activeRunId: "d2" },
      "transition",
    );

    await fx.cycle.onInfrastructureEvent(idleEvent());
    expect(fx.repository.get(first.id)).toMatchObject({ state: "accepted", health: "completed" });
    expect(fx.repository.get(second.id)).toMatchObject({ state: "working", health: "idle" });

    await fx.cycle.onInfrastructureEvent({
      event: "pane.exited",
      data: { pane_id: "p1", type: "pane.exited" },
    });
    expect(fx.repository.get(first.id)?.state).toBe("accepted");
    expect(fx.repository.get(second.id)?.state).toBe("failed");
  });
});
