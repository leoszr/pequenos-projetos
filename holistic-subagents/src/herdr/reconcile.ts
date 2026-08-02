import {
  isActiveState,
  recordRuntimeStatus,
  transitionDelegation,
} from "../domain/state-machine.ts";
import { DelegationRepository } from "../domain/store.ts";
import {
  isAgentRuntimeStatus,
  type AgentRuntimeStatus,
  type AgentSession,
  type Delegation,
} from "../domain/types.ts";
import type { HerdrSnapshot, HerdrSubscriptionEvent } from "./client.ts";

export interface ReconciliationResult {
  updated: Delegation[];
  orphanPaneIds: string[];
}

export function reconcileSnapshot(
  repository: DelegationRepository,
  snapshot: HerdrSnapshot,
  now = new Date().toISOString(),
): ReconciliationResult {
  const panes = new Map((snapshot.panes ?? []).map((pane) => [pane.pane_id, pane]));
  const knownDelegationIds = new Set([
    ...repository.list().map((delegation) => delegation.id),
    ...repository.listSessions().map((session) => session.ownershipId),
  ]);
  const updated: Delegation[] = [];

  for (const delegation of repository.list()) {
    const paneResource = delegation.resources.find((resource) => resource.kind === "pane");
    if (!paneResource || !isActiveState(delegation.state)) continue;
    const pane = panes.get(paneResource.id);
    let next = delegation;
    if (!pane) {
      next = transitionDelegation(delegation, "failed", now);
      next = { ...next, failure: "owned pane is missing from Herdr snapshot", health: "missing" };
    } else {
      const owner = pane.tokens?.owner;
      if (owner && owner !== delegation.resources[0]?.ownershipToken.slice(0, 32)) {
        next = transitionDelegation(delegation, "failed", now);
        next = { ...next, failure: "Herdr ownership metadata diverged", health: "ownership_mismatch" };
      } else {
        next = persistRuntimeStatus(repository, next, pane.agent_status, now);
        updated.push(next);
        continue;
      }
    }
    repository.save(
      next,
      next.state !== delegation.state ? "transition" : "health",
    );
    if (next.state === "failed" && delegation.sessionId) {
      const session = repository.getSession(delegation.sessionId);
      if (session) repository.saveSession({ ...session, state: "failed", activeRunId: undefined, failure: next.failure, health: next.health, updatedAt: now }, "transition");
    }
    updated.push(next);
  }

  const orphanPaneIds = (snapshot.panes ?? [])
    .filter((pane) => pane.tokens?.delegation && !knownDelegationIds.has(pane.tokens.delegation))
    .map((pane) => pane.pane_id);
  return { updated, orphanPaneIds };
}

export function applyInfrastructureEvent(
  repository: DelegationRepository,
  event: HerdrSubscriptionEvent,
  now = new Date().toISOString(),
): Delegation | undefined {
  const data = (event.data ?? event) as Record<string, unknown>;
  const paneId = typeof data.pane_id === "string" ? data.pane_id : undefined;
  if (!paneId) return undefined;
  const session = repository.listSessions().find((candidate) =>
    candidate.resources.some((resource) => resource.kind === "pane" && resource.id === paneId),
  );
  if (!session?.activeRunId) return undefined;
  const delegation = repository.get(session.activeRunId);
  if (!delegation) return undefined;

  const kind = String(data.type ?? event.event);
  if ((kind.includes("closed") || kind.includes("exited")) && isActiveState(delegation.state)) {
    const failed = {
      ...transitionDelegation(delegation, "failed", now),
      failure: `Herdr reported ${kind}`,
      health: "exited",
    };
    repository.save(failed, "transition");
    repository.saveSession({ ...session, state: "failed", failure: failed.failure, health: "exited", activeRunId: undefined, updatedAt: now }, "transition");
    return failed;
  }
  const status = isAgentRuntimeStatus(data.agent_status) ? data.agent_status : undefined;
  if (status) {
    return persistRuntimeStatus(repository, delegation, status, now, session);
  }
  return undefined;
}

function persistRuntimeStatus(
  repository: DelegationRepository,
  delegation: Delegation,
  status: AgentRuntimeStatus,
  now: string,
  knownSession?: AgentSession,
): Delegation {
  const updated = recordRuntimeStatus(delegation, status, now);
  repository.save(updated, updated.state !== delegation.state ? "transition" : "health");
  const session = knownSession ?? repository.getSession(delegation.sessionId);
  if (session) {
    repository.saveSession({ ...session, health: status, updatedAt: now }, "health");
  }
  return updated;
}
