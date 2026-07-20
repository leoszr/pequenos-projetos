import { timingSafeEqual } from "node:crypto";

import { transitionDelegation } from "../domain/state-machine.ts";
import { DelegationRepository } from "../domain/store.ts";
import type { Delegation, DelegationQuestion } from "../domain/types.ts";

export type CallbackKind = "question" | "input_required" | "handoff_ready";

export interface ParsedCallback {
  kind: CallbackKind;
  delegationId: string;
  paneId: string;
  token: string;
  questionId?: string;
}

export interface CallbackHandlingResult {
  matched: boolean;
  valid: boolean;
  transformedText?: string;
  delegation?: Delegation;
  reason?: string;
}

const CALLBACK_RE =
  /\[(HOLISTIC_QUESTION|HOLISTIC_INPUT_REQUIRED|HOLISTIC_HANDOFF_READY)\]\s+delegation=([^\s]+)\s+pane=([^\s]+)\s+token=([^\s]+)(?:\s+question=([^\s]+))?/;

export function parseCallback(text: string): ParsedCallback | undefined {
  const match = CALLBACK_RE.exec(text);
  if (!match) return undefined;
  const marker = match[1]!;
  return {
    kind: marker === "HOLISTIC_QUESTION"
      ? "question"
      : marker === "HOLISTIC_INPUT_REQUIRED"
        ? "input_required"
        : "handoff_ready",
    delegationId: match[2]!,
    paneId: match[3]!,
    token: match[4]!,
    questionId: match[5],
  };
}

export function handleCallbackInput(
  text: string,
  repository: DelegationRepository,
  now = new Date().toISOString(),
): CallbackHandlingResult {
  const callback = parseCallback(text);
  if (!callback) return { matched: false, valid: false };
  const delegation = repository.get(callback.delegationId);
  if (!delegation) return { matched: true, valid: false, reason: "unknown delegation" };
  if (!safeEqual(callback.token, delegation.callbackToken)) {
    return { matched: true, valid: false, reason: "invalid callback token" };
  }
  const ownsPane = delegation.resources.some(
    (resource) => resource.kind === "pane" && resource.id === callback.paneId,
  );
  if (!ownsPane) return { matched: true, valid: false, reason: "pane is not owned by delegation" };

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
      updated = {
        ...updated,
        questions: [...updated.questions, question],
        updatedAt: now,
      };
    }
    if (callback.kind === "input_required" && updated.state === "working") {
      updated = transitionDelegation(updated, "awaiting_input", now);
    }
    repository.save(updated, "question");
    return {
      matched: true,
      valid: true,
      delegation: updated,
      transformedText: callback.kind === "question"
        ? `Delegation ${updated.id} asked a non-blocking question (${questionId}). Inspect its pane and answer with holistic_send.`
        : `Delegation ${updated.id} requires input (${questionId}) and is awaiting a response. Inspect its pane and answer with holistic_send.`,
    };
  }

  if (updated.state === "working") {
    updated = transitionDelegation(updated, "ready_for_review", now);
    repository.save(updated, "transition");
  }
  return {
    matched: true,
    valid: true,
    delegation: updated,
    transformedText: `Delegation ${updated.id} has a handoff ready for review. Use holistic_inspect before accepting it.`,
  };
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
