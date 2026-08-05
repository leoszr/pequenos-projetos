import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import type { ArtifactStore } from "../artifacts/store.ts";
import type { HerdrClient, HerdrSnapshot, HerdrSubscriptionEvent } from "../herdr/client.ts";
import { buildFollowUpPrompt } from "../protocol/brief.ts";
import { parseCallback } from "../protocol/callback.ts";
import { parseManifest, type HandoffManifest } from "../protocol/handoff.ts";
import {
  auditAuthority,
  type AuthorityAudit,
  type CommandRunner,
} from "../security/authority.ts";
import { isActiveState, transitionDelegation } from "./state-machine.ts";
import {
  SessionMutations,
  type SessionMutationDraft,
} from "./session-mutations.ts";
import { DelegationRepository } from "./store.ts";
import {
  isAgentRuntimeStatus,
  temporaryArtifactRoot,
  upsertSessionResource,
  type AgentRuntimeStatus,
  type AgentSession,
  type Delegation,
  type DelegationResource,
  type DelegationQuestion,
} from "./types.ts";

export interface CallbackHandlingResult {
  matched: boolean;
  valid: boolean;
  transformedText?: string;
  delegation?: Delegation;
  reason?: string;
}

export interface InspectResult {
  delegation: Delegation;
  paneOutput: string;
  audit: AuthorityAudit;
  pane: Record<string, unknown> | undefined;
}

export interface ReconciliationResult {
  updated: Delegation[];
  orphanPaneIds: string[];
}

/** Read-only launch context handed to the caller while the module owns the mutations. */
export interface LaunchContext {
  readonly session: AgentSession;
  readonly run: Delegation;
}

/**
 * External launch work executed during cycle confirmation. The caller reports
 * resources observed while launching through emitResource; the module applies
 * them as Session mutations (checkpointed against the Session Mutation
 * Sequence) without ever exposing drafts.
 */
export interface LaunchConfirmation {
  launch(
    context: LaunchContext,
    emitResource: (
      resource: DelegationResource,
      baseline?: Delegation["authorityBaseline"],
    ) => void,
  ): Promise<{ cwd?: string; runtimeCwd?: string }>;
}

export interface HandoffCycleOptions {
  repository: DelegationRepository;
  mutations: SessionMutations;
  herdr: HerdrClient;
  artifacts: ArtifactStore;
  runner: CommandRunner;
}

/**
 * Deep module owning the Handoff Cycle invariants of a persisted Run: cycle
 * start and parent-message dispatch, textual callback authentication, Herdr
 * runtime status consumption, claim/settled correlation, manifest and artifact
 * validation, authority audit and Acceptance Ticket emission, reviewer gating
 * and acceptance. Every change is confirmed through SessionMutations; callers
 * use only the high-intention operations of this seam.
 */
export class HandoffCycle {
  readonly #repository: DelegationRepository;
  readonly #mutations: SessionMutations;
  readonly #herdr: HerdrClient;
  readonly #artifacts: ArtifactStore;
  readonly #runner: CommandRunner;

  constructor(options: HandoffCycleOptions) {
    this.#repository = options.repository;
    this.#mutations = options.mutations;
    this.#herdr = options.herdr;
    this.#artifacts = options.artifacts;
    this.#runner = options.runner;
  }

  /**
   * Starts the first Handoff Cycle of a freshly created Run: generates the
   * cycle id and applies the prepared-to-starting transition. Pure transform:
   * the caller must persist the returned Run together with its Agent Session
   * in the creation commit, so an active Run is never persisted without a
   * cycle and no window exists between creation and cycle start.
   */
  begin(run: Delegation): Delegation {
    const now = new Date().toISOString();
    return {
      ...transitionDelegation(run, "starting", now),
      handoff: { id: randomUUID() },
      updatedAt: now,
    };
  }

  /**
   * Associates a reviewer Run with the Run it reviews: records the reviewer
   * id, bumps the reviewed revision and invalidates any outstanding
   * Acceptance Ticket, since prior evidence no longer covers the new revision.
   * Returns undefined when the reviewed Run is no longer active.
   */
  attachReviewer(originalRunId: string, reviewerRunId: string): Delegation | undefined {
    const original = this.#repository.get(originalRunId);
    if (!original) throw new Error(`Unknown delegation: ${originalRunId}`);
    return this.#mutations.mutate(original.sessionId, (draft) => {
      if (!draft.run || draft.run.id !== originalRunId) return undefined;
      const now = new Date().toISOString();
      draft.run = {
        ...draft.run,
        reviewerIds: [...new Set([...draft.run.reviewerIds, reviewerRunId])],
        revision: draft.run.revision + 1,
        acceptanceTicket: undefined,
        updatedAt: now,
      };
      return draft.run;
    }, { kinds: { run: "relation" } });
  }

  /**
   * Parent prompt: starts a new Handoff Cycle, records the answered question
   * (if any), dispatches the follow-up. A persisted in-flight guard rejects a
   * concurrent dispatch before any I/O. Initial launch is the only operation
   * that waits for the working transition; a warm follow-up is reconciled
   * from Herdr events/snapshots instead, and its ack never records working.
   */
  async dispatch(
    runId: string,
    message: string,
    options: { questionId?: string; correction?: boolean } = {},
    signal?: AbortSignal,
  ): Promise<Delegation> {
    const delegation = this.#repository.get(runId);
    if (!delegation) throw new Error(`Unknown delegation: ${runId}`);
    if (!message.trim()) throw new Error("Message cannot be empty");
    if (["accepted", "failed", "cancelled"].includes(delegation.state)) {
      throw new Error(
        `RUN_TERMINAL: Run ${runId} is ${delegation.state}; use holistic_create for a new mission`,
      );
    }
    if (delegation.handoff?.effectMayHaveOccurred) {
      throw new Error(
        `HANDOFF_RECONCILIATION_REQUIRED: Run ${runId} may already have received the follow-up`,
      );
    }
    if (delegation.handoff?.dispatchPending) {
      throw new Error(
        `DISPATCH_IN_PROGRESS: Run ${runId} already has a follow-up dispatch in progress`,
      );
    }
    const now = new Date().toISOString();
    const cycleId = randomUUID();
    const mutated = this.#mutations.mutate(delegation.sessionId, (draft) => {
      let run = draft.run!;
      if (options.correction && run.state === "ready_for_review") {
        run = transitionDelegation(run, "correcting", now);
      }
      const questions = run.questions.map((question) =>
        options.questionId && question.id === options.questionId
          ? { ...question, answer: message, answeredAt: now }
          : question,
      );
      draft.run = {
        ...beginHandoffCycle(run, cycleId, now),
        handoff: { id: cycleId, dispatchPending: true },
        questions,
        updatedAt: now,
      };
      return draft.run;
    }, { kinds: { run: options.questionId ? "question" : "transition" } });
    try {
      return await this.#mutations.withEffect(
        mutated.sessionId,
        ({ run, session }) => ({ run: run!, session }),
        async ({ run, session }) => {
          await this.#herdr.request(
            "agent.prompt",
            {
              target: primaryPaneId(run),
              text: buildFollowUpPrompt(run, message, temporaryArtifactRoot(session)),
            },
            { signal, timeoutMs: 35_000 },
          );
        },
        (draft) => {
          // The agent.prompt ack confirms submission only; a correlated Herdr
          // event/snapshot is the sole source of the working observation.
          draft.run = {
            ...draft.run!,
            handoff: { ...draft.run!.handoff, dispatchPending: undefined },
          };
          return draft.run;
        },
        { run: "health" },
      );
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "STALE_SESSION_MUTATION") {
        // The Session advanced while the prompt was in flight, so the child
        // may have received it. Conclusive evidence for this cycle (a valid
        // claim/question) clears the guard itself; without it the cycle
        // becomes uncertain and re-delivery stays blocked.
        this.#mutations.mutate(mutated.sessionId, (draft) => {
          if (!draft.run || draft.run.id !== mutated.id || !draft.run.handoff?.dispatchPending) return;
          const now = new Date().toISOString();
          const failure = `agent.prompt delivery is uncertain after starting revision ${draft.run.revision}: ${errorMessage(error)}`;
          draft.run = {
            ...draft.run,
            handoff: {
              ...draft.run.handoff,
              dispatchPending: undefined,
              effectMayHaveOccurred: true,
            },
            failure,
            health: "dispatch_uncertain",
            updatedAt: now,
          };
          draft.session = {
            ...draft.session,
            health: "dispatch_uncertain",
            failure,
            updatedAt: now,
          };
        }, { kinds: { run: "health", session: "health" } });
      } else {
        this.#failPromptDispatch(mutated, error);
      }
      throw error;
    }
  }

  /**
   * Reconciles a timed-out follow-up. Complete delegation and ownership are
   * required; the uncertain cycle is preserved until conclusive evidence (a
   * valid claim for the current cycle) or explicit safe abandonment (manage
   * fail/close). Pane existence, a missing claim, incomplete ownership,
   * missing delegation metadata or diverged session/tab/workspace resources
   * never clear effectMayHaveOccurred. The Herdr snapshot is fetched
   * internally, never supplied by the caller.
   */
  async reconcileDispatch(runId: string): Promise<Delegation> {
    const result = await this.#herdr.request<{ snapshot?: HerdrSnapshot }>(
      "session.snapshot",
      {},
    );
    const snapshot = result?.snapshot;
    if (!snapshot || !Array.isArray(snapshot.panes)) {
      throw new Error(`HANDOFF_RECONCILIATION_REQUIRED: Herdr snapshot is incomplete for ${runId}`);
    }
    const current = this.#repository.get(runId);
    if (!current) throw new Error(`Unknown delegation: ${runId}`);
    if (!current.handoff?.effectMayHaveOccurred) return current;
    const session = this.#repository.getSession(current.sessionId);
    if (!session || session.activeRunId !== runId) {
      throw new Error(`HANDOFF_RECONCILIATION_REQUIRED: Run ${runId} is not the complete active Run`);
    }
    const paneResource = session.resources.find((resource) => resource.kind === "pane");
    const pane = snapshot.panes?.find((candidate) => candidate.pane_id === paneResource?.id);
    if (!paneResource || !pane) {
      throw new Error(
        `HANDOFF_RECONCILIATION_REQUIRED: owned pane of ${runId} is missing from the snapshot`,
      );
    }
    const owner = pane.tokens?.owner;
    if (typeof owner !== "string" || owner.length === 0
      || owner !== paneResource.ownershipToken.slice(0, 32)) {
      throw new Error(
        `HANDOFF_RECONCILIATION_REQUIRED: ownership of ${runId} is incomplete or diverged`,
      );
    }
    const delegationToken = pane.tokens?.delegation;
    if (typeof delegationToken !== "string" || delegationToken.length === 0
      || delegationToken !== session.ownershipId) {
      throw new Error(
        `HANDOFF_RECONCILIATION_REQUIRED: delegation metadata of ${runId} is incomplete or diverged`,
      );
    }
    const tabResource = session.resources.find(
      (resource) => resource.kind === "tab" && resource.id === pane.tab_id,
    );
    const workspaceResource = session.resources.find(
      (resource) => resource.kind === "workspace" && resource.id === pane.workspace_id,
    );
    if (!tabResource || !workspaceResource) {
      throw new Error(
        `HANDOFF_RECONCILIATION_REQUIRED: topology of ${runId} does not match its owned pane`,
      );
    }
    if (current.handoff.claimed) {
      await this.#loadManifest(current, session);
      return this.#mutations.mutate(current.sessionId, (draft) => {
        if (!draft.run || draft.run.id !== runId || draft.session.activeRunId !== runId) {
          throw new Error(`HANDOFF_RECONCILIATION_REQUIRED: Run ${runId} changed during reconciliation`);
        }
        const now = new Date().toISOString();
        draft.run = {
          ...draft.run,
          handoff: {
            ...draft.run.handoff,
            dispatchPending: undefined,
            effectMayHaveOccurred: undefined,
          },
          health: isAgentRuntimeStatus(pane.agent_status) ? pane.agent_status : "unknown",
          updatedAt: now,
        };
        return draft.run;
      }, { kinds: { run: "health" } });
    }
    throw new Error(
      `HANDOFF_RECONCILIATION_REQUIRED: Run ${runId} remains uncertain; wait for a conclusive claim or abandon explicitly`,
    );
  }

  /**
   * Confirms the child is working after the initial launch (create) or a warm
   * reuse dispatch. The caller provides only the external launch I/O through
   * LaunchConfirmation; the module owns the Session mutations, checkpointing
   * emitted resources against the Session Mutation Sequence and confirming the
   * working state without exposing drafts.
   */
  async confirmDispatch(
    sessionId: string,
    runId: string,
    confirmation: LaunchConfirmation,
  ): Promise<Delegation> {
    return this.#mutations.withEffect(
      sessionId,
      ({ session, run }) => ({ session, run: run! }),
      async (captured, context) => {
        return confirmation.launch(captured, (resource, baseline) => {
          context.checkpoint((draft) => {
            draft.session = upsertSessionResource(
              baseline ? { ...draft.session, authorityBaseline: baseline } : draft.session,
              resource,
            );
            if (baseline && draft.run) {
              draft.run = { ...draft.run, authorityBaseline: baseline };
            }
          }, { session: "resource", run: baseline ? "health" : undefined });
        });
      },
      (draft, result) => {
        if (!draft.run || draft.run.id !== runId) {
          throw new Error(`RUN_NOT_ACTIVE: Run ${runId} is not the active Run of its Agent Session`);
        }
        const now = new Date().toISOString();
        draft.run = recordRuntimeStatus(transitionDelegation(draft.run!, "working", now), "working", now);
        if (result.cwd) {
          draft.run = {
            ...draft.run,
            runtimeCwd: result.runtimeCwd ?? result.cwd,
            updatedAt: now,
          };
        }
        draft.session = {
          ...draft.session,
          state: "busy",
          cwd: result.cwd ?? draft.session.cwd,
          runtimeCwd: result.runtimeCwd ?? draft.session.runtimeCwd,
          health: "working",
          updatedAt: now,
        };
        return draft.run;
      },
      { run: "transition", session: "transition" },
    );
  }

  /**
   * Inspection: settles must be observed, the structured manifest and artifact
   * refs are validated, authority is audited and a fresh Acceptance Ticket is
   * emitted (or explicitly withheld on a violation).
   */
  async inspect(runId: string, signal?: AbortSignal): Promise<InspectResult> {
    const observed = this.#repository.get(runId);
    if (!observed) throw new Error(`Unknown delegation: ${runId}`);
    if (observed.state !== "ready_for_review") {
      if (isHandoffClaimPending(observed)) throw handoffClaimPending("inspect");
      throw new Error(`RUN_NOT_REVIEWABLE: Run ${runId} is ${observed.state}`);
    }
    const session = this.#repository.getSession(observed.sessionId);
    if (!session) throw new Error(`Unknown Agent Session: ${observed.sessionId}`);
    return this.#mutations.withEffect(
      observed.sessionId,
      ({ run, session: capturedSession }) => {
        const captured = run!;
        if (captured.state !== "ready_for_review") {
          throw new Error(`RUN_NOT_REVIEWABLE: Run ${runId} is ${captured.state}`);
        }
        if (captured.handoff?.settled !== true) throw handoffClaimPending("inspect");
        return {
          run: captured,
          session: capturedSession,
          revision: captured.revision,
          cycleId: captured.handoff?.id,
        };
      },
      async ({ run, session: capturedSession }) => {
        const paneId = primaryPaneId(run);
        const baseline = run.authorityBaseline ?? {
          capturedAt: run.createdAt,
          statusLines: [],
        };
        const panePromise = this.#herdr.request<{ pane?: Record<string, unknown> }>(
          "pane.get",
          { pane_id: paneId },
          { signal },
        );
        const auditPromise = auditAuthority(
          this.#runner,
          run.runtimeCwd ?? run.request.cwd,
          run.request.authority,
          baseline,
        );
        const evidencePromise = this.#loadManifest(run, capturedSession).then((manifest) => ({
          paneOutput: manifest.summary,
          manifest,
        }));
        const [paneResult, audit, evidence] = await Promise.all([
          panePromise,
          auditPromise,
          evidencePromise,
        ]);
        return { paneResult, audit, ...evidence };
      },
      (draft, result, captured) => {
        if (!draft.run
          || draft.run.revision !== captured.revision
          || draft.run.handoff?.id !== captured.cycleId
          || draft.run.state !== "ready_for_review") {
          throw new Error("STALE_INSPECTION: Run revision or handoff cycle changed");
        }
        const inspectedAt = new Date().toISOString();
        const sequence = draft.session.mutationSequence + 1;
        draft.run = {
          ...draft.run,
          handoff: { ...draft.run.handoff, manifest: result.manifest },
          evidence: [...draft.run.evidence, {
            ...result.audit.evidence,
            paneOutput: result.paneOutput,
            commands: result.manifest?.commands,
          }],
          acceptanceTicket: result.audit.ok ? {
            token: randomBytes(18).toString("base64url"),
            revision: draft.run.revision,
            inspectedAt,
            cycleId: draft.run.handoff?.id,
            mutationSequence: sequence,
            manifestSha256: draft.run.handoff?.manifestSha256,
          } : undefined,
          health: result.audit.ok ? draft.run.health : "authority_violation",
          updatedAt: inspectedAt,
        };
        return {
          delegation: draft.run,
          paneOutput: result.paneOutput,
          audit: result.audit,
          pane: result.paneResult.pane,
        };
      },
      { run: "evidence" },
    );
  }

  /**
   * Acceptance: all reviewers must be accepted, the claim must be settled and
   * the Acceptance Ticket must match the current revision, cycle and Session
   * Mutation Sequence. The Agent Session returns to idle.
   */
  accept(runId: string): Delegation {
    const delegation = this.#repository.get(runId);
    if (!delegation) throw new Error(`Unknown delegation: ${runId}`);
    for (const reviewerId of delegation.reviewerIds) {
      const reviewer = this.#repository.get(reviewerId);
      if (!reviewer) throw new Error(`Unknown delegation: ${reviewerId}`);
      if (reviewer.state !== "accepted") {
        throw new Error(`Reviewer delegation ${reviewerId} has not been accepted by the parent`);
      }
    }
    return this.#mutations.mutate(delegation.sessionId, (draft) => {
      if (!draft.run || draft.run.id !== runId) {
        throw new Error(`RUN_NOT_ACTIVE: Run ${runId} is not the active Run of its Agent Session`);
      }
      const run = draft.run;
      if (isHandoffClaimPending(run)) throw handoffClaimPending("accept");
      if (run.state !== "ready_for_review") {
        throw new Error(`RUN_NOT_REVIEWABLE: Run ${runId} is ${run.state}; wait for a complete handoff`);
      }
      if (!run.acceptanceTicket
        || run.acceptanceTicket.revision !== run.revision
        || run.acceptanceTicket.cycleId !== run.handoff?.id
        || run.acceptanceTicket.mutationSequence !== draft.session.mutationSequence) {
        throw new Error("STALE_INSPECTION: Inspect evidence for the current Run before accepting");
      }
      const now = new Date().toISOString();
      draft.run = {
        ...transitionDelegation(run, "accepted", now),
        health: undefined,
        failure: undefined,
      };
      draft.session = {
        ...draft.session,
        state: "idle",
        activeRunId: undefined,
        health: "idle",
        failure: undefined,
        updatedAt: now,
        lastUsedAt: now,
      };
      return draft.run;
    }, { kinds: { run: "transition", session: "transition" } });
  }

  /** Raw textual callback from the child Agent, authenticated and reduced. */
  handleCallbackInput(text: string): CallbackHandlingResult {
    const callback = parseCallback(text);
    if (!callback) return { matched: false, valid: false };
    const current = this.#repository.get(callback.delegationId);
    if (!current) return reduceCallback(text, undefined, undefined);
    const observedSession = this.#repository.getSession(current.sessionId);
    if (observedSession?.activeRunId !== current.id) {
      return reduceCallback(text, current, observedSession);
    }
    return this.#mutations.mutate(current.sessionId, (draft) => {
      const result = reduceCallback(text, draft.run, draft.session);
      if (result.valid && result.delegation) draft.run = result.delegation;
      return result;
    }, { kinds: { run: "health" } });
  }

  /** Snapshot reconciliation: missing panes fail Runs, status is normalized. */
  reconcileSnapshot(snapshot: HerdrSnapshot, now = new Date().toISOString()): ReconciliationResult {
    const panes = new Map((snapshot.panes ?? []).map((pane) => [pane.pane_id, pane]));
    const knownDelegationIds = new Set([
      ...this.#repository.list().map((delegation) => delegation.id),
      ...this.#repository.listSessions().map((session) => session.ownershipId),
    ]);
    const updated: Delegation[] = [];

    for (const observed of this.#repository.list()) {
      const paneResource = observed.resources.find((resource) => resource.kind === "pane");
      if (!paneResource || !isActiveState(observed.state)) continue;
      const pane = panes.get(paneResource.id);
      const next = this.#mutations.mutate(observed.sessionId, (draft) => {
        if (!draft.run || draft.run.id !== observed.id || !isActiveState(draft.run.state)) {
          return draft.run;
        }
        if (!pane) {
          const failure = "owned pane is missing from Herdr snapshot";
          draft.run = {
            ...transitionDelegation(draft.run, "failed", now),
            failure,
            health: "missing",
          };
          draft.session = {
            ...draft.session,
            state: "failed",
            activeRunId: undefined,
            failure,
            health: "missing",
            updatedAt: now,
          };
          return draft.run;
        }
        const owner = pane.tokens?.owner;
        if (owner && owner !== draft.run.resources[0]?.ownershipToken.slice(0, 32)) {
          const failure = "Herdr ownership metadata diverged";
          draft.run = {
            ...transitionDelegation(draft.run, "failed", now),
            failure,
            health: "ownership_mismatch",
          };
          draft.session = {
            ...draft.session,
            state: "failed",
            activeRunId: undefined,
            failure,
            health: "ownership_mismatch",
            updatedAt: now,
          };
          return draft.run;
        }
        persistRuntimeStatus(draft, pane.agent_status, now);
        return draft.run;
      }, { kinds: { run: "health", session: "health" } });
      if (next) updated.push(next);
    }

    const orphanPaneIds = (snapshot.panes ?? [])
      .filter((pane) => pane.tokens?.delegation && !knownDelegationIds.has(pane.tokens.delegation))
      .map((pane) => pane.pane_id);
    return { updated, orphanPaneIds };
  }

  /** Infrastructure events: live-confirms idle settlements, fails exited panes. */
  async onInfrastructureEvent(event: HerdrSubscriptionEvent): Promise<Delegation | undefined> {
    const data = (event.data ?? event) as Record<string, unknown>;
    const paneId = typeof data.pane_id === "string" ? data.pane_id : undefined;
    if (paneId && data.agent_status === "idle") {
      const session = this.#repository.listSessions().find((candidate) =>
        candidate.resources.some((resource) => resource.kind === "pane" && resource.id === paneId),
      );
      if (!session?.activeRunId) return undefined;
      const confirmationId = randomUUID();
      const guarded = this.#mutations.mutate(session.id, (draft) => {
        if (!draft.run?.handoff?.working || draft.run.handoff.settled) return false;
        draft.run = {
          ...draft.run,
          handoff: { ...draft.run.handoff, pendingIdleConfirmation: confirmationId },
        };
        return true;
      }, { kinds: { run: "health" } });
      try {
        return await this.#mutations.withEffect(
          session.id,
          () => undefined,
          async () => {
            try {
              return await this.#herdr.request<{ pane?: { agent_status?: unknown } }>(
                "pane.get",
                { pane_id: paneId },
              );
            } catch {
              return this.#herdr.request<{ pane?: { agent_status?: unknown } }>(
                "pane.get",
                { pane_id: paneId },
              );
            }
          },
          (draft, result) => {
            const liveStatus = result.pane?.agent_status;
            if (!isAgentRuntimeStatus(liveStatus)) return undefined;
            if (guarded && draft.run?.handoff?.pendingIdleConfirmation !== confirmationId) {
              throw new Error("STALE_RUNTIME_STATUS_CONFIRMATION");
            }
            if (guarded && draft.run?.handoff) {
              draft.run = {
                ...draft.run,
                handoff: { ...draft.run.handoff, pendingIdleConfirmation: undefined },
              };
            }
            return this.#reduceInfrastructureEvent(draft, {
              ...event,
              data: { ...data, agent_status: liveStatus },
            });
          },
          { run: "health", session: "health" },
        );
      } catch (error) {
        this.#mutations.mutate(session.id, (draft) => {
          if (draft.run?.handoff?.pendingIdleConfirmation !== confirmationId) return;
          const now = new Date().toISOString();
          draft.run = {
            ...draft.run,
            handoff: { ...draft.run.handoff, pendingIdleConfirmation: undefined },
            health: "runtime_confirmation_failed",
            updatedAt: now,
          };
          draft.session = {
            ...draft.session,
            health: "runtime_confirmation_failed",
            updatedAt: now,
          };
        }, { kinds: { run: "health", session: "health" } });
        throw error;
      }
    }
    return this.#applyInfrastructureEvent(event);
  }

  #applyInfrastructureEvent(event: HerdrSubscriptionEvent): Delegation | undefined {
    const data = (event.data ?? event) as Record<string, unknown>;
    const paneId = typeof data.pane_id === "string" ? data.pane_id : undefined;
    if (!paneId) return undefined;
    const session = this.#repository.listSessions().find((candidate) =>
      candidate.resources.some((resource) => resource.kind === "pane" && resource.id === paneId),
    );
    if (!session?.activeRunId) return undefined;

    return this.#mutations.mutate(session.id, (draft) => {
      return this.#reduceInfrastructureEvent(draft, event);
    }, { kinds: { run: "health", session: "health" } });
  }

  #reduceInfrastructureEvent(
    draft: SessionMutationDraft,
    event: HerdrSubscriptionEvent,
    now = new Date().toISOString(),
  ): Delegation | undefined {
    if (!draft.run) return undefined;
    const data = (event.data ?? event) as Record<string, unknown>;
    const paneId = typeof data.pane_id === "string" ? data.pane_id : undefined;
    if (!paneId || !draft.session.resources.some((resource) =>
      resource.kind === "pane" && resource.id === paneId
    )) return undefined;
    const kind = String(data.type ?? event.event);
    if ((kind.includes("closed") || kind.includes("exited")) && isActiveState(draft.run.state)) {
      const failure = `Herdr reported ${kind}`;
      draft.run = {
        ...transitionDelegation(draft.run, "failed", now),
        failure,
        health: "exited",
      };
      draft.session = {
        ...draft.session,
        state: "failed",
        failure,
        health: "exited",
        activeRunId: undefined,
        updatedAt: now,
      };
      return draft.run;
    }
    const status = isAgentRuntimeStatus(data.agent_status) ? data.agent_status : undefined;
    if (!status) return undefined;
    persistRuntimeStatus(draft, status, now);
    return draft.run;
  }

  #failPromptDispatch(run: Delegation, error: unknown): void {
    this.#mutations.mutate(run.sessionId, (draft) => {
      if (!draft.run || draft.run.id !== run.id || !isActiveState(draft.run.state)) return;
      const now = new Date().toISOString();
      const failure = `agent.prompt failed after starting revision ${run.revision}: ${errorMessage(error)}`;
      draft.run = {
        ...draft.run,
        handoff: { ...draft.run.handoff, dispatchPending: undefined, effectMayHaveOccurred: true },
        failure,
        health: "dispatch_uncertain",
        updatedAt: now,
      };
      draft.session = {
        ...draft.session,
        state: "busy",
        health: "dispatch_uncertain",
        failure,
        updatedAt: now,
      };
    }, { kinds: { run: "transition", session: "transition" } });
  }

  async #loadManifest(run: Delegation, session: AgentSession): Promise<HandoffManifest> {
    const cycle = run.handoff;
    const root = temporaryArtifactRoot(session);
    if (!cycle?.id || !cycle.manifestId || !cycle.manifestSha256 || !root) {
      throw new Error("INVALID_HANDOFF_MANIFEST: structured handoff claim or artifact root is missing");
    }
    const cycleId = cycle.id;
    const bytes = await this.#artifacts.readClaimed(root.id, {
      runId: run.id,
      cycleId,
      id: cycle.manifestId,
      sha256: cycle.manifestSha256,
      maxSizeBytes: 1024 * 1024,
    });
    const manifest = parseManifest(bytes, {
      maxSerializedBytes: 1024 * 1024,
      maxArtifacts: 64,
    });
    if (manifest.cycleId !== cycleId) {
      throw new Error("INVALID_HANDOFF_MANIFEST: manifest cycle does not match the active handoff cycle");
    }
    const registered = new Set(session.artifactRoots
      .filter((item) => !item.removedAt)
      .map((item) => item.id));
    let totalBytes = 0;
    for (const ref of manifest.artifacts) {
      if (!registered.has(ref.rootId)) {
        throw new Error(`INVALID_HANDOFF_MANIFEST: unregistered artifact root ${ref.rootId}`);
      }
      totalBytes += ref.size;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > 64 * 1024 * 1024) {
        throw new Error("INVALID_HANDOFF_MANIFEST: total artifact size exceeds limit");
      }
    }
    await Promise.all(manifest.artifacts.map((ref) =>
      this.#artifacts.verify(ref, { runId: run.id, cycleId }),
    ));
    return manifest;
  }
}

const SHA256_RE = /^[a-f0-9]{64}$/;

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Starts a new child-work cycle for a parent prompt and invalidates the prior handoff. */
function beginHandoffCycle(
  delegation: Delegation,
  cycleId?: string,
  now = new Date().toISOString(),
): Delegation {
  const working = delegation.state === "working"
    ? delegation
    : transitionDelegation(delegation, "working", now);
  return {
    ...working,
    health: "working",
    handoff: cycleId ? { id: cycleId } : undefined,
    revision: delegation.revision + 1,
    acceptanceTicket: undefined,
    updatedAt: now,
  };
}

/** Records a semantic handoff claim and promotes only if this revision settled. */
function recordHandoffClaim(
  delegation: Delegation,
  claim?: { cycleId?: string; manifestId?: string; manifestSha256?: string },
  now = new Date().toISOString(),
): Delegation {
  if (claim?.cycleId && delegation.handoff?.id !== claim.cycleId) return delegation;
  if (!["starting", "working"].includes(delegation.state)) return delegation;
  return settleHandoff(clearDispatchUncertainty({
    ...delegation,
    handoff: {
      ...delegation.handoff,
      id: delegation.handoff?.id ?? claim?.cycleId,
      claimed: true,
      manifestId: claim?.manifestId,
      manifestSha256: claim?.manifestSha256,
    },
    acceptanceTicket: undefined,
    updatedAt: now,
  }), now);
}

/**
 * Conclusive child evidence (a valid claim/question for the current cycle)
 * clears the in-flight and uncertain dispatch markers. Anything weaker keeps
 * the cycle preserved: re-delivery stays blocked until the child responds for
 * this cycle or the parent abandons the Run explicitly.
 */
function clearDispatchUncertainty(delegation: Delegation): Delegation {
  if (!delegation.handoff?.dispatchPending && !delegation.handoff?.effectMayHaveOccurred) {
    return delegation;
  }
  return {
    ...delegation,
    handoff: {
      ...delegation.handoff,
      dispatchPending: undefined,
      effectMayHaveOccurred: undefined,
    },
  };
}

/**
 * Records Herdr's current runtime status. Pi maps agent_settled to idle, but
 * idle is only a settlement after this same revision was observed working.
 */
function recordRuntimeStatus(
  delegation: Delegation,
  status: AgentRuntimeStatus,
  now = new Date().toISOString(),
): Delegation {
  if (status === "working") {
    const current = delegation.state === "starting"
      ? transitionDelegation(delegation, "working", now)
      : delegation;
    if (current.health === "working"
      && current.handoff?.working === true
      && current.handoff.settled !== true
      && !current.handoff.pendingIdleConfirmation) return current;
    return {
      ...current,
      health: "working",
      handoff: {
        ...current.handoff,
        working: true,
        settled: undefined,
        pendingIdleConfirmation: undefined,
      },
      acceptanceTicket: undefined,
      updatedAt: now,
    };
  }

  const settles = status === "idle"
    && delegation.handoff?.working === true
    && delegation.handoff.settled !== true;
  if (delegation.health === status && !settles) return delegation;
  const updated = {
    ...delegation,
    health: status,
    handoff: settles
      ? {
          ...delegation.handoff,
          settled: true as const,
          pendingIdleConfirmation: undefined,
        }
      : status !== "idle" && delegation.handoff?.pendingIdleConfirmation
        ? { ...delegation.handoff, pendingIdleConfirmation: undefined }
        : delegation.handoff,
    updatedAt: now,
  };
  return settleHandoff(updated, now);
}

function isHandoffClaimPending(delegation: Delegation): boolean {
  return delegation.handoff?.claimed === true && delegation.handoff.settled !== true;
}

function settleHandoff(delegation: Delegation, now: string): Delegation {
  return delegation.state === "working"
      && delegation.handoff?.claimed === true
      && delegation.handoff.settled === true
    ? transitionDelegation(delegation, "ready_for_review", now)
    : delegation;
}

/** Pure callback reducer. Persistence and ordering belong to SessionMutations. */
function reduceCallback(
  text: string,
  delegation: Delegation | undefined,
  session: AgentSession | undefined,
  now = new Date().toISOString(),
): CallbackHandlingResult {
  const callback = parseCallback(text);
  if (!callback) return { matched: false, valid: false };
  if (!delegation || callback.delegationId !== delegation.id) {
    return { matched: true, valid: false, reason: "unknown delegation" };
  }
  if (!session || session.activeRunId !== delegation.id) {
    return { matched: true, valid: false, reason: "delegation is not the active Run of its Session" };
  }
  if (!safeEqual(callback.token, delegation.callbackToken)) {
    return { matched: true, valid: false, reason: "invalid callback token" };
  }
  const ownsPane = delegation.resources.some(
    (resource) => resource.kind === "pane" && resource.id === callback.paneId,
  );
  if (!ownsPane) return { matched: true, valid: false, reason: "pane is not owned by delegation" };

  if (!callback.cycleId || callback.cycleId !== delegation.handoff?.id) {
    return { matched: true, valid: false, reason: "callback belongs to a stale or unknown handoff cycle" };
  }
  if (callback.kind === "handoff_ready" && (
    !callback.manifestId || !callback.manifestSha256 || !SHA256_RE.test(callback.manifestSha256)
  )) {
    return { matched: true, valid: false, reason: "structured handoff claim is incomplete" };
  }
  if (callback.kind === "handoff_ready" && delegation.handoff?.claimed) {
    const sameClaim = delegation.handoff.id === callback.cycleId
      && delegation.handoff.manifestId === callback.manifestId
      && delegation.handoff.manifestSha256 === callback.manifestSha256;
    if (!sameClaim) {
      return { matched: true, valid: false, reason: "handoff cycle already has a different claim" };
    }
    return {
      matched: true,
      valid: true,
      delegation,
      transformedText: delegation.state === "ready_for_review"
        ? `Delegation ${delegation.id} has a handoff ready for review. Use holistic_inspect before accepting it.`
        : `Delegation ${delegation.id} claimed a handoff and is waiting for agent_settled before review.`,
    };
  }

  let updated = delegation;
  if (callback.kind === "question" || callback.kind === "input_required") {
    const questionId = callback.questionId ?? `${callback.kind}-${delegation.questions.length + 1}`;
    const existing = delegation.questions.find((question) => question.id === questionId);
    if (!existing) {
      const question: DelegationQuestion = {
        id: questionId,
        blocking: callback.kind === "input_required",
        summary: "Read the child pane for the full question, impact and options.",
        openedAt: now,
      };
      updated = { ...updated, questions: [...updated.questions, question], updatedAt: now };
    }
    if (callback.kind === "input_required" && updated.state === "working") {
      updated = transitionDelegation(updated, "awaiting_input", now);
    }
    updated = clearDispatchUncertainty(updated);
    return {
      matched: true,
      valid: true,
      delegation: updated,
      transformedText: callback.kind === "question"
        ? `Delegation ${updated.id} asked a non-blocking question (${questionId}). Inspect its pane and answer with holistic_send.`
        : `Delegation ${updated.id} requires input (${questionId}) and is awaiting a response. Inspect its pane and answer with holistic_send.`,
    };
  }

  updated = clearDispatchUncertainty(recordHandoffClaim(updated, {
    cycleId: callback.cycleId,
    manifestId: callback.manifestId,
    manifestSha256: callback.manifestSha256,
  }, now));
  return {
    matched: true,
    valid: true,
    delegation: updated,
    transformedText: updated.state === "ready_for_review"
      ? `Delegation ${updated.id} has a handoff ready for review. Use holistic_inspect before accepting it.`
      : `Delegation ${updated.id} claimed a handoff and is waiting for agent_settled before review.`,
  };
}

function persistRuntimeStatus(
  draft: { run?: Delegation; session: { health?: string; updatedAt: string } },
  status: AgentRuntimeStatus,
  now: string,
): void {
  if (!draft.run) return;
  const updated = recordRuntimeStatus(draft.run, status, now);
  if (updated !== draft.run) draft.run = updated;
  if (draft.session.health !== status) {
    draft.session = { ...draft.session, health: status, updatedAt: now };
  }
}

function primaryPaneId(delegation: Delegation): string {
  const panes = delegation.resources.filter((resource) => resource.kind === "pane");
  const pane = panes.at(-1);
  if (!pane) throw new Error(`Delegation ${delegation.id} has no pane`);
  return pane.id;
}

function handoffClaimPending(action: "inspect" | "accept"): Error {
  return new Error(
    `HANDOFF_CLAIM_PENDING: Wait for the corresponding child agent_settled event before ${action}ing`,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
