import { randomBytes, randomUUID } from "node:crypto";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { ArtifactStore, ArtifactStoreError } from "../artifacts/store.ts";
import {
  applyInfrastructureEvent,
  reconcileSnapshot,
  reduceInfrastructureEvent,
} from "../herdr/reconcile.ts";
import type { HerdrClient, HerdrSnapshot, HerdrSubscriptionEvent } from "../herdr/client.ts";
import { HerdrTopologyManager, type LaunchSpec } from "../herdr/topologies.ts";
import {
  findSharedTabTarget,
  sessionRunsOutsideCoordinatorTab,
} from "../herdr/shared-tab-pool.ts";
import type { AvailableModel, ModelPolicyResolver } from "../models/policy.ts";
import {
  buildDelegationBrief,
  buildFollowUpPrompt,
  normalizeDelegationRequest,
  validateDelegationRequest,
} from "../protocol/brief.ts";
import { parseManifest, type HandoffManifest } from "../protocol/handoff.ts";
import {
  handleCallbackInput,
  parseCallback,
  type CallbackHandlingResult,
} from "../protocol/callback.ts";
import {
  assertAuthorityPreconditions,
  auditAuthority,
  captureAuthorityBaseline,
  type AuthorityAudit,
  type CommandRunner,
} from "../security/authority.ts";
import { DelegationCleanup } from "../security/cleanup.ts";
import {
  beginHandoffCycle,
  isActiveState,
  isHandoffClaimPending,
  recordRuntimeStatus,
  transitionDelegation,
} from "./state-machine.ts";
import { DelegationRepository } from "./store.ts";
import { SessionMutations } from "./session-mutations.ts";
import {
  HANDOFF_PROTOCOL_VERSION,
  LEGACY_HANDOFF_PROTOCOL_VERSION,
  STORE_VERSION,
  type AgentSession,
  type ArtifactRootRegistration,
  type Delegation,
  type DelegationRequest,
  type DelegationResource,
  type RuntimeIdentity,
  isAgentRuntimeStatus,
} from "./types.ts";

export interface CoordinatorIdentity extends RuntimeIdentity {
  parentWorkspaceId: string;
  parentTabId: string;
}

export interface InspectResult {
  delegation: Delegation;
  paneOutput: string;
  audit: AuthorityAudit;
  pane: Record<string, unknown> | undefined;
}

export type ManageAction = "focus" | "accept" | "fail" | "close" | "cleanup";

const SHARED_TAB_POOL_QUEUE = "__holistic_shared_tab_pool__";

export class DelegationService {
  readonly #repository: DelegationRepository;
  readonly #mutations: SessionMutations;
  readonly #herdr: HerdrClient;
  readonly #topologies: HerdrTopologyManager;
  readonly #cleanup: DelegationCleanup;
  readonly #artifacts: ArtifactStore;
  readonly #runner: CommandRunner;
  readonly #identity: CoordinatorIdentity;
  readonly #availableModels: () => AvailableModel[];
  readonly #modelPolicy: ModelPolicyResolver;
  readonly #queues = new Map<string, Promise<unknown>>();

  constructor(options: {
    repository: DelegationRepository;
    herdr: HerdrClient;
    runner: CommandRunner;
    identity: CoordinatorIdentity;
    availableModels: () => AvailableModel[];
    modelPolicy: ModelPolicyResolver;
  }) {
    this.#repository = options.repository;
    this.#mutations = new SessionMutations(options.repository);
    this.#herdr = options.herdr;
    this.#runner = options.runner;
    this.#identity = options.identity;
    this.#availableModels = options.availableModels;
    this.#modelPolicy = options.modelPolicy;
    this.#topologies = new HerdrTopologyManager(options.herdr);
    this.#cleanup = new DelegationCleanup(options.herdr, options.runner);
    this.#artifacts = new ArtifactStore();
  }

  list(): Delegation[] {
    return this.#repository.list();
  }

  get(id: string): Delegation {
    const delegation = this.#repository.get(id);
    if (!delegation) throw new Error(`Unknown delegation: ${id}`);
    return delegation;
  }

  async create(request: DelegationRequest, signal?: AbortSignal): Promise<Delegation> {
    const normalizedRequest = normalizeDelegationRequest(request);
    validateDelegationRequest(normalizedRequest);
    assertAuthorityPreconditions(normalizedRequest.authority);
    const reviewedOriginal = normalizedRequest.reviewOf
      ? this.get(normalizedRequest.reviewOf)
      : undefined;
    const trustBaseline = await captureAuthorityBaseline(
      this.#runner,
      normalizedRequest.cwd,
    );
    const trustScope = resolve(trustBaseline.gitRoot ?? normalizedRequest.cwd);
    const resolution = this.#modelPolicy.resolve(
      { ...normalizedRequest.model, purpose: normalizedRequest.purpose },
      this.#availableModels(),
    );
    const now = new Date().toISOString();
    const runId = randomUUID();
    const compatible = normalizedRequest.requiresCleanContext ? undefined : this.#repository.listSessions()
      .filter((session) => !session.sealed
        && ["idle", "busy", "starting"].includes(session.state)
        && sessionRunsOutsideCoordinatorTab(session, this.#identity.parentTabId)
        && sessionEnvironmentCompatible(session, normalizedRequest, trustScope)
        && authorityContained(
          normalizedRequest.authority,
          session.authorityCeiling,
          normalizedRequest.cwd,
          session.cwd,
        )
        && this.#fixedModelEligible(session, normalizedRequest))
      .sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt))[0];
    if (compatible && compatible.state !== "idle") throw sessionBusy();
    let session: AgentSession = compatible ?? {
      version: STORE_VERSION,
      id: randomUUID(),
      ownershipId: "",
      parentSessionId: this.#identity.parentSessionId,
      parentPaneId: this.#identity.parentPaneId,
      callbackToken: randomBytes(24).toString("base64url"),
      state: "starting",
      mutationSequence: 0,
      trustScope,
      authorityCeiling: structuredClone(normalizedRequest.authority),
      modelResolution: resolution,
      topology: normalizedRequest.topology,
      cwd: normalizedRequest.cwd,
      resources: [],
      artifactRoots: [],
      createdAt: now,
      updatedAt: now,
      lastUsedAt: now,
    };
    if (!compatible) session = { ...session, ownershipId: session.id };
    const existingArtifactRootIds = new Set(session.artifactRoots.map((root) => root.id));
    session = await this.#ensureArtifactRoot(session);
    const cycleId = randomUUID();
    let delegation: Delegation = {
      version: STORE_VERSION,
      id: runId,
      parentSessionId: this.#identity.parentSessionId,
      parentPaneId: this.#identity.parentPaneId,
      sessionId: session.id,
      callbackToken: session.callbackToken,
      handoffProtocolVersion: HANDOFF_PROTOCOL_VERSION,
      state: "prepared",
      request: structuredClone(normalizedRequest),
      purpose: normalizedRequest.purpose,
      reviewOf: normalizedRequest.reviewOf,
      reviewerIds: [],
      modelResolution: session.modelResolution,
      resources: [],
      questions: [],
      evidence: [],
      runtimeCwd: normalizedRequest.cwd,
      handoff: { id: cycleId },
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    delegation.authorityBaseline = { ...trustBaseline, capturedAt: now };
    if (compatible) {
      try {
        this.#mutations.mutate(session.id, (draft) => {
          if (draft.session.state !== "idle" || draft.session.activeRunId) throw sessionBusy();
          draft.session = {
            ...draft.session,
            state: "busy",
            activeRunId: delegation.id,
            authorityBaseline: delegation.authorityBaseline,
            artifactRoots: session.artifactRoots,
            updatedAt: now,
            lastUsedAt: now,
          };
          draft.run = delegation;
        }, { kinds: { session: "transition", run: "created" } });
      } catch (error) {
        await Promise.all(session.artifactRoots
          .filter((root) => !existingArtifactRootIds.has(root.id) && !root.durable)
          .map((root) => this.#artifacts.removeRoot(root.id)));
        throw error;
      }
    } else {
      session = {
        ...session,
        activeRunId: delegation.id,
        authorityBaseline: delegation.authorityBaseline,
      };
      this.#mutations.mutate(session.id, () => undefined, {
        create: { session, run: delegation },
        kinds: { session: "created", run: "created" },
      });
    }

    if (reviewedOriginal) {
      this.#mutations.mutate(reviewedOriginal.sessionId, (draft) => {
        if (!draft.run || draft.run.id !== reviewedOriginal.id) return;
        draft.run = {
          ...draft.run,
          reviewerIds: [...new Set([...draft.run.reviewerIds, delegation.id])],
          revision: draft.run.revision + 1,
          acceptanceTicket: undefined,
          updatedAt: now,
        };
      }, { kinds: { run: "relation" } });
    }

    delegation = this.#mutations.mutate(session.id, (draft) => {
      draft.run = transitionDelegation(draft.run!, "starting", now);
      return draft.run;
    }, { kinds: { run: "transition" } });
    try {
      if (compatible) {
        return await this.#mutations.withEffect(
          session.id,
          ({ session: capturedSession, run }) => ({ session: capturedSession, run: run! }),
          async ({ session: capturedSession, run }) => {
            await this.#herdr.request("agent.prompt", {
              target: primarySessionPaneId(capturedSession),
              text: buildDelegationBrief({
                ...run,
                runtimeCwd: normalizedRequest.cwd,
                request: { ...run.request, cwd: normalizedRequest.cwd },
              }, temporaryArtifactRoot(capturedSession)),
              wait: { until: ["working"], timeout_ms: 30_000 },
            }, { signal, timeoutMs: 35_000 });
          },
          (draft) => {
            draft.run = recordRuntimeStatus({
              ...transitionDelegation(draft.run!, "working"),
              health: "working",
            }, "working");
            draft.session = {
              ...draft.session,
              state: "busy",
              health: "working",
              updatedAt: draft.run.updatedAt,
            };
            return draft.run;
          },
          { run: "transition", session: "transition" },
        );
      }
      return await this.#mutations.withEffect(
        session.id,
        ({ session: capturedSession, run }) => ({ session: capturedSession, run: run! }),
        async ({ session: capturedSession, run }, { checkpoint }) => {
          const launchSpec: LaunchSpec = {
            delegationId: capturedSession.id,
            parentSessionId: run.parentSessionId,
            ownershipToken: ownershipToken(run),
            name: normalizedRequest.name,
            cwd: normalizedRequest.cwd,
            topology: normalizedRequest.topology,
            parentPaneId: this.#identity.parentPaneId,
            parentWorkspaceId: this.#identity.parentWorkspaceId,
            parentTabId: this.#identity.parentTabId,
            argv: buildPiArgv(run),
            env: buildChildEnv(run, temporaryArtifactRoot(capturedSession)),
            brief: (runtimeCwd) => buildDelegationBrief({
              ...run,
              runtimeCwd,
              request: { ...run.request, cwd: runtimeCwd },
            }, temporaryArtifactRoot(capturedSession)),
            baseRef: normalizedRequest.baseRef,
            branch: normalizedRequest.branch,
            worktreeRelativeCwd: run.authorityBaseline?.gitRoot
              ? relative(run.authorityBaseline.gitRoot, normalizedRequest.cwd)
              : undefined,
            onResource: async (resource) => {
              let baseline: Delegation["authorityBaseline"];
              if (resource.kind === "worktree" && resource.path) {
                const auditCwd = run.authorityBaseline?.gitRoot
                  ? join(resource.path, relative(run.authorityBaseline.gitRoot, normalizedRequest.cwd))
                  : resource.path;
                baseline = await captureAuthorityBaseline(this.#runner, auditCwd);
              }
              checkpoint((draft) => {
                draft.session = upsertSessionResource(
                  baseline ? { ...draft.session, authorityBaseline: baseline } : draft.session,
                  resource,
                );
                if (baseline && draft.run) draft.run = { ...draft.run, authorityBaseline: baseline };
              }, { session: "resource", run: baseline ? "health" : undefined });
            },
          };
          return normalizedRequest.topology === "pane"
            ? this.#serialized(SHARED_TAB_POOL_QUEUE, () => this.#topologies.launch({
                ...launchSpec,
                sharedTab: findSharedTabTarget(
                  this.#repository.listSessions(),
                  this.#identity.parentTabId,
                ),
              }, signal))
            : this.#topologies.launch(launchSpec, signal);
        },
        (draft, launch) => {
          draft.run = recordRuntimeStatus({
            ...transitionDelegation(draft.run!, "working"),
            health: "working",
            runtimeCwd: launch.cwd,
          }, "working");
          draft.session = {
            ...draft.session,
            state: "busy",
            cwd: launch.cwd,
            runtimeCwd: launch.cwd,
            health: "working",
            updatedAt: draft.run.updatedAt,
          };
          return draft.run;
        },
        { run: "transition", session: "transition" },
      );
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "STALE_SESSION_MUTATION")) {
        this.#mutations.mutate(session.id, (draft) => {
          if (!draft.run || draft.run.id !== runId || !isActiveState(draft.run.state)) return;
          const failedAt = new Date().toISOString();
          const failure = errorMessage(error);
          draft.run = { ...transitionDelegation(draft.run, "failed", failedAt), failure };
          draft.session = {
            ...draft.session,
            state: "failed",
            failure,
            activeRunId: undefined,
            updatedAt: failedAt,
          };
        }, { kinds: { run: "transition", session: "transition" } });
      }
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
        delegationId: runId,
      });
    }
  }

  async inspect(id: string, signal?: AbortSignal): Promise<InspectResult> {
    const observed = this.get(id);
    if (observed.state !== "ready_for_review") {
      if (isHandoffClaimPending(observed)) throw handoffClaimPending("inspect");
      throw new Error(`RUN_NOT_REVIEWABLE: Run ${id} is ${observed.state}`);
    }
    const session = this.#repository.getSession(observed.sessionId)!;
    await this.#registerArtifactRoots(session);
    return this.#mutations.withEffect(
      observed.sessionId,
      ({ run, session: capturedSession }) => {
        const captured = run!;
        if (captured.state !== "ready_for_review") {
          throw new Error(`RUN_NOT_REVIEWABLE: Run ${id} is ${captured.state}`);
        }
        if ((captured.handoffProtocolVersion ?? LEGACY_HANDOFF_PROTOCOL_VERSION)
          !== LEGACY_HANDOFF_PROTOCOL_VERSION
          && captured.handoff?.settled !== true) throw handoffClaimPending("inspect");
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
        const evidencePromise = (run.handoffProtocolVersion ?? LEGACY_HANDOFF_PROTOCOL_VERSION)
          === LEGACY_HANDOFF_PROTOCOL_VERSION
          ? this.#herdr.request<Record<string, unknown>>(
              "pane.read",
              { pane_id: paneId, source: "recent_unwrapped", lines: 240, format: "text" },
              { signal },
            ).then((read) => ({ paneOutput: extractPaneText(read), manifest: undefined }))
          : this.#loadManifest(run, capturedSession).then((manifest) => ({
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
          handoff: result.manifest
            ? { ...draft.run.handoff, manifest: result.manifest }
            : draft.run.handoff,
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

  async send(
    id: string,
    message: string,
    options: { questionId?: string; correction?: boolean } = {},
    signal?: AbortSignal,
  ): Promise<Delegation> {
    let delegation = this.get(id);
      if (!message.trim()) throw new Error("Message cannot be empty");
      if (["accepted", "failed", "cancelled"].includes(delegation.state)) {
        throw new Error(`RUN_TERMINAL: Run ${id} is ${delegation.state}; use holistic_create for a new mission`);
      }
      const now = new Date().toISOString();
      const cycleId = randomUUID();
      delegation = this.#mutations.mutate(delegation.sessionId, (draft) => {
        let run = draft.run!;
        if (options.correction && run.state === "ready_for_review") {
          run = transitionDelegation(run, "correcting", now);
        }
        const questions = run.questions.map((question) =>
          options.questionId && question.id === options.questionId
            ? { ...question, answer: message, answeredAt: now }
            : question,
        );
        draft.run = { ...beginHandoffCycle(run, cycleId, now), questions, updatedAt: now };
        return draft.run;
      }, { kinds: { run: options.questionId ? "question" : "transition" } });
      try {
        return await this.#mutations.withEffect(
          delegation.sessionId,
          ({ run, session }) => ({ run: run!, session }),
          async ({ run, session }) => {
            await this.#herdr.request(
              "agent.prompt",
              {
                target: primaryPaneId(run),
                text: buildFollowUpPrompt(run, message, temporaryArtifactRoot(session)),
                wait: { until: ["working"], timeout_ms: 30_000 },
              },
              { signal, timeoutMs: 35_000 },
            );
          },
          (draft) => {
            draft.run = recordRuntimeStatus(draft.run!, "working");
            draft.session = { ...draft.session, health: "working", updatedAt: draft.run.updatedAt };
            return draft.run;
          },
          { run: "health", session: "health" },
        );
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "STALE_SESSION_MUTATION")) {
          this.#failPromptDispatch(delegation, error);
        }
        throw error;
      }
  }

  manage(
    id: string,
    action: ManageAction,
    options: { reason?: string; discardBranch?: boolean } = {},
  ): Promise<Delegation> {
    return (async () => {
      let delegation = this.get(id);
      if (action === "focus") {
        await this.#herdr.request("pane.focus", { pane_id: primaryPaneId(delegation) });
        return delegation;
      }
      if (action === "accept") {
        for (const reviewerId of delegation.reviewerIds) {
          if (this.get(reviewerId).state !== "accepted") {
            throw new Error(`Reviewer delegation ${reviewerId} has not been accepted by the parent`);
          }
        }
        return this.#mutations.mutate(delegation.sessionId, (draft) => {
          if (!draft.run || draft.run.id !== id) {
            throw new Error(`RUN_NOT_ACTIVE: Run ${id} is not the active Run of its Agent Session`);
          }
          const run = draft.run!;
          if (isHandoffClaimPending(run)) throw handoffClaimPending("accept");
          if (run.state !== "ready_for_review") {
            throw new Error(`RUN_NOT_REVIEWABLE: Run ${id} is ${run.state}; wait for a complete handoff`);
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
      if (action === "fail") {
        return this.#mutations.mutate(delegation.sessionId, (draft) => {
          if (!draft.run || draft.run.id !== id) {
            throw new Error(`RUN_NOT_ACTIVE: Run ${id} is not the active Run of its Agent Session`);
          }
          const now = new Date().toISOString();
          draft.run = {
            ...transitionDelegation(draft.run!, "failed", now),
            failure: options.reason ?? "marked failed by parent",
            health: "failed",
          };
          draft.session = {
            ...draft.session,
            state: "failed",
            activeRunId: undefined,
            failure: draft.run.failure,
            health: "failed",
            updatedAt: now,
          };
          return draft.run;
        }, { kinds: { run: "transition", session: "transition" } });
      }
      const sessionId = delegation.sessionId;
      const closing = this.#mutations.mutate(sessionId, (draft) => {
        if (draft.session.state === "busy") {
          if (action === "cleanup") throw sessionBusy();
          if (!draft.run || draft.run.id !== delegation.id || !isActiveState(draft.run.state)) {
            throw sessionBusy();
          }
          const now = new Date().toISOString();
          draft.run = {
            ...transitionDelegation(draft.run, "cancelled", now),
            failure: options.reason ?? "cancelled by parent for Session close",
            health: "failed",
          };
          delegation = draft.run;
          draft.session = {
            ...draft.session,
            activeRunId: undefined,
            failure: draft.run.failure,
            health: "failed",
          };
        }
        draft.session = {
          ...draft.session,
          state: "closing",
          updatedAt: new Date().toISOString(),
        };
        return draft.session;
      }, { kinds: { run: "transition", session: "transition" } });
      try {
        await this.#mutations.withEffect(
          sessionId,
          ({ session }) => session,
          async (captured, { checkpoint }) => {
            await this.#cleanup.cleanup(sessionCleanupProjection(delegation, captured), {
              discardBranch: options.discardBranch,
              onResource: (resource) => checkpoint((draft) => {
                draft.session = upsertSessionResource(draft.session, resource);
              }, { session: "resource" }),
            });
            for (const root of captured.artifactRoots.filter((item) => !item.durable && !item.removedAt)) {
              if (root.ownershipToken !== captured.callbackToken) {
                throw new Error(`Artifact root ${root.id} ownership does not match`);
              }
              await this.#cleanupArtifactRoot(root);
              checkpoint((draft) => {
                draft.session = {
                  ...draft.session,
                  artifactRoots: draft.session.artifactRoots.map((item) =>
                    item.id === root.id ? { ...item, removedAt: new Date().toISOString() } : item,
                  ),
                  updatedAt: new Date().toISOString(),
                };
              }, { session: "resource" });
            }
          },
          (draft) => {
            draft.session = {
              ...draft.session,
              state: "closed",
              health: undefined,
              updatedAt: new Date().toISOString(),
            };
          },
          { session: "transition" },
        );
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "STALE_SESSION_MUTATION")) {
          this.#mutations.mutate(sessionId, (draft) => {
            draft.session = {
              ...draft.session,
              state: "failed",
              health: "failed",
              failure: errorMessage(error),
              updatedAt: new Date().toISOString(),
            };
          }, { kinds: { session: "transition" } });
        }
        throw error;
      }
      return delegation;
    })();
  }

  reconcile(snapshot: HerdrSnapshot): ReturnType<typeof reconcileSnapshot> {
    return reconcileSnapshot(this.#repository, this.#mutations, snapshot);
  }

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
            return reduceInfrastructureEvent(draft, {
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
    return applyInfrastructureEvent(this.#repository, this.#mutations, event);
  }

  handleCallbackInput(text: string): CallbackHandlingResult {
    const callback = parseCallback(text);
    if (!callback) return { matched: false, valid: false };
    const current = this.#repository.get(callback.delegationId);
    if (!current) return handleCallbackInput(text, undefined, undefined);
    const observedSession = this.#repository.getSession(current.sessionId);
    if (observedSession?.activeRunId !== current.id) {
      return handleCallbackInput(text, current, observedSession);
    }
    return this.#mutations.mutate(current.sessionId, (draft) => {
      const result = handleCallbackInput(text, draft.run, draft.session);
      if (result.valid && result.delegation) draft.run = result.delegation;
      return result;
    }, { kinds: { run: "health" } });
  }

  #serialized<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(id) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.#queues.set(id, current);
    return current.finally(() => {
      if (this.#queues.get(id) === current) this.#queues.delete(id);
    });
  }

  #failPromptDispatch(run: Delegation, error: unknown): void {
    this.#mutations.mutate(run.sessionId, (draft) => {
      if (!draft.run || draft.run.id !== run.id || !isActiveState(draft.run.state)) return;
      const now = new Date().toISOString();
      const failure = `agent.prompt failed after starting revision ${run.revision}: ${errorMessage(error)}`;
      draft.run = {
        ...transitionDelegation(draft.run, "failed", now),
        failure,
        health: "failed",
      };
      draft.session = {
        ...draft.session,
        state: "failed",
        activeRunId: undefined,
        health: "failed",
        failure,
        updatedAt: now,
      };
    }, { kinds: { run: "transition", session: "transition" } });
  }

  async #registerArtifactRoots(session: AgentSession): Promise<void> {
    for (const root of session.artifactRoots.filter((item) => !item.removedAt)) {
      if (!this.#artifacts.root(root.id)) {
        await this.#artifacts.registerRoot(root.id, root.path, { durable: root.durable });
      }
    }
  }

  async #cleanupArtifactRoot(root: ArtifactRootRegistration): Promise<void> {
    if (!this.#artifacts.root(root.id)) {
      try {
        await this.#artifacts.registerRoot(root.id, root.path, { durable: false });
      } catch (error) {
        if (error instanceof ArtifactStoreError
          && error.code === "IO_ERROR"
          && error.message.includes("does not exist")) return;
        throw error;
      }
    }
    await this.#artifacts.removeRoot(root.id);
  }

  async #loadManifest(
    run: Delegation,
    session: AgentSession,
  ): Promise<HandoffManifest> {
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

  #fixedModelEligible(
    session: AgentSession,
    request: DelegationRequest,
  ): boolean {
    const fixed = this.#modelPolicy.resolveFixed(
      session.modelResolution.model,
      { ...request.model, purpose: request.purpose },
      this.#availableModels(),
    );
    return fixed?.thinking === session.modelResolution.thinking
      && fixed.model === session.modelResolution.model;
  }

  async #ensureArtifactRoot(session: AgentSession): Promise<AgentSession> {
    for (const root of session.artifactRoots) {
      if (!root.removedAt && !this.#artifacts.root(root.id)) {
        await this.#artifacts.registerRoot(root.id, root.path, { durable: root.durable });
      }
    }
    if (temporaryArtifactRoot(session)) return session;
    const created = await this.#artifacts.createRoot(`holistic-${session.id}`);
    const root: ArtifactRootRegistration = {
      ...created,
      ownershipToken: session.callbackToken,
    };
    return { ...session, artifactRoots: [...session.artifactRoots, root] };
  }
}

function buildPiArgv(delegation: Delegation): string[] {
  const resolution = delegation.modelResolution;
  return [
    "pi",
    "--model",
    resolution.model,
    "--thinking",
    resolution.thinking,
    "--name",
    delegation.request.name,
    "--append-system-prompt",
    "You are an auxiliary Pi session. Do not create or control other agent sessions. Follow the declared authority and use the parent callback protocol.",
  ];
}

function buildChildEnv(
  delegation: Delegation,
  artifactRoot?: ArtifactRootRegistration,
): Record<string, string> {
  return {
    HOLISTIC_SUBAGENT_DEPTH: "1",
    HOLISTIC_PARENT_PANE_ID: delegation.parentPaneId,
    HOLISTIC_PARENT_SESSION_ID: delegation.parentSessionId,
    HOLISTIC_DELEGATION_ID: delegation.id,
    HOLISTIC_CALLBACK_TOKEN: delegation.callbackToken,
    HOLISTIC_ARTIFACT_ROOT_ID: artifactRoot?.id ?? "",
    HOLISTIC_ARTIFACT_ROOT: artifactRoot?.path ?? "",
    HOLISTIC_AUTHORITY_POLICY: Buffer.from(
      JSON.stringify(delegation.request.authority),
    ).toString("base64url"),
  };
}

function temporaryArtifactRoot(session: AgentSession): ArtifactRootRegistration | undefined {
  return session.artifactRoots.find((root) => !root.durable && !root.removedAt);
}

function ownershipToken(delegation: Delegation): string {
  return delegation.callbackToken;
}

function upsertSessionResource(session: AgentSession, resource: DelegationResource): AgentSession {
  const resources = [...session.resources];
  const index = resources.findIndex((item) => item.kind === resource.kind && item.id === resource.id);
  if (index < 0) resources.push(resource);
  else resources[index] = resource;
  return { ...session, resources, updatedAt: new Date().toISOString() };
}

function primarySessionPaneId(session: AgentSession): string {
  const pane = session.resources.filter((resource) => resource.kind === "pane").at(-1);
  if (!pane) throw new Error(`Agent Session ${session.id} has no pane`);
  return pane.id;
}

function sessionCleanupProjection(run: Delegation, session: AgentSession): Delegation {
  return {
    ...run,
    id: session.ownershipId,
    resources: session.resources,
    request: { ...run.request, cwd: session.cwd },
    runtimeCwd: session.runtimeCwd,
  };
}

function sessionBusy(): Error & { code: string } {
  return Object.assign(
    new Error(
      "SESSION_BUSY: Agent Session has an active Run; no queue or preemption is performed",
    ),
    { code: "SESSION_BUSY" },
  );
}

function handoffClaimPending(action: "inspect" | "accept"): Error {
  return new Error(
    `HANDOFF_CLAIM_PENDING: Wait for the corresponding child agent_settled event before ${action}ing`,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function authorityContained(
  run: DelegationRequest["authority"],
  ceiling: DelegationRequest["authority"],
  runCwd: string,
  ceilingCwd: string,
): boolean {
  if (run.mode !== "read_only" && run.mode !== ceiling.mode) return false;
  if (run.requireExternalSandbox && !ceiling.requireExternalSandbox) return false;

  const runForbidden = canonicalPaths(run.forbiddenPaths ?? [], runCwd);
  const ceilingForbidden = canonicalPaths(ceiling.forbiddenPaths ?? [], ceilingCwd);
  if (ceilingForbidden.some((blocked) =>
    !runForbidden.some((runBlocked) => pathContains(runBlocked, blocked)))) {
    return false;
  }

  if (run.mode === "read_only") return true;
  const runAllowed = canonicalPaths(run.allowedPaths, runCwd);
  const ceilingAllowed = canonicalPaths(ceiling.allowedPaths, ceilingCwd);
  if (ceilingAllowed.length > 0 && runAllowed.length === 0) return false;
  if (ceilingAllowed.length > 0 && runAllowed.some((path) =>
    !ceilingAllowed.some((parent) => pathContains(parent, path)))) {
    return false;
  }
  return true;
}

export function sessionEnvironmentCompatible(
  session: AgentSession,
  request: DelegationRequest,
  trustScope: string,
): boolean {
  if (resolve(session.trustScope) !== resolve(trustScope)) return false;
  if (resolve(session.cwd) !== resolve(request.cwd)) return false;
  if (session.topology !== request.topology) return false;
  return session.topology !== "worktree";
}

function canonicalPaths(paths: readonly string[], cwd: string): string[] {
  return paths.map((path) => resolve(isAbsolute(path) ? path : join(cwd, path)));
}

function pathContains(parent: string, child: string): boolean {
  const delta = relative(parent, child);
  return delta === ""
    || (delta !== ".." && !delta.startsWith(`..${sep}`) && !isAbsolute(delta));
}

function primaryPaneId(delegation: Delegation): string {
  const panes = delegation.resources.filter((resource) => resource.kind === "pane");
  const pane = panes.at(-1);
  if (!pane) throw new Error(`Delegation ${delegation.id} has no pane`);
  return pane.id;
}

function extractPaneText(result: Record<string, unknown>): string {
  const read = result.read as Record<string, unknown> | undefined;
  for (const candidate of [read?.text, read?.content, result.text, result.content]) {
    if (typeof candidate === "string") return candidate;
  }
  return JSON.stringify(read ?? result);
}
