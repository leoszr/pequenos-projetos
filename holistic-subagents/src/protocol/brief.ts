import type {
  ArtifactRootRegistration,
  Delegation,
  DelegationPurpose,
  DelegationRequest,
} from "../domain/types.ts";

export type NormalizedDelegationRequest = Omit<DelegationRequest, "purpose"> & {
  purpose: DelegationPurpose;
};

export function normalizeDelegationRequest(
  request: DelegationRequest,
): NormalizedDelegationRequest {
  return {
    ...request,
    purpose: request.purpose ?? (request.reviewOf ? "verification" : "execution"),
  };
}

export function buildDelegationBrief(
  delegation: Delegation,
  artifactRoot?: ArtifactRootRegistration,
): string {
  const cycleId = requireHandoffCycle(delegation);
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
    ...(artifactRoot ? structuredHandoffInstructions(delegation, artifactRoot, cycleId) : [
      "Return result, evidence and exact commands, changed files or commits, and uncertainties/risks.",
    ]),
    "Remain available in this session for questions and corrections.",
    "",
    "## Conversation with the parent",
    "You may ask the parent questions. Put the full question, context, impact and options in this pane first.",
    "For a non-blocking doubt, send this signal and continue any safe independent work:",
    callbackCommand(delegation, "HOLISTIC_QUESTION", "question=<short-id>"),
    "If an answer is required for safe progress, send this signal once and end your turn:",
    callbackCommand(delegation, "HOLISTIC_INPUT_REQUIRED", "question=<short-id>"),
    "When work and evidence are complete, send this signal once and end your turn:",
    callbackCommand(
      delegation,
      "HOLISTIC_HANDOFF_READY",
      artifactRoot ? "manifest=$manifest_id sha256=$manifest_sha256" : "",
    ),
    "The parent may reply or ask follow-ups in this same persistent pane.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildFollowUpPrompt(
  delegation: Delegation,
  message: string,
  artifactRoot?: ArtifactRootRegistration,
): string {
  const cycleId = requireHandoffCycle(delegation);
  return [
    message,
    "",
    `Current handoff cycle: ${cycleId}`,
    artifactRoot
      ? `Publish this cycle's manifest atomically under ${artifactRoot.path}/${delegation.id}/${cycleId}/ and signal it with:`
      : "When complete, signal the parent with:",
    callbackCommand(
      delegation,
      "HOLISTIC_HANDOFF_READY",
      artifactRoot ? "manifest=$manifest_id sha256=$manifest_sha256" : "",
    ),
    "For a non-blocking question in this cycle:",
    callbackCommand(delegation, "HOLISTIC_QUESTION", "question=<short-id>"),
    "For blocking input in this cycle, signal once and end the turn:",
    callbackCommand(delegation, "HOLISTIC_INPUT_REQUIRED", "question=<short-id>"),
  ].join("\n");
}

function requireHandoffCycle(delegation: Delegation): string {
  const cycleId = delegation.handoff?.id;
  if (!cycleId) throw new Error(`MISSING_HANDOFF_CYCLE: Delegation ${delegation.id}`);
  return cycleId;
}

function callbackCommand(delegation: Delegation, marker: string, extra = ""): string {
  const cycle = ` cycle=${requireHandoffCycle(delegation)}`;
  const suffix = extra ? ` ${extra}` : "";
  return [
    "```bash",
    `herdr pane run "$HOLISTIC_PARENT_PANE_ID" "[${marker}] delegation=${delegation.id} pane=$HERDR_PANE_ID token=${delegation.callbackToken}${cycle}${suffix}"`,
    "```",
  ].join("\n");
}

function structuredHandoffInstructions(
  delegation: Delegation,
  root: ArtifactRootRegistration,
  cycleId: string,
): string[] {
  return [
    "Publish a structured handoff manifest; pane transcript is diagnostic only.",
    `- authorized temporary artifact root: ${root.path}`,
    `- artifact root id: ${root.id}`,
    `- Run/cycle directory: ${root.path}/${delegation.id}/${cycleId}`,
    "- use opaque file IDs; directories must be 0700 and files 0600",
    "- publish every file with a temporary sibling followed by atomic rename",
    "- manifest JSON fields: protocolVersion=1, cycleId, summary, commands[], files[], commits[], risks[], artifacts[]",
    "- each artifact ref fields: id, rootId, mediaType, size, sha256",
    "- hash the exact final manifest bytes with lowercase SHA-256",
    "Set shell variables manifest_id and manifest_sha256 before the final callback.",
  ];
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
  if (request.reviewOf && request.purpose === "execution") {
    throw new Error("reviewOf requires verification purpose");
  }
  if (request.authority.mode === "isolated_mutation" && request.topology !== "worktree") {
    throw new Error("isolated_mutation requires worktree topology");
  }
}
