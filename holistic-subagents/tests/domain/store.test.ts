import { describe, expect, it, vi } from "vitest";

import {
  DelegationRepository,
  InMemoryDelegationStore,
  PiSessionDelegationStore,
  recordsFromSessionEntries,
} from "../../src/domain/store.ts";
import {
  STORE_CUSTOM_TYPE,
  type AgentSession,
  type Delegation,
} from "../../src/domain/types.ts";

const delegation: Delegation = {
  version: 2,
  id: "d1",
  sessionId: "as1",
  parentSessionId: "s1",
  parentPaneId: "p1",
  callbackToken: "secret",
  state: "prepared",
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
    mission: "mission",
    cwd: "/tmp",
    authority: { mode: "read_only", allowedPaths: [] },
    acceptanceEvidence: [],
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

function session(state: AgentSession["state"] = "busy"): AgentSession {
  return {
    version: 2,
    id: delegation.sessionId,
    ownershipId: delegation.sessionId,
    parentSessionId: delegation.parentSessionId,
    parentPaneId: delegation.parentPaneId,
    state,
    mutationSequence: 0,
    activeRunId: state === "busy" ? delegation.id : undefined,
    trustScope: "/tmp",
    authorityCeiling: delegation.request.authority,
    modelResolution: delegation.modelResolution,
    topology: delegation.request.topology,
    cwd: delegation.request.cwd,
    resources: [],
    artifactRoots: [],
    callbackToken: delegation.callbackToken,
    createdAt: delegation.createdAt,
    updatedAt: delegation.updatedAt,
    lastUsedAt: delegation.updatedAt,
  };
}

describe("delegation event store", () => {
  it("normalizes older v2 snapshots to Sequence zero and empty artifact roots", () => {
    const { mutationSequence: _sequence, artifactRoots: _roots, ...oldSession } = session();
    const memory = new InMemoryDelegationStore([
      {
        version: 2, eventId: "session-old", kind: "created", at: oldSession.updatedAt,
        entity: "session", entityId: oldSession.id, snapshot: oldSession,
      },
      {
        version: 2, eventId: "run-old", kind: "created", at: delegation.updatedAt,
        entity: "run", entityId: delegation.id, delegationId: delegation.id, snapshot: delegation,
      },
    ] as never);

    const repository = new DelegationRepository(memory);

    expect(repository.getSession(oldSession.id)).toMatchObject({
      mutationSequence: 0,
      artifactRoots: [],
    });
  });

  it("rebuilds snapshots and ignores duplicate event IDs", () => {
    const memory = new InMemoryDelegationStore();
    const repository = new DelegationRepository(memory);
    const record = repository.save(delegation, "created");
    memory.entries.push(record);

    const restored = new DelegationRepository(memory);
    expect(restored.list()).toHaveLength(1);
    expect(restored.get("d1")?.state).toBe("prepared");
  });

  it("persists through Pi custom entries", () => {
    const append = vi.fn();
    const first = new PiSessionDelegationStore([], append);
    const repository = new DelegationRepository(first);
    const record = repository.save(delegation, "created");
    expect(append).toHaveBeenCalledWith(STORE_CUSTOM_TYPE, record);

    const entries = [
      { type: "custom", customType: STORE_CUSTOM_TYPE, data: record },
      { type: "custom", customType: STORE_CUSTOM_TYPE, data: record },
      { type: "message" },
    ];
    expect(recordsFromSessionEntries(entries)).toHaveLength(1);
  });

  it("ignores holistic-delegation-v1 entries", () => {
    const legacy = {
      version: 1, eventId: "v1-event", delegationId: "d1", kind: "created",
      at: delegation.updatedAt,
      snapshot: { ...delegation, state: "working" },
    };
    const entries = [
      { type: "custom", customType: "holistic-delegation-v1", data: legacy },
      { type: "custom", customType: STORE_CUSTOM_TYPE, data: undefined },
      { type: "message" },
    ];

    expect(recordsFromSessionEntries(entries)).toEqual([]);
    const store = new PiSessionDelegationStore(entries, () => undefined);
    const repository = new DelegationRepository(store);
    expect(repository.list()).toEqual([]);
    expect(repository.listSessions()).toEqual([]);
  });

  it("repairs a torn accepted-Run commit deterministically and idempotently", () => {
    const memory = new InMemoryDelegationStore();
    const writer = new DelegationRepository(memory);
    writer.saveSession(session("busy"), "transition");
    writer.save({ ...delegation, state: "accepted", updatedAt: "2026-01-02T00:00:00.000Z" }, "transition");
    const beforeRecovery = memory.entries.length;

    const recovered = new DelegationRepository(memory);
    expect(recovered.getSession(delegation.sessionId)).toMatchObject({
      state: "idle",
      activeRunId: undefined,
      lastUsedAt: "2026-01-02T00:00:00.000Z",
    });
    expect(memory.entries).toHaveLength(beforeRecovery + 1);

    new DelegationRepository(memory);
    expect(memory.entries).toHaveLength(beforeRecovery + 1);
  });

  it.each(["failed", "cancelled"] as const)(
    "quarantines a Session when replay finds a torn %s Run commit",
    (terminal) => {
      const memory = new InMemoryDelegationStore();
      const writer = new DelegationRepository(memory);
      writer.saveSession(session("busy"), "transition");
      writer.save({
        ...delegation,
        state: terminal,
        failure: terminal === "failed" ? "dispatch uncertain" : undefined,
        updatedAt: "2026-01-02T00:00:00.000Z",
      }, "transition");

      const beforeRecovery = memory.entries.length;
      const recovered = new DelegationRepository(memory);
      expect(recovered.getSession(delegation.sessionId)).toMatchObject({
        state: "failed",
        activeRunId: undefined,
      });
      expect(memory.entries).toHaveLength(beforeRecovery + 1);
      new DelegationRepository(memory);
      expect(memory.entries).toHaveLength(beforeRecovery + 1);
    },
  );

  it.each([
    ["starting without an active Run", { ...session("idle"), state: "starting" as const }],
    ["starting with a missing active Run", { ...session("busy"), state: "starting" as const, activeRunId: "missing" }],
    ["busy with a missing active Run", { ...session("busy"), activeRunId: "missing" }],
  ])("quarantines an orphan reservation: %s", (_label, orphan) => {
    const memory = new InMemoryDelegationStore();
    const writer = new DelegationRepository(memory);
    writer.saveSession(orphan, "transition");
    const beforeRecovery = memory.entries.length;

    const recovered = new DelegationRepository(memory);
    expect(recovered.getSession(orphan.id)).toMatchObject({
      state: "failed",
      activeRunId: undefined,
      health: "failed",
    });
    expect(memory.entries).toHaveLength(beforeRecovery + 1);
    new DelegationRepository(memory);
    expect(memory.entries).toHaveLength(beforeRecovery + 1);
  });

  it("promotes an orphaned in-flight dispatch to uncertain on reload", () => {
    const memory = new InMemoryDelegationStore();
    const writer = new DelegationRepository(memory);
    writer.saveSession(session("busy"), "transition");
    writer.save({
      ...delegation,
      state: "working",
      health: "working",
      revision: 2,
      handoff: { id: "cycle-2", working: true, dispatchPending: true },
    }, "transition");
    const beforeRecovery = memory.entries.length;

    const recovered = new DelegationRepository(memory);
    const run = recovered.get(delegation.id)!;
    expect(run).toMatchObject({
      state: "working",
      health: "dispatch_uncertain",
      handoff: { working: true, effectMayHaveOccurred: true },
    });
    expect(run.handoff?.dispatchPending).toBeUndefined();
    expect(run.failure).toContain("interrupted by a coordinator reload");
    expect(recovered.getSession(delegation.sessionId)).toMatchObject({
      state: "busy",
      health: "dispatch_uncertain",
      activeRunId: delegation.id,
    });
    expect(memory.entries).toHaveLength(beforeRecovery + 2);
    new DelegationRepository(memory);
    expect(memory.entries).toHaveLength(beforeRecovery + 2);
  });

  it("replay preserves a claimed handoff and keeps it uncertain", () => {
    const memory = new InMemoryDelegationStore();
    const writer = new DelegationRepository(memory);
    writer.saveSession(session("busy"), "transition");
    writer.save({
      ...delegation,
      state: "ready_for_review",
      health: "ready_for_review",
      handoff: {
        id: "cycle-2",
        working: true,
        settled: true,
        claimed: true,
        manifestId: "manifest-1",
        manifestSha256: "a".repeat(64),
        dispatchPending: true,
      },
    }, "transition");
    const beforeRecovery = memory.entries.length;

    const recovered = new DelegationRepository(memory);
    const run = recovered.get(delegation.id)!;
    expect(run).toMatchObject({
      state: "ready_for_review",
      health: "dispatch_uncertain",
      handoff: {
        claimed: true,
        settled: true,
        manifestId: "manifest-1",
        manifestSha256: "a".repeat(64),
        effectMayHaveOccurred: true,
      },
    });
    expect(run.handoff?.dispatchPending).toBeUndefined();
    expect(run.failure).toContain("interrupted by a coordinator reload");
    expect(recovered.getSession(delegation.sessionId)).toMatchObject({
      state: "busy",
      health: "dispatch_uncertain",
      activeRunId: delegation.id,
    });
    expect(memory.entries).toHaveLength(beforeRecovery + 2);
    new DelegationRepository(memory);
    expect(memory.entries).toHaveLength(beforeRecovery + 2);
  });

  it("replay keeps retry blocked for an incomplete claim", () => {
    const memory = new InMemoryDelegationStore();
    const writer = new DelegationRepository(memory);
    writer.saveSession(session("busy"), "transition");
    writer.save({
      ...delegation,
      state: "working",
      health: "working",
      handoff: { id: "cycle-2", working: true, claimed: true, dispatchPending: true },
    }, "transition");
    const beforeRecovery = memory.entries.length;

    const recovered = new DelegationRepository(memory);
    const run = recovered.get(delegation.id)!;
    expect(run).toMatchObject({
      state: "working",
      health: "dispatch_uncertain",
      handoff: { claimed: true, effectMayHaveOccurred: true },
    });
    expect(run.handoff?.dispatchPending).toBeUndefined();
    expect(run.handoff?.manifestId).toBeUndefined();
    expect(run.failure).toContain("interrupted by a coordinator reload");
    expect(recovered.getSession(delegation.sessionId)).toMatchObject({
      state: "busy",
      health: "dispatch_uncertain",
      activeRunId: delegation.id,
    });
    expect(memory.entries).toHaveLength(beforeRecovery + 2);
    new DelegationRepository(memory);
    expect(memory.entries).toHaveLength(beforeRecovery + 2);
  });
});
