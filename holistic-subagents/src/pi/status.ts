import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { DelegationService } from "../domain/service.ts";

export function updateHolisticStatus(
  ctx: ExtensionContext,
  service: DelegationService | undefined,
): void {
  if (!service) {
    ctx.ui.setStatus("holistic", undefined);
    return;
  }
  const counts = { working: 0, input: 0, review: 0 };
  for (const delegation of service.list()) {
    if (["starting", "working", "correcting"].includes(delegation.state)) counts.working += 1;
    if (delegation.state === "awaiting_input") counts.input += 1;
    if (delegation.state === "ready_for_review") counts.review += 1;
  }
  const parts = [
    counts.working ? `${counts.working} working` : "",
    counts.input ? `${counts.input} input` : "",
    counts.review ? `${counts.review} review` : "",
  ].filter(Boolean);
  ctx.ui.setStatus(
    "holistic",
    parts.length ? ctx.ui.theme.fg(counts.input ? "warning" : "accent", `holistic: ${parts.join(" · ")}`) : undefined,
  );
}
