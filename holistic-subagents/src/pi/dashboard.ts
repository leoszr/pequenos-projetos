import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

import type { DelegationService } from "../domain/service.ts";
import type { Delegation } from "../domain/types.ts";

export function registerHolisticDashboard(
  pi: ExtensionAPI,
  getService: () => DelegationService,
  onChange: (ctx: ExtensionCommandContext) => void,
): void {
  pi.registerCommand("holistic", {
    description: "Open the persistent delegation dashboard",
    handler: async (_args, ctx) => {
      const service = getService();
      if (!ctx.hasUI) {
        pi.sendMessage({
          customType: "holistic-dashboard",
          content: formatList(service.list()),
          display: true,
        });
        return;
      }
      await runDashboard(pi, service, ctx, onChange);
    },
  });
}

async function runDashboard(
  pi: ExtensionAPI,
  service: DelegationService,
  ctx: ExtensionCommandContext,
  onChange: (ctx: ExtensionCommandContext) => void,
): Promise<void> {
  for (;;) {
    const delegations = service.list();
    if (!delegations.length) {
      ctx.ui.notify("No holistic delegations in this session.", "info");
      return;
    }
    const back = "── Close dashboard ──";
    const choices = delegations.map(display);
    const selected = await ctx.ui.select("Holistic delegations", [...choices, back]);
    if (!selected || selected === back) return;
    const delegation = delegations[choices.indexOf(selected)];
    if (!delegation) continue;
    await delegationMenu(pi, service, delegation, ctx);
    onChange(ctx);
  }
}

async function delegationMenu(
  pi: ExtensionAPI,
  service: DelegationService,
  delegation: Delegation,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const actions = [
    "Inspect handoff",
    "Focus pane",
    "Answer / follow up",
    "Request correction",
    "Accept",
    "Mark failed",
    "Close and clean",
    "Back",
  ];
  const action = await ctx.ui.select(display(delegation), actions);
  if (!action || action === "Back") return;
  if (action === "Inspect handoff") {
    const result = await service.inspect(delegation.id);
    pi.sendMessage({
      customType: "holistic-inspection",
      content: `${display(result.delegation)}\nAuthority: ${result.audit.ok ? "ok" : result.audit.violations.join("; ")}\n\n${result.paneOutput}`,
      display: true,
    });
  } else if (action === "Focus pane") {
    await service.manage(delegation.id, "focus");
  } else if (action === "Answer / follow up" || action === "Request correction") {
    const message = await ctx.ui.editor(
      action,
      action === "Request correction" ? "Validation found <failure>. Correct it and report new evidence." : "",
    );
    if (message?.trim()) {
      const openQuestion = delegation.questions.find((question) => !question.answeredAt);
      await service.send(
        delegation.id,
        message,
        {
          questionId: action === "Answer / follow up" ? openQuestion?.id : undefined,
          correction: action === "Request correction",
        },
      );
    }
  } else if (action === "Accept") {
    await service.manage(delegation.id, "accept");
  } else if (action === "Mark failed") {
    const reason = await ctx.ui.input("Failure reason", "Why is this delegation failed?");
    if (reason) await service.manage(delegation.id, "fail", { reason });
  } else if (action === "Close and clean") {
    const confirmed = await ctx.ui.confirm(
      "Close delegation?",
      "This removes only resources owned by the delegation. Dirty worktrees will be preserved.",
    );
    if (confirmed) await service.manage(delegation.id, "close");
  }
}

function display(delegation: Delegation): string {
  return `${delegation.request.name} — ${delegation.state} — ${delegation.id.slice(0, 8)}`;
}

function formatList(delegations: Delegation[]): string {
  return delegations.length
    ? delegations.map((delegation) => `- ${display(delegation)}`).join("\n")
    : "No holistic delegations in this session.";
}
