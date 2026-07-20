import { isActiveState, transitionDelegation } from "../domain/state-machine.ts";
import { DelegationRepository } from "../domain/store.ts";
import type { Delegation } from "../domain/types.ts";
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
  const knownDelegationIds = new Set(repository.list().map((delegation) => delegation.id));
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
        next = { ...next, health: pane.agent_status, updatedAt: now };
      }
    }
    repository.save(next, next.state === "failed" ? "transition" : "health");
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
  const delegation = repository.list().find((candidate) =>
    candidate.resources.some((resource) => resource.kind === "pane" && resource.id === paneId),
  );
  if (!delegation) return undefined;

  const kind = String(data.type ?? event.event);
  if ((kind.includes("closed") || kind.includes("exited")) && isActiveState(delegation.state)) {
    const failed = {
      ...transitionDelegation(delegation, "failed", now),
      failure: `Herdr reported ${kind}`,
      health: "exited",
    };
    repository.save(failed, "transition");
    return failed;
  }
  const status = typeof data.agent_status === "string" ? data.agent_status : undefined;
  if (status) {
    const updated = { ...delegation, health: status, updatedAt: now };
    repository.save(updated, "health");
    return updated;
  }
  return undefined;
}
