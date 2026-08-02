import {
  SessionMutations,
  type SessionMutationDraft,
} from "../domain/session-mutations.ts";
import {
  isActiveState,
  recordRuntimeStatus,
  transitionDelegation,
} from "../domain/state-machine.ts";
import { DelegationRepository } from "../domain/store.ts";
import {
  isAgentRuntimeStatus,
  type AgentRuntimeStatus,
  type Delegation,
} from "../domain/types.ts";
import type { HerdrSnapshot, HerdrSubscriptionEvent } from "./client.ts";

export interface ReconciliationResult {
  updated: Delegation[];
  orphanPaneIds: string[];
}

export function reconcileSnapshot(
  repository: DelegationRepository,
  mutations: SessionMutations,
  snapshot: HerdrSnapshot,
  now = new Date().toISOString(),
): ReconciliationResult {
  const panes = new Map((snapshot.panes ?? []).map((pane) => [pane.pane_id, pane]));
  const knownDelegationIds = new Set([
    ...repository.list().map((delegation) => delegation.id),
    ...repository.listSessions().map((session) => session.ownershipId),
  ]);
  const updated: Delegation[] = [];

  for (const observed of repository.list()) {
    const paneResource = observed.resources.find((resource) => resource.kind === "pane");
    if (!paneResource || !isActiveState(observed.state)) continue;
    const pane = panes.get(paneResource.id);
    const next = mutations.mutate(observed.sessionId, (draft) => {
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

export function applyInfrastructureEvent(
  repository: DelegationRepository,
  mutations: SessionMutations,
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

  return mutations.mutate(session.id, (draft) => {
    return reduceInfrastructureEvent(draft, event, now);
  }, { kinds: { run: "health", session: "health" } });
}

export function reduceInfrastructureEvent(
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
