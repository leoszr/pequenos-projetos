import { randomBytes, randomUUID } from "node:crypto";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { ArtifactStore, ArtifactStoreError } from "../artifacts/store.ts";
import type { HerdrClient, HerdrSnapshot, HerdrSubscriptionEvent } from "../herdr/client.ts";
import { HerdrTopologyManager, type LaunchSpec } from "../herdr/topologies.ts";
import {
  findSharedTabTarget,
  sessionRunsOutsideCoordinatorTab,
} from "../herdr/shared-tab-pool.ts";
import type { AvailableModel, ModelPolicyResolver } from "../models/policy.ts";
import {
  buildDelegationBrief,
  normalizeDelegationRequest,
  validateDelegationRequest,
} from "../protocol/brief.ts";
import {
  assertAuthorityPreconditions,
  captureAuthorityBaseline,
  type CommandRunner,
} from "../security/authority.ts";
import { DelegationCleanup } from "../security/cleanup.ts";
import {
  HandoffCycle,
  type CallbackHandlingResult,
  type InspectResult,
  type ReconciliationResult,
} from "./handoff-cycle.ts";
import {
  isActiveState,
  transitionDelegation,
} from "./state-machine.ts";
import { DelegationRepository } from "./store.ts";
import { SessionMutations } from "./session-mutations.ts";
import {
  STORE_VERSION,
  temporaryArtifactRoot,
  upsertSessionResource,
  type AgentSession,
  type ArtifactRootRegistration,
  type Delegation,
  type DelegationRequest,
  type RuntimeIdentity,
} from "./types.ts";

export interface CoordinatorIdentity extends RuntimeIdentity {
  parentWorkspaceId: string;
  parentTabId: string;
}

export type ManageAction = "focus" | "accept" | "fail" | "close" | "cleanup";

export type { CallbackHandlingResult, InspectResult, ReconciliationResult } from "./handoff-cycle.ts";

const SHARED_TAB_POOL_QUEUE = "__holistic_shared_tab_pool__";

export class DelegationService {
  readonly #repository: DelegationRepository;
  readonly #mutations: SessionMutations;
  readonly #herdr: HerdrClient;
  readonly #topologies: HerdrTopologyManager;
  readonly #cleanup: DelegationCleanup;
  readonly #artifacts: ArtifactStore;
  readonly #runner: CommandRunner;
  readonly #cycles: HandoffCycle;
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
    this.#cycles = new HandoffCycle({
      repository: options.repository,
      mutations: this.#mutations,
      herdr: options.herdr,
      artifacts: this.#artifacts,
      runner: options.runner,
    });
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
      .filter((session) => ["idle", "busy", "starting"].includes(session.state)
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
    let delegation: Delegation = {
      version: STORE_VERSION,
      id: runId,
      parentSessionId: this.#identity.parentSessionId,
      parentPaneId: this.#identity.parentPaneId,
      sessionId: session.id,
      callbackToken: session.callbackToken,
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
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    delegation.authorityBaseline = { ...trustBaseline, capturedAt: now };
    delegation = this.#cycles.begin(delegation);
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
      this.#cycles.attachReviewer(reviewedOriginal.id, delegation.id);
    }

    try {
      if (compatible) {
        return await this.#cycles.confirmDispatch(session.id, runId, {
          launch: async ({ session: capturedSession, run }) => {
            await this.#herdr.request("agent.prompt", {
              target: primarySessionPaneId(capturedSession),
              text: buildDelegationBrief({
                ...run,
                runtimeCwd: normalizedRequest.cwd,
                request: { ...run.request, cwd: normalizedRequest.cwd },
              }, temporaryArtifactRoot(capturedSession)),
              wait: { until: ["working"], timeout_ms: 30_000 },
            }, { signal, timeoutMs: 35_000 });
            return {};
          },
        });
      }
      return await this.#cycles.confirmDispatch(session.id, runId, {
        launch: async ({ session: capturedSession, run }, emitResource) => {
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
              emitResource(resource, baseline);
            },
          };
          const launched = normalizedRequest.topology === "pane"
            ? this.#serialized(SHARED_TAB_POOL_QUEUE, () => this.#topologies.launch({
                ...launchSpec,
                sharedTab: findSharedTabTarget(
                  this.#repository.listSessions(),
                  this.#identity.parentTabId,
                ),
              }, signal))
            : this.#topologies.launch(launchSpec, signal);
          const result = await launched;
          return { cwd: result.cwd, runtimeCwd: result.cwd };
        },
      });
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
    const session = this.#repository.getSession(observed.sessionId)!;
    await this.#registerArtifactRoots(session);
    return this.#cycles.inspect(id, signal);
  }

  async send(
    id: string,
    message: string,
    options: { questionId?: string; correction?: boolean } = {},
    signal?: AbortSignal,
  ): Promise<Delegation> {
    return this.#cycles.dispatch(id, message, options, signal);
  }

  /**
   * High-intention recovery entry for a follow-up dispatch left uncertain by
   * a timeout/error. The Herdr snapshot is fetched and validated internally;
   * conclusive evidence (a valid claim for the current cycle) plus complete
   * pane ownership and session/tab/workspace coherence releases the cycle;
   * anything less keeps it blocked. It never retries automatically — abandon
   * explicitly through manage fail/close.
   */
  async reconcileDispatch(runId: string): Promise<Delegation> {
    return this.#cycles.reconcileDispatch(runId);
  }

  manage(
    id: string,
    action: ManageAction,
    options: { reason?: string; discardBranch?: boolean } = {},
  ): Promise<Delegation> {
    return (async () => {
      let delegation = this.get(id);
      if (action === "focus") {
        const pane = delegation.resources.filter((resource) => resource.kind === "pane").at(-1);
        if (!pane) throw new Error(`Delegation ${delegation.id} has no pane`);
        await this.#herdr.request("pane.focus", { pane_id: pane.id });
        return delegation;
      }
      if (action === "accept") {
        return this.#cycles.accept(id);
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

  /**
   * Startup recovery: the coordinator runtime calls this once after
   * connecting. It fetches and validates the Herdr snapshot internally, runs
   * the regular snapshot reconciliation and then resolves any dispatch left
   * uncertain by a crash/reload through the same conclusive flow as
   * reconcileDispatch (valid claim for the current cycle, validated
   * manifest/hash and complete correlated ownership). It never retries
   * automatically and exposes no new tool.
   */
  async reconcileStartup(): Promise<ReconciliationResult> {
    const result = await this.#herdr.request<{ snapshot?: HerdrSnapshot }>(
      "session.snapshot",
      {},
    );
    const snapshot = result?.snapshot;
    if (!snapshot || !Array.isArray(snapshot.panes)) {
      throw new Error("Herdr snapshot is incomplete; coordinator runtime was not reconciled");
    }
    const outcome = this.#cycles.reconcileSnapshot(snapshot);
    for (const delegation of this.#repository.list()) {
      if (!delegation.handoff?.effectMayHaveOccurred || !delegation.handoff.claimed) continue;
      try {
        await this.#cycles.reconcileDispatch(delegation.id);
      } catch {
        // Preserve uncertainty; explicit abandonment or a later conclusive
        // snapshot may still resolve it.
      }
    }
    return outcome;
  }

  onInfrastructureEvent(event: HerdrSubscriptionEvent): Promise<Delegation | undefined> {
    return this.#cycles.onInfrastructureEvent(event);
  }

  handleCallbackInput(text: string): CallbackHandlingResult {
    return this.#cycles.handleCallbackInput(text);
  }

  #serialized<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(id) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.#queues.set(id, current);
    return current.finally(() => {
      if (this.#queues.get(id) === current) this.#queues.delete(id);
    });
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

function ownershipToken(delegation: Delegation): string {
  return delegation.callbackToken;
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
