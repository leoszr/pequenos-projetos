import type { Delegation, DelegationState } from "./types.ts";

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
