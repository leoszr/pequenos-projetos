import { describe, expect, it } from "vitest";

import {
  SessionMutations,
  StaleSessionMutationError,
} from "../../src/domain/session-mutations.ts";
import {
  DelegationRepository,
  InMemoryDelegationStore,
} from "../../src/domain/store.ts";
import type { AgentSession, Delegation } from "../../src/domain/types.ts";

function run(sessionId = "as1", id = "d1"): Delegation {
  return {
    version: 2, id, sessionId, parentSessionId: "parent", parentPaneId: "pane",
    callbackToken: "secret", state: "working", purpose: "execution", reviewerIds: [],
    modelResolution: {
      model: "p/m", provider: "p", family: "f", thinking: "low",
      requestedCapability: "bounded", providedCapability: "bounded",
      degradedCapability: false, exactThinking: true, alternatives: [], reason: "test",
      requestedEffort: "low", effectiveEffort: "low", purpose: "execution",
    },
    request: {
      name: "test", mission: "test", cwd: "/tmp", topology: "pane",
      authority: { mode: "read_only", allowedPaths: [] }, acceptanceEvidence: [],
      model: { minimumCapability: "bounded", effort: "low" },
    },
    resources: [], questions: [], evidence: [], revision: 0,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function session(activeRun: Delegation): AgentSession {
  return {
    version: 2, id: activeRun.sessionId, ownershipId: activeRun.sessionId,
    parentSessionId: "parent", parentPaneId: "pane", state: "busy",
    mutationSequence: 0, activeRunId: activeRun.id, trustScope: "/tmp",
    authorityCeiling: activeRun.request.authority,
    modelResolution: activeRun.modelResolution, topology: "pane", cwd: "/tmp",
    resources: [], artifactRoots: [], callbackToken: "secret",
    createdAt: activeRun.createdAt, updatedAt: activeRun.updatedAt, lastUsedAt: activeRun.updatedAt,
  };
}

function fixture(...runs: Delegation[]) {
  const repository = new DelegationRepository(new InMemoryDelegationStore());
  const mutations = new SessionMutations(repository);
  for (const activeRun of runs) {
    mutations.mutate(activeRun.sessionId, () => undefined, {
      create: { session: session(activeRun), run: activeRun },
      kinds: { session: "created", run: "created" },
    });
  }
  return { repository, mutations };
}

describe("SessionMutations", () => {
  it("increments Sequence only for effective changes", () => {
    const activeRun = run();
    const { repository, mutations } = fixture(activeRun);
    expect(repository.getSession("as1")?.mutationSequence).toBe(1);

    mutations.mutate("as1", () => undefined);
    expect(repository.getSession("as1")?.mutationSequence).toBe(1);

    mutations.mutate("as1", (draft) => {
      draft.run = { ...draft.run!, health: "working" };
    });
    expect(repository.getSession("as1")?.mutationSequence).toBe(2);
  });

  it("allows exactly one confirmation from the same Sequence", async () => {
    const { repository, mutations } = fixture(run());
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const operation = (health: string) => mutations.withEffect(
      "as1",
      ({ run }) => run!.id,
      async () => { await barrier; return health; },
      (draft, result) => {
        draft.run = { ...draft.run!, health: result };
        return result;
      },
    );
    const first = operation("first");
    const second = operation("second");
    release();
    const outcomes = await Promise.allSettled([first, second]);

    expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((item) => item.status === "rejected");
    expect(rejected).toMatchObject({
      reason: expect.objectContaining({
        code: "STALE_SESSION_MUTATION",
        effectMayHaveOccurred: true,
      }),
    });
    expect(repository.getSession("as1")?.mutationSequence).toBe(2);
  });

  it("updates its token after checkpoints but rejects an external mutation", async () => {
    const { repository, mutations } = fixture(run());
    await expect(mutations.withEffect(
      "as1",
      () => undefined,
      async (_captured, { checkpoint }) => {
        checkpoint((draft) => {
          draft.session = { ...draft.session, health: "launching" };
        });
        mutations.mutate("as1", (draft) => {
          draft.run = { ...draft.run!, health: "callback" };
        });
        return "done";
      },
      (draft) => {
        draft.run = { ...draft.run!, health: "done" };
      },
    )).rejects.toBeInstanceOf(StaleSessionMutationError);
    expect(repository.get("d1")?.health).toBe("callback");
  });

  it("does not serialize effects from distinct Sessions", async () => {
    const { mutations } = fixture(run("as1", "d1"), run("as2", "d2"));
    const started: string[] = [];
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const effect = (id: string) => mutations.withEffect(
      id,
      () => undefined,
      async () => { started.push(id); await barrier; },
      () => undefined,
    );
    const pending = [effect("as1"), effect("as2")];
    await Promise.resolve();
    expect(started).toEqual(["as1", "as2"]);
    release();
    await Promise.all(pending);
  });
});
