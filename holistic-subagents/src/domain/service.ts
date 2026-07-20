import { randomBytes, randomUUID } from "node:crypto";
import { relative, join } from "node:path";

import { applyInfrastructureEvent, reconcileSnapshot } from "../herdr/reconcile.ts";
import type { HerdrClient, HerdrSnapshot, HerdrSubscriptionEvent } from "../herdr/client.ts";
import { HerdrTopologyManager } from "../herdr/topologies.ts";
import { resolveModel, type AvailableModel } from "../models/resolve.ts";
import { buildDelegationBrief, validateDelegationRequest } from "../protocol/brief.ts";
import { handleCallbackInput, type CallbackHandlingResult } from "../protocol/callback.ts";
import {
  assertAuthorityPreconditions,
  auditAuthority,
  captureAuthorityBaseline,
  type AuthorityAudit,
  type CommandRunner,
} from "../security/authority.ts";
import { DelegationCleanup } from "../security/cleanup.ts";
import { transitionDelegation } from "./state-machine.ts";
import { DelegationRepository } from "./store.ts";
import {
  STORE_VERSION,
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
  readonly #queues = new Map<string, Promise<unknown>>();

  constructor(options: {
    repository: DelegationRepository;
    herdr: HerdrClient;
    runner: CommandRunner;
    identity: CoordinatorIdentity;
    availableModels: () => AvailableModel[];
  }) {
    this.#repository = options.repository;
    this.#herdr = options.herdr;
    this.#runner = options.runner;
    this.#identity = options.identity;
    this.#availableModels = options.availableModels;
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
    validateDelegationRequest(request);
    assertAuthorityPreconditions(request.authority);
    const resolution = resolveModel(request.model, this.#availableModels());
    const now = new Date().toISOString();
    let delegation: Delegation = {
      version: STORE_VERSION,
      id: randomUUID(),
      parentSessionId: this.#identity.parentSessionId,
      parentPaneId: this.#identity.parentPaneId,
      callbackToken: randomBytes(24).toString("base64url"),
      state: "prepared",
      request: structuredClone(request),
      purpose: request.purpose ?? "execution",
      reviewOf: request.reviewOf,
      reviewerIds: [],
      modelResolution: resolution,
      resources: [],
      questions: [],
      evidence: [],
      createdAt: now,
      updatedAt: now,
    };
    delegation.authorityBaseline = await captureAuthorityBaseline(this.#runner, request.cwd, now);
    this.#repository.save(delegation, "created");

    if (request.reviewOf) {
      const original = this.get(request.reviewOf);
      this.#repository.save(
        {
          ...original,
          reviewerIds: [...new Set([...original.reviewerIds, delegation.id])],
          updatedAt: now,
        },
        "relation",
      );
    }

    delegation = transitionDelegation(delegation, "starting");
    this.#repository.save(delegation, "transition");
    try {
      const launch = await this.#topologies.launch(
        {
          delegationId: delegation.id,
          parentSessionId: delegation.parentSessionId,
          ownershipToken: ownershipToken(delegation),
          name: request.name,
          cwd: request.cwd,
          topology: request.topology,
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
          baseRef: request.baseRef,
          branch: request.branch,
          worktreeRelativeCwd: delegation.authorityBaseline?.gitRoot
            ? relative(delegation.authorityBaseline.gitRoot, request.cwd)
            : undefined,
          onResource: async (resource) => {
            if (resource.kind === "worktree" && resource.path) {
              const auditCwd = delegation.authorityBaseline?.gitRoot
                ? join(
                    resource.path,
                    relative(delegation.authorityBaseline.gitRoot, request.cwd),
                  )
                : resource.path;
              delegation = {
                ...delegation,
                authorityBaseline: await captureAuthorityBaseline(this.#runner, auditCwd),
              };
            }
            delegation = upsertResource(delegation, resource);
            this.#repository.save(delegation, "resource");
          },
        },
        signal,
      );
      delegation = {
        ...transitionDelegation(delegation, "working"),
        health: "working",
        runtimeCwd: launch.cwd,
      };
      this.#repository.save(delegation, "transition");
      return delegation;
    } catch (error) {
      delegation = {
        ...transitionDelegation(delegation, "failed"),
        failure: error instanceof Error ? error.message : String(error),
      };
      this.#repository.save(delegation, "transition");
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
        delegationId: delegation.id,
      });
    }
  }

  inspect(id: string, signal?: AbortSignal): Promise<InspectResult> {
    return this.#serialized(id, async () => {
      let delegation = this.get(id);
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
      if (options.correction && delegation.state === "ready_for_review") {
        delegation = transitionDelegation(delegation, "correcting");
        this.#repository.save(delegation, "transition");
      }
      await this.#herdr.request(
        "pane.send_input",
        { pane_id: primaryPaneId(delegation), text: message, keys: ["enter"] },
        { signal },
      );
      const now = new Date().toISOString();
      const questions = delegation.questions.map((question) =>
        options.questionId && question.id === options.questionId
          ? { ...question, answer: message, answeredAt: now }
          : question,
      );
      delegation = { ...delegation, questions, updatedAt: now };
      if (delegation.state === "awaiting_input" || delegation.state === "correcting") {
        delegation = transitionDelegation(delegation, "working", now);
      }
      this.#repository.save(delegation, options.questionId ? "question" : "transition");
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
        if (!delegation.evidence.length) throw new Error("Inspect evidence before accepting");
        for (const reviewerId of delegation.reviewerIds) {
          if (this.get(reviewerId).state !== "accepted") {
            throw new Error(`Reviewer delegation ${reviewerId} has not been accepted by the parent`);
          }
        }
        delegation = transitionDelegation(delegation, "accepted");
        this.#repository.save(delegation, "transition");
        return delegation;
      }
      if (action === "fail") {
        delegation = {
          ...transitionDelegation(delegation, "failed"),
          failure: options.reason ?? "marked failed by parent",
        };
        this.#repository.save(delegation, "transition");
        return delegation;
      }
      if (delegation.state !== "closing") {
        delegation = transitionDelegation(delegation, "closing");
        this.#repository.save(delegation, "transition");
      }
      await this.#cleanup.cleanup(delegation, {
        discardBranch: options.discardBranch,
        onResource: (resource) => {
          delegation = upsertResource(delegation, resource);
          this.#repository.save(delegation, "resource");
        },
      });
      delegation = { ...transitionDelegation(delegation, "closed"), health: undefined };
      this.#repository.save(delegation, "transition");
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
}

function buildPiArgv(delegation: Delegation): string[] {
  const resolution = delegation.modelResolution!;
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

function upsertResource(delegation: Delegation, resource: DelegationResource): Delegation {
  const index = delegation.resources.findIndex(
    (item) => item.kind === resource.kind && item.id === resource.id,
  );
  const resources = [...delegation.resources];
  if (index >= 0) resources[index] = resource;
  else resources.push(resource);
  return { ...delegation, resources, updatedAt: new Date().toISOString() };
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
