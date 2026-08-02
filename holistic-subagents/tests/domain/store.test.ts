import { describe, expect, it, vi } from "vitest";

import {
  DelegationRepository,
  InMemoryDelegationStore,
  PiSessionDelegationStore,
  recordsFromSessionEntries,
} from "../../src/domain/store.ts";
import {
  LEGACY_STORE_CUSTOM_TYPE,
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
    activeRunId: state === "busy" ? delegation.id : undefined,
    trustScope: "/tmp",
    authorityCeiling: delegation.request.authority,
    modelResolution: delegation.modelResolution,
    topology: delegation.request.topology,
    cwd: delegation.request.cwd,
    resources: [],
    callbackToken: delegation.callbackToken,
    createdAt: delegation.createdAt,
    updatedAt: delegation.updatedAt,
    lastUsedAt: delegation.updatedAt,
  };
}

describe("delegation event store", () => {
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

  it("replays the latest v1 snapshot as a sealed Session and writes only v2", () => {
    const legacy = {
      version: 1, eventId: "old-event", delegationId: "d1", kind: "created",
      at: delegation.updatedAt,
      snapshot: { ...delegation, state: "working", resources: [
        { kind: "pane", id: "old-pane", createdByExtension: true, ownershipToken: "secret" },
      ] },
    };
    const latest = {
      ...legacy,
      eventId: "new-event",
      kind: "transition",
      at: "2026-01-02T00:00:00.000Z",
      snapshot: { ...legacy.snapshot, state: "accepted", updatedAt: "2026-01-02T00:00:00.000Z", resources: [
        { kind: "pane", id: "latest-pane", createdByExtension: true, ownershipToken: "secret" },
      ] },
    };
    const append = vi.fn();
    const store = new PiSessionDelegationStore([
      { type: "custom", customType: LEGACY_STORE_CUSTOM_TYPE, data: legacy },
      { type: "custom", customType: LEGACY_STORE_CUSTOM_TYPE, data: latest },
    ], append);
    const repository = new DelegationRepository(store);
    expect(repository.get("d1")?.sessionId).toBe("legacy-session-d1");
    expect(repository.get("d1")?.state).toBe("accepted");
    expect(repository.getSession("legacy-session-d1")).toMatchObject({
      sealed: true,
      state: "closed",
      resources: [expect.objectContaining({ id: "latest-pane" })],
    });
    repository.save({ ...repository.get("d1")!, state: "failed" }, "transition");
    expect(append).toHaveBeenCalledWith(STORE_CUSTOM_TYPE, expect.objectContaining({ version: 2, entity: "run" }));
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
});
