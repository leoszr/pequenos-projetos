import { randomBytes, randomUUID } from "node:crypto";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { applyInfrastructureEvent, reconcileSnapshot } from "../herdr/reconcile.ts";
import type { HerdrClient, HerdrSnapshot, HerdrSubscriptionEvent } from "../herdr/client.ts";
import { HerdrTopologyManager } from "../herdr/topologies.ts";
import type { AvailableModel, ModelPolicyResolver } from "../models/policy.ts";
import {
  buildDelegationBrief,
  normalizeDelegationRequest,
  validateDelegationRequest,
} from "../protocol/brief.ts";
import { handleCallbackInput, type CallbackHandlingResult } from "../protocol/callback.ts";
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
import {
  STORE_VERSION,
  type AgentSession,
  type Delegation,
  type DelegationRequest,
  type DelegationResource,
  type RuntimeIdentity,
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

export class DelegationService {
  readonly #repository: DelegationRepository;
  readonly #herdr: HerdrClient;
  readonly #topologies: HerdrTopologyManager;
  readonly #cleanup: DelegationCleanup;
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
    this.#herdr = options.herdr;
    this.#runner = options.runner;
    this.#identity = options.identity;
    this.#availableModels = options.availableModels;
    this.#modelPolicy = options.modelPolicy;
    this.#topologies = new HerdrTopologyManager(options.herdr);
    this.#cleanup = new DelegationCleanup(options.herdr, options.runner);
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
      trustScope,
      authorityCeiling: structuredClone(normalizedRequest.authority),
      modelResolution: resolution,
      topology: normalizedRequest.topology,
      cwd: normalizedRequest.cwd,
      resources: [],
      createdAt: now,
      updatedAt: now,
      lastUsedAt: now,
    };
    if (!compatible) session = { ...session, ownershipId: session.id };
    // Reservation is synchronous: concurrent callers see busy and never queue or preempt.
    if (compatible) {
      const current = this.#repository.getSession(compatible.id);
      if (!current || current.state !== "idle") throw sessionBusy();
      session = {
        ...current,
        state: "busy",
        activeRunId: runId,
        updatedAt: now,
        lastUsedAt: now,
      };
    }
    this.#repository.saveSession(session, compatible ? "transition" : "created");
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
      revision: 0,
      createdAt: now,
      updatedAt: now,
    };
    delegation.authorityBaseline = { ...trustBaseline, capturedAt: now };
    this.#repository.save(delegation, "created");
    session = {
      ...session,
      state: "busy",
      activeRunId: delegation.id,
      authorityBaseline: delegation.authorityBaseline,
      updatedAt: now,
      lastUsedAt: now,
    };
    this.#repository.saveSession(session, "transition");

    if (reviewedOriginal) {
      this.#repository.save(
        {
          ...reviewedOriginal,
          reviewerIds: [...new Set([...reviewedOriginal.reviewerIds, delegation.id])],
          revision: reviewedOriginal.revision + 1,
          acceptanceTicket: undefined,
          updatedAt: now,
        },
        "relation",
      );
    }

    delegation = transitionDelegation(delegation, "starting");
    this.#repository.save(delegation, "transition");
    try {
      if (compatible) {
        await this.#herdr.request("agent.prompt", {
          target: primarySessionPaneId(session),
          text: buildDelegationBrief({
            ...delegation,
            runtimeCwd: normalizedRequest.cwd,
            request: { ...delegation.request, cwd: normalizedRequest.cwd },
          }),
          wait: { until: ["working"], timeout_ms: 30_000 },
        }, { signal, timeoutMs: 35_000 });
        delegation = recordRuntimeStatus({
          ...transitionDelegation(delegation, "working"),
          health: "working",
        }, "working");
        this.#repository.save(delegation, "transition");
        return delegation;
      }
      const launch = await this.#topologies.launch(
        {
          delegationId: session.id,
          parentSessionId: delegation.parentSessionId,
          ownershipToken: ownershipToken(delegation),
          name: normalizedRequest.name,
          cwd: normalizedRequest.cwd,
          topology: normalizedRequest.topology,
          parentPaneId: this.#identity.parentPaneId,
          parentWorkspaceId: this.#identity.parentWorkspaceId,
          parentTabId: this.#identity.parentTabId,
          argv: buildPiArgv(delegation),
          env: buildChildEnv(delegation),
          brief: (runtimeCwd) =>
            buildDelegationBrief({
              ...delegation,
              runtimeCwd,
              request: { ...delegation.request, cwd: runtimeCwd },
            }),
          baseRef: normalizedRequest.baseRef,
          branch: normalizedRequest.branch,
          worktreeRelativeCwd: delegation.authorityBaseline?.gitRoot
            ? relative(delegation.authorityBaseline.gitRoot, normalizedRequest.cwd)
            : undefined,
          onResource: async (resource) => {
            if (resource.kind === "worktree" && resource.path) {
              const auditCwd = delegation.authorityBaseline?.gitRoot
                ? join(
                    resource.path,
                    relative(delegation.authorityBaseline.gitRoot, normalizedRequest.cwd),
                  )
                : resource.path;
              const baseline = await captureAuthorityBaseline(this.#runner, auditCwd);
              session = { ...session, authorityBaseline: baseline };
              delegation = { ...delegation, authorityBaseline: baseline };
            }
            session = upsertSessionResource(session, resource);
            this.#repository.saveSession(session, "resource");
          },
        },
        signal,
      );
      delegation = recordRuntimeStatus({
        ...transitionDelegation(delegation, "working"),
        health: "working",
        runtimeCwd: launch.cwd,
      }, "working");
      session = {
        ...session,
        state: "busy",
        cwd: launch.cwd,
        runtimeCwd: launch.cwd,
        health: "working",
        updatedAt: new Date().toISOString(),
      };
      this.#repository.saveSession(session, "transition");
      this.#repository.save(delegation, "transition");
      return this.get(delegation.id);
    } catch (error) {
      delegation = {
        ...transitionDelegation(delegation, "failed"),
        failure: error instanceof Error ? error.message : String(error),
      };
      session = {
        ...session,
        state: "failed",
        failure: delegation.failure,
        activeRunId: undefined,
        updatedAt: new Date().toISOString(),
      };
      this.#repository.saveSession(session, "transition");
      this.#repository.save(delegation, "transition");
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
        delegationId: delegation.id,
      });
    }
  }

  inspect(id: string, signal?: AbortSignal): Promise<InspectResult> {
    return this.#serialized(id, async () => {
      let delegation = this.get(id);
      if (isHandoffClaimPending(delegation)) throw handoffClaimPending("inspect");
      const paneId = primaryPaneId(delegation);
      const [paneResult, readResult] = await Promise.all([
        this.#herdr.request<{ pane?: Record<string, unknown> }>(
          "pane.get",
          { pane_id: paneId },
          { signal },
        ),
        this.#herdr.request<Record<string, unknown>>(
          "pane.read",
          { pane_id: paneId, source: "recent_unwrapped", lines: 240, format: "text" },
          { signal },
        ),
      ]);
      const paneOutput = extractPaneText(readResult);
      const baseline = delegation.authorityBaseline ?? {
        capturedAt: delegation.createdAt,
        statusLines: [],
      };
      const audit = await auditAuthority(
        this.#runner,
        delegation.runtimeCwd ?? delegation.request.cwd,
        delegation.request.authority,
        baseline,
      );
      delegation = {
        ...delegation,
        evidence: [...delegation.evidence, { ...audit.evidence, paneOutput }],
        acceptanceTicket: audit.ok && delegation.state === "ready_for_review" ? {
          token: randomBytes(18).toString("base64url"),
          revision: delegation.revision,
          inspectedAt: new Date().toISOString(),
        } : undefined,
        health: audit.ok ? delegation.health : "authority_violation",
        updatedAt: new Date().toISOString(),
      };
      this.#repository.save(delegation, "evidence");
      return { delegation, paneOutput, audit, pane: paneResult.pane };
    });
  }

  send(
    id: string,
    message: string,
    options: { questionId?: string; correction?: boolean } = {},
    signal?: AbortSignal,
  ): Promise<Delegation> {
    return this.#serialized(id, async () => {
      let delegation = this.get(id);
      if (!message.trim()) throw new Error("Message cannot be empty");
      if (["accepted", "failed", "cancelled"].includes(delegation.state)) {
        throw new Error(`RUN_TERMINAL: Run ${id} is ${delegation.state}; use holistic_create for a new mission`);
      }
      if (options.correction && delegation.state === "ready_for_review") {
        delegation = transitionDelegation(delegation, "correcting");
      }
      const now = new Date().toISOString();
      const questions = delegation.questions.map((question) =>
        options.questionId && question.id === options.questionId
          ? { ...question, answer: message, answeredAt: now }
          : question,
      );
      delegation = {
        ...beginHandoffCycle(delegation, now),
        questions,
        updatedAt: now,
      };
      this.#repository.save(delegation, options.questionId ? "question" : "transition");
      try {
        await this.#herdr.request(
          "agent.prompt",
          {
            target: primaryPaneId(delegation),
            text: message,
            wait: { until: ["working"], timeout_ms: 30_000 },
          },
          { signal, timeoutMs: 35_000 },
        );
      } catch (error) {
        this.#failPromptDispatch(delegation, error);
        throw error;
      }
      delegation = recordRuntimeStatus(this.get(id), "working");
      this.#repository.save(delegation, "health");
      const session = this.#repository.getSession(delegation.sessionId);
      if (session?.activeRunId === delegation.id) {
        this.#repository.saveSession({
          ...session,
          health: "working",
          updatedAt: delegation.updatedAt,
        }, "health");
      }
      return delegation;
    });
  }

  manage(
    id: string,
    action: ManageAction,
    options: { reason?: string; discardBranch?: boolean } = {},
  ): Promise<Delegation> {
    return this.#serialized(id, async () => {
      let delegation = this.get(id);
      if (action === "focus") {
        await this.#herdr.request("pane.focus", { pane_id: primaryPaneId(delegation) });
        return delegation;
      }
      if (action === "accept") {
        if (isHandoffClaimPending(delegation)) throw handoffClaimPending("accept");
        if (delegation.state !== "ready_for_review") {
          throw new Error(
            `RUN_NOT_REVIEWABLE: Run ${id} is ${delegation.state}; wait for a complete handoff`,
          );
        }
        if (!delegation.acceptanceTicket
          || delegation.acceptanceTicket.revision !== delegation.revision) {
          throw new Error(
            "STALE_INSPECTION: Inspect evidence for the current Run before accepting",
          );
        }
        for (const reviewerId of delegation.reviewerIds) {
          if (this.get(reviewerId).state !== "accepted") {
            throw new Error(`Reviewer delegation ${reviewerId} has not been accepted by the parent`);
          }
        }
        delegation = {
          ...transitionDelegation(delegation, "accepted"),
          health: undefined,
          failure: undefined,
        };
        this.#repository.save(delegation, "transition");
        this.#releaseSession(delegation);
        return delegation;
      }
      if (action === "fail") {
        delegation = {
          ...transitionDelegation(delegation, "failed"),
          failure: options.reason ?? "marked failed by parent",
          health: "failed",
        };
        this.#repository.save(delegation, "transition");
        const session = this.#repository.getSession(delegation.sessionId);
        if (session?.activeRunId === delegation.id) {
          this.#repository.saveSession({
            ...session,
            state: "failed",
            activeRunId: undefined,
            failure: delegation.failure,
            health: "failed",
            updatedAt: new Date().toISOString(),
          }, "transition");
        }
        return delegation;
      }
      let session = this.#repository.getSession(delegation.sessionId)!;
      if (session.state === "busy") {
        if (action === "cleanup") throw sessionBusy();
        if (session.activeRunId !== delegation.id || !isActiveState(delegation.state)) {
          throw sessionBusy();
        }
        const now = new Date().toISOString();
        delegation = {
          ...transitionDelegation(delegation, "cancelled", now),
          failure: options.reason ?? "cancelled by parent for Session close",
          health: "failed",
        };
        this.#repository.save(delegation, "transition");
        session = {
          ...session,
          state: "failed",
          activeRunId: undefined,
          failure: delegation.failure,
          health: "failed",
          updatedAt: now,
        };
        this.#repository.saveSession(session, "transition");
      }
      const closing = {
        ...session,
        state: "closing" as const,
        updatedAt: new Date().toISOString(),
      };
      this.#repository.saveSession(closing, "transition");
      try {
        await this.#cleanup.cleanup(sessionCleanupProjection(delegation, closing), {
          discardBranch: options.discardBranch,
          onResource: (resource) => {
            const current = this.#repository.getSession(session.id)!;
            this.#repository.saveSession(upsertSessionResource(current, resource), "resource");
          },
        });
      } catch (error) {
        const current = this.#repository.getSession(session.id)!;
        this.#repository.saveSession({
          ...current,
          state: "failed",
          health: "failed",
          failure: error instanceof Error ? error.message : String(error),
          updatedAt: new Date().toISOString(),
        }, "transition");
        throw error;
      }
      const current = this.#repository.getSession(session.id)!;
      this.#repository.saveSession({
        ...current,
        state: "closed",
        health: undefined,
        updatedAt: new Date().toISOString(),
      }, "transition");
      return delegation;
    });
  }

  reconcile(snapshot: HerdrSnapshot): ReturnType<typeof reconcileSnapshot> {
    return reconcileSnapshot(this.#repository, snapshot);
  }

  onInfrastructureEvent(event: HerdrSubscriptionEvent): Delegation | undefined {
    return applyInfrastructureEvent(this.#repository, event);
  }

  handleCallbackInput(text: string): CallbackHandlingResult {
    return handleCallbackInput(text, this.#repository);
  }

  #serialized<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(id) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.#queues.set(id, current);
    return current.finally(() => {
      if (this.#queues.get(id) === current) this.#queues.delete(id);
    });
  }

  #releaseSession(run: Delegation): void {
    const session = this.#repository.getSession(run.sessionId);
    if (!session || session.activeRunId !== run.id) return;
    const now = new Date().toISOString();
    this.#repository.saveSession({
      ...session,
      state: "idle",
      activeRunId: undefined,
      health: "idle",
      failure: undefined,
      updatedAt: now,
      lastUsedAt: now,
    }, "transition");
  }

  #failPromptDispatch(run: Delegation, error: unknown): void {
    const current = this.get(run.id);
    if (!isActiveState(current.state)) return;
    const now = new Date().toISOString();
    const failure = `agent.prompt failed after starting revision ${run.revision}: ${errorMessage(error)}`;
    const failed = {
      ...transitionDelegation(current, "failed", now),
      failure,
      health: "failed",
    };
    this.#repository.save(failed, "transition");
    const session = this.#repository.getSession(failed.sessionId);
    if (session?.activeRunId === failed.id) {
      this.#repository.saveSession({
        ...session,
        state: "failed",
        activeRunId: undefined,
        health: "failed",
        failure,
        updatedAt: now,
      }, "transition");
    }
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

function buildChildEnv(delegation: Delegation): Record<string, string> {
  return {
    HOLISTIC_SUBAGENT_DEPTH: "1",
    HOLISTIC_PARENT_PANE_ID: delegation.parentPaneId,
    HOLISTIC_PARENT_SESSION_ID: delegation.parentSessionId,
    HOLISTIC_DELEGATION_ID: delegation.id,
    HOLISTIC_CALLBACK_TOKEN: delegation.callbackToken,
    HOLISTIC_AUTHORITY_POLICY: Buffer.from(
      JSON.stringify(delegation.request.authority),
    ).toString("base64url"),
  };
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
