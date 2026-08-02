import type { AgentRuntimeStatus, Delegation, DelegationState } from "./types.ts";

const transitions: Readonly<Record<DelegationState, readonly DelegationState[]>> = {
  prepared: ["starting", "failed", "cancelled"],
  starting: ["working", "failed", "cancelled"],
  working: ["awaiting_input", "ready_for_review", "failed", "cancelled"],
  awaiting_input: ["working", "failed", "cancelled"],
  ready_for_review: ["working", "correcting", "accepted", "failed", "cancelled"],
  correcting: ["working", "failed", "cancelled"],
  accepted: [],
  failed: [],
  cancelled: [],
};

export class InvalidDelegationTransition extends Error {
  constructor(from: DelegationState, to: DelegationState) {
    super(`Invalid delegation transition: ${from} -> ${to}`);
    this.name = "InvalidDelegationTransition";
  }
}

export function canTransition(from: DelegationState, to: DelegationState): boolean {
  return from === to || transitions[from].includes(to);
}

export function transitionDelegation(
  delegation: Delegation,
  to: DelegationState,
  now = new Date().toISOString(),
): Delegation {
  if (delegation.state === to) return delegation;
  if (!canTransition(delegation.state, to)) {
    throw new InvalidDelegationTransition(delegation.state, to);
  }
  return { ...delegation, state: to, updatedAt: now };
}

export function isActiveState(state: DelegationState): boolean {
  return !["accepted", "failed", "cancelled"].includes(state);
}

/**
 * Starts a new child-work cycle for a parent prompt and invalidates both sides
 * of the prior handoff as well as its inspection.
 */
export function beginHandoffCycle(
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

/** Legacy compatibility: old question callbacks started an implicit cycle. */
export function beginHandoffCycleFromWorking(
  delegation: Delegation,
  cycleId?: string,
  now = new Date().toISOString(),
): Delegation {
  return recordRuntimeStatus(beginHandoffCycle(delegation, cycleId, now), "working", now);
}

/** Records a semantic handoff claim and promotes only if this revision settled. */
export function recordHandoffClaim(
  delegation: Delegation,
  claim?: { cycleId?: string; manifestId?: string; manifestSha256?: string },
  now = new Date().toISOString(),
): Delegation {
  if (claim?.cycleId && delegation.handoff?.id !== claim.cycleId) return delegation;
  if (!["starting", "working"].includes(delegation.state)) return delegation;
  return settleHandoff({
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
  }, now);
}

/**
 * Records Herdr's current runtime status. Pi maps agent_settled to idle, but
 * idle is only a settlement after this same revision was observed working.
 */
export function recordRuntimeStatus(
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

export function isHandoffClaimPending(delegation: Delegation): boolean {
  return delegation.handoff?.claimed === true && delegation.handoff.settled !== true;
}

function settleHandoff(delegation: Delegation, now: string): Delegation {
  return delegation.state === "working"
      && delegation.handoff?.claimed === true
      && delegation.handoff.settled === true
    ? transitionDelegation(delegation, "ready_for_review", now)
    : delegation;
}
