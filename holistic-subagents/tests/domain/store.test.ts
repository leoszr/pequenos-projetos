import { describe, expect, it, vi } from "vitest";

import {
  DelegationRepository,
  InMemoryDelegationStore,
  PiSessionDelegationStore,
  recordsFromSessionEntries,
} from "../../src/domain/store.ts";
import { STORE_CUSTOM_TYPE, type Delegation } from "../../src/domain/types.ts";

const delegation: Delegation = {
  version: 1,
  id: "d1",
  parentSessionId: "s1",
  parentPaneId: "p1",
  callbackToken: "secret",
  state: "prepared",
  purpose: "execution",
  reviewerIds: [],
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
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

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
});
