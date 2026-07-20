import type { Delegation, DelegationRequest } from "../domain/types.ts";

export function buildDelegationBrief(delegation: Delegation): string {
  const request = delegation.request;
  return [
    "You are an auxiliary Pi session created by the main agent for one bounded task.",
    "Do not create or control additional agent sessions.",
    "",
    "## Mission",
    request.mission,
    "",
    "## Context",
    `- cwd: ${request.cwd}`,
    request.context ? `- context: ${request.context}` : "- no additional parent transcript was provided",
    request.baseRef ? `- base ref: ${request.baseRef}` : "",
    delegation.reviewOf ? `- verify delegation: ${delegation.reviewOf}` : "",
    "",
    "## Authority",
    `- mode: ${request.authority.mode}`,
    `- allowed paths: ${formatList(request.authority.allowedPaths)}`,
    request.authority.forbiddenPaths?.length
      ? `- forbidden paths: ${formatList(request.authority.forbiddenPaths)}`
      : "",
    "Treat this authority as binding. It is policy, not a filesystem sandbox.",
    "",
    "## Acceptance evidence",
    ...request.acceptanceEvidence.map((item) => `- ${item}`),
    "",
    "## Return",
    "Return result, evidence and exact commands, changed files or commits, and uncertainties/risks.",
    "Remain available in this session for questions and corrections.",
    "",
    "## Conversation with the parent",
    "You may ask the parent questions. Put the full question, context, impact and options in this pane first.",
    "For a non-blocking doubt, send this signal and continue any safe independent work:",
    callbackCommand("HOLISTIC_QUESTION", "question=<short-id>"),
    "If an answer is required for safe progress, send this signal once and end your turn:",
    callbackCommand("HOLISTIC_INPUT_REQUIRED", "question=<short-id>"),
    "When work and evidence are complete, send this signal once and end your turn:",
    callbackCommand("HOLISTIC_HANDOFF_READY"),
    "The parent may reply or ask follow-ups in this same persistent pane.",
  ]
    .filter(Boolean)
    .join("\n");
}

function callbackCommand(marker: string, extra = ""): string {
  const suffix = extra ? ` ${extra}` : "";
  return [
    "```bash",
    `herdr pane run "$HOLISTIC_PARENT_PANE_ID" "[${marker}] delegation=$HOLISTIC_DELEGATION_ID pane=$HERDR_PANE_ID token=$HOLISTIC_CALLBACK_TOKEN${suffix}"`,
    "```",
  ].join("\n");
}

function formatList(values: string[]): string {
  return values.length ? values.join(", ") : "none (workspace-wide read policy only)";
}

export function validateDelegationRequest(request: DelegationRequest): void {
  if (!request.name.trim()) throw new Error("Delegation name is required");
  if (!request.mission.trim()) throw new Error("Delegation mission is required");
  if (!request.cwd.startsWith("/")) throw new Error("Delegation cwd must be absolute");
  if (request.purpose === "verification" && !request.reviewOf) {
    throw new Error("Verification delegation requires reviewOf");
  }
  if (request.authority.mode === "isolated_mutation" && request.topology !== "worktree") {
    throw new Error("isolated_mutation requires worktree topology");
  }
}
