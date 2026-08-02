import { isDeepStrictEqual } from "node:util";

import { canTransition, isActiveState } from "./state-machine.ts";
import { DelegationRepository } from "./store.ts";
import type {
  AgentSession,
  Delegation,
  DelegationEventKind,
} from "./types.ts";

export interface SessionMutationDraft {
  session: AgentSession;
  run?: Delegation;
}

export interface SessionMutationKinds {
  session?: DelegationEventKind;
  run?: DelegationEventKind;
}

export interface SessionMutationCheckpoint {
  checkpoint<T>(
    operation: (draft: SessionMutationDraft) => T,
    kinds?: SessionMutationKinds,
  ): T;
}

export interface SessionMutationOptions {
  create?: SessionMutationDraft;
  kinds?: SessionMutationKinds;
}

export class StaleSessionMutationError extends Error {
  readonly code = "STALE_SESSION_MUTATION";
  readonly sessionId: string;
  readonly effectMayHaveOccurred: boolean;

  constructor(sessionId: string, effectMayHaveOccurred: boolean) {
    super(
      `STALE_SESSION_MUTATION: Agent Session ${sessionId} changed while an external effect was in progress`
      + (effectMayHaveOccurred ? "; the external effect may have occurred" : ""),
    );
    this.name = "StaleSessionMutationError";
    this.sessionId = sessionId;
    this.effectMayHaveOccurred = effectMayHaveOccurred;
  }
}

/**
 * Exclusive runtime writer for an Agent Session and its active Run.
 * Mutation callbacks are synchronous by construction; external I/O belongs in
 * withEffect and is confirmed optimistically afterwards.
 */
export class SessionMutations {
  readonly #repository: DelegationRepository;
  readonly #active = new Set<string>();

  constructor(repository: DelegationRepository) {
    this.#repository = repository;
  }

  mutate<T>(
    sessionId: string,
    operation: (draft: SessionMutationDraft) => T,
    options: SessionMutationOptions = {},
  ): T {
    return this.#commit(sessionId, operation, options, undefined).value;
  }

  async withEffect<TCapture, TEffect, TResult>(
    sessionId: string,
    capture: (snapshot: Readonly<SessionMutationDraft>) => TCapture,
    effect: (
      captured: TCapture,
      context: SessionMutationCheckpoint,
    ) => Promise<TEffect>,
    confirm: (
      draft: SessionMutationDraft,
      effect: TEffect,
      captured: TCapture,
    ) => TResult,
    kinds: SessionMutationKinds = {},
  ): Promise<TResult> {
    const initial = this.#snapshot(sessionId);
    let expectedSequence = initial.session.mutationSequence;
    let expectedRunId = initial.session.activeRunId;
    const captured = capture(structuredClone(initial));
    let effectStarted = false;
    const context: SessionMutationCheckpoint = {
      checkpoint: <T>(
        operation: (draft: SessionMutationDraft) => T,
        checkpointKinds: SessionMutationKinds = {},
      ): T => {
        const committed = this.#commit(
          sessionId,
          operation,
          { kinds: checkpointKinds },
          { sequence: expectedSequence, activeRunId: expectedRunId, effectStarted },
        );
        expectedSequence = committed.sequence;
        expectedRunId = committed.activeRunId;
        return committed.value;
      },
    };

    effectStarted = true;
    const result = await effect(captured, context);
    return this.#commit(
      sessionId,
      (draft) => confirm(draft, result, captured),
      { kinds },
      { sequence: expectedSequence, activeRunId: expectedRunId, effectStarted: true },
    ).value;
  }

  #snapshot(sessionId: string, create?: SessionMutationDraft): SessionMutationDraft {
    const session = this.#repository.getSession(sessionId) ?? create?.session;
    if (!session) throw new Error(`Unknown Agent Session: ${sessionId}`);
    const run = create?.run
      ?? (session.activeRunId ? this.#repository.get(session.activeRunId) : undefined);
    return { session: structuredClone(session), run: structuredClone(run) };
  }

  #commit<T>(
    sessionId: string,
    operation: (draft: SessionMutationDraft) => T,
    options: SessionMutationOptions,
    expected: {
      sequence: number;
      activeRunId?: string;
      effectStarted: boolean;
    } | undefined,
  ): { value: T; sequence: number; activeRunId?: string } {
    if (this.#active.has(sessionId)) {
      throw new Error(`REENTRANT_SESSION_MUTATION: ${sessionId}`);
    }
    this.#active.add(sessionId);
    try {
      const existingSession = this.#repository.getSession(sessionId);
      const before = this.#snapshot(sessionId, options.create);
      if (expected && (
        before.session.mutationSequence !== expected.sequence
        || before.session.activeRunId !== expected.activeRunId
      )) {
        throw new StaleSessionMutationError(sessionId, expected.effectStarted);
      }

      const draft = structuredClone(before);
      const value = operation(draft);
      this.#validate(before, draft, existingSession === undefined);
      const creating = existingSession === undefined;
      const runChanged = creating ? draft.run !== undefined : !isDeepStrictEqual(before.run, draft.run);
      const sessionChanged = creating || !isDeepStrictEqual(before.session, draft.session);
      if (!runChanged && !sessionChanged) {
        return {
          value,
          sequence: before.session.mutationSequence,
          activeRunId: before.session.activeRunId,
        };
      }

      draft.session = {
        ...draft.session,
        mutationSequence: before.session.mutationSequence + 1,
      };
      this.#persist(before, draft, options.kinds ?? {}, creating);
      return {
        value,
        sequence: draft.session.mutationSequence,
        activeRunId: draft.session.activeRunId,
      };
    } finally {
      this.#active.delete(sessionId);
    }
  }

  #validate(
    before: SessionMutationDraft,
    after: SessionMutationDraft,
    creating: boolean,
  ): void {
    if (after.session.id !== before.session.id) {
      throw new Error("Agent Session identity cannot change");
    }
    if (creating && after.session.mutationSequence !== 0) {
      throw new Error("A new Agent Session must start at mutationSequence zero");
    }
    if (after.run) {
      if (after.run.sessionId !== after.session.id) {
        throw new Error("Run sessionId does not match its Agent Session");
      }
      if (before.run?.id === after.run.id
        && !canTransition(before.run.state, after.run.state)) {
        throw new Error(`Invalid delegation transition: ${before.run.state} -> ${after.run.state}`);
      }
    }
    if (after.session.activeRunId) {
      if (!after.run || after.run.id !== after.session.activeRunId) {
        throw new Error("Agent Session activeRunId is not linked to the mutated Run");
      }
      if (!isActiveState(after.run.state)) {
        throw new Error("A terminal Run cannot remain active in its Agent Session");
      }
    }

    const activeRuns = this.#repository.list()
      .filter((run) => run.sessionId === after.session.id && isActiveState(run.state))
      .filter((run) => run.id !== before.run?.id && run.id !== after.run?.id);
    if (after.run && isActiveState(after.run.state)) activeRuns.push(after.run);
    if (activeRuns.length > 1) {
      throw new Error(`Agent Session ${after.session.id} cannot have more than one active Run`);
    }
    if (activeRuns.length === 1 && after.session.activeRunId !== activeRuns[0]!.id) {
      throw new Error("Active Run and Agent Session activeRunId diverged");
    }
  }

  #persist(
    before: SessionMutationDraft,
    after: SessionMutationDraft,
    kinds: SessionMutationKinds,
    creating: boolean,
  ): void {
    const runChanged = creating ? after.run !== undefined : !isDeepStrictEqual(before.run, after.run);
    const sessionChanged = creating || !isDeepStrictEqual(before.session, after.session);
    const runBecameTerminal = runChanged && after.run && !isActiveState(after.run.state);

    const saveRun = () => {
      if (runChanged && after.run) this.#repository.save(after.run, kinds.run ?? "transition");
    };
    const saveSession = () => {
      if (sessionChanged || runChanged || creating) {
        this.#repository.saveSession(after.session, kinds.session ?? "transition");
      }
    };

    if (runBecameTerminal) {
      saveRun();
      saveSession();
    } else {
      saveSession();
      saveRun();
    }
  }
}
