import type { Delegation, DelegationState } from "./types.ts";

const transitions: Readonly<Record<DelegationState, readonly DelegationState[]>> = {
  prepared: ["starting", "failed", "closing"],
  starting: ["working", "failed", "closing"],
  working: ["awaiting_input", "ready_for_review", "failed", "closing"],
  awaiting_input: ["working", "failed", "closing"],
  ready_for_review: ["correcting", "accepted", "failed", "closing"],
  correcting: ["working", "failed", "closing"],
  accepted: ["closing"],
  failed: ["closing"],
  closing: ["closed", "failed"],
  closed: [],
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
  return !["accepted", "failed", "closed"].includes(state);
}
