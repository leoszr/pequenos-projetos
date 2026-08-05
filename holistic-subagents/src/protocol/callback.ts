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

const MARKER_RE = /\[(HOLISTIC_QUESTION|HOLISTIC_INPUT_REQUIRED|HOLISTIC_HANDOFF_READY)\]/;

/**
 * Wire protocol parser for child Agent callback markers. This module is
 * standalone (no domain imports) so the parent can parse signals without
 * pulling runtime state; authentication and reduction belong to the Handoff
 * Cycle module.
 */
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
