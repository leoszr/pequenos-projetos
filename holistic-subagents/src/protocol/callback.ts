import { timingSafeEqual } from "node:crypto";

import {
  beginHandoffCycle,
  beginHandoffCycleFromWorking,
  recordHandoffClaim,
  transitionDelegation,
} from "../domain/state-machine.ts";
import {
  LEGACY_HANDOFF_PROTOCOL_VERSION,
  type AgentSession,
  type Delegation,
  type DelegationQuestion,
} from "../domain/types.ts";

export type CallbackKind = "question" | "input_required" | "handoff_ready";

export interface ParsedCallback {
  kind: CallbackKind;
  delegationId: string;
  paneId: string;
  token: string;
  cycleId?: string;
  questionId?: string;
  manifestId?: string;
  manifestSha256?: string;
}

export interface CallbackHandlingResult {
  matched: boolean;
  valid: boolean;
  transformedText?: string;
  delegation?: Delegation;
  reason?: string;
}

const MARKER_RE = /\[(HOLISTIC_QUESTION|HOLISTIC_INPUT_REQUIRED|HOLISTIC_HANDOFF_READY)\]/;
const SHA256_RE = /^[a-f0-9]{64}$/;

export function parseCallback(text: string): ParsedCallback | undefined {
  const marker = MARKER_RE.exec(text);
  if (!marker) return undefined;
  const fields = new Map<string, string>();
  for (const token of text.slice(marker.index + marker[0].length).trim().split(/\s+/)) {
    const separator = token.indexOf("=");
    if (separator > 0) fields.set(token.slice(0, separator), token.slice(separator + 1));
  }
  const delegationId = fields.get("delegation");
  const paneId = fields.get("pane");
  const token = fields.get("token");
  if (!delegationId || !paneId || !token) return undefined;
  return {
    kind: marker[1] === "HOLISTIC_QUESTION"
      ? "question"
      : marker[1] === "HOLISTIC_INPUT_REQUIRED"
        ? "input_required"
        : "handoff_ready",
    delegationId,
    paneId,
    token,
    cycleId: fields.get("cycle"),
    questionId: fields.get("question"),
    manifestId: fields.get("manifest"),
    manifestSha256: fields.get("sha256"),
  };
}

/** Pure callback reducer. Persistence and ordering belong to SessionMutations. */
export function handleCallbackInput(
  text: string,
  delegation: Delegation | undefined,
  session: AgentSession | undefined,
  now = new Date().toISOString(),
): CallbackHandlingResult {
  const callback = parseCallback(text);
  if (!callback) return { matched: false, valid: false };
  if (!delegation || callback.delegationId !== delegation.id) {
    return { matched: true, valid: false, reason: "unknown delegation" };
  }
  if (!session || session.activeRunId !== delegation.id) {
    return { matched: true, valid: false, reason: "delegation is not the active Run of its Session" };
  }
  if (!safeEqual(callback.token, delegation.callbackToken)) {
    return { matched: true, valid: false, reason: "invalid callback token" };
  }
  const ownsPane = delegation.resources.some(
    (resource) => resource.kind === "pane" && resource.id === callback.paneId,
  );
  if (!ownsPane) return { matched: true, valid: false, reason: "pane is not owned by delegation" };

  const structured = (delegation.handoffProtocolVersion ?? LEGACY_HANDOFF_PROTOCOL_VERSION)
    !== LEGACY_HANDOFF_PROTOCOL_VERSION;
  if (structured && (!callback.cycleId || callback.cycleId !== delegation.handoff?.id)) {
    return { matched: true, valid: false, reason: "callback belongs to a stale or unknown handoff cycle" };
  }
  if (structured && callback.kind === "handoff_ready" && (
    !callback.manifestId || !callback.manifestSha256 || !SHA256_RE.test(callback.manifestSha256)
  )) {
    return { matched: true, valid: false, reason: "structured handoff claim is incomplete" };
  }
  if (callback.kind === "handoff_ready" && delegation.handoff?.claimed) {
    const sameClaim = !structured || (
      delegation.handoff.id === callback.cycleId
      && delegation.handoff.manifestId === callback.manifestId
      && delegation.handoff.manifestSha256 === callback.manifestSha256
    );
    if (!sameClaim) {
      return { matched: true, valid: false, reason: "handoff cycle already has a different claim" };
    }
    return {
      matched: true,
      valid: true,
      delegation,
      transformedText: delegation.state === "ready_for_review"
        ? `Delegation ${delegation.id} has a handoff ready for review. Use holistic_inspect before accepting it.`
        : `Delegation ${delegation.id} claimed a handoff and is waiting for agent_settled before review.`,
    };
  }

  let updated = delegation;
  if (callback.kind === "question" || callback.kind === "input_required") {
    const questionId = callback.questionId ?? `${callback.kind}-${delegation.questions.length + 1}`;
    const existing = delegation.questions.find((question) => question.id === questionId);
    if (!existing) {
      const question: DelegationQuestion = {
        id: questionId,
        blocking: callback.kind === "input_required",
        summary: "Read the child pane for the full question, impact and options.",
        openedAt: now,
      };
      if (!structured) {
        updated = callback.kind === "question"
          ? beginHandoffCycleFromWorking(updated, undefined, now)
          : beginHandoffCycle(updated, undefined, now);
      }
      updated = { ...updated, questions: [...updated.questions, question], updatedAt: now };
    }
    if (callback.kind === "input_required" && updated.state === "working") {
      updated = transitionDelegation(updated, "awaiting_input", now);
    }
    return {
      matched: true,
      valid: true,
      delegation: updated,
      transformedText: callback.kind === "question"
        ? `Delegation ${updated.id} asked a non-blocking question (${questionId}). Inspect its pane and answer with holistic_send.`
        : `Delegation ${updated.id} requires input (${questionId}) and is awaiting a response. Inspect its pane and answer with holistic_send.`,
    };
  }

  updated = recordHandoffClaim(updated, {
    cycleId: callback.cycleId,
    manifestId: callback.manifestId,
    manifestSha256: callback.manifestSha256,
  }, now);
  return {
    matched: true,
    valid: true,
    delegation: updated,
    transformedText: updated.state === "ready_for_review"
      ? `Delegation ${updated.id} has a handoff ready for review. Use holistic_inspect before accepting it.`
      : `Delegation ${updated.id} claimed a handoff and is waiting for agent_settled before review.`,
  };
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
