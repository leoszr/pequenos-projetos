import {
  formatSkillsForPrompt,
  type BuildSystemPromptOptions,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";

export const HOLISTIC_TOOL_NAMES = [
  "holistic_create",
  "holistic_list",
  "holistic_inspect",
  "holistic_send",
  "holistic_manage",
] as const;

const HOLISTIC_TOOL_NAME_SET = new Set<string>(HOLISTIC_TOOL_NAMES);
const MODE_ENTRY_TYPE = "holistic-mode";
const SKILL_NAME = "holistic-subagents";

interface ModeEntryData {
  enabled: boolean;
}

export interface HolisticModeController {
  isEnabled(): boolean;
}

export function registerHolisticMode(pi: ExtensionAPI): HolisticModeController {
  let enabled = false;

  const applyToolAvailability = () => {
    const active = pi.getActiveTools();
    if (enabled) {
      pi.setActiveTools([...new Set([...active, ...HOLISTIC_TOOL_NAMES])]);
      return;
    }
    pi.setActiveTools(active.filter((name) => !HOLISTIC_TOOL_NAME_SET.has(name)));
  };

  const updateStatus = (ctx: ExtensionContext) => {
    const text = enabled
      ? ctx.ui.theme.fg("accent", "subagents: on")
      : ctx.ui.theme.fg("warning", "subagents: off");
    ctx.ui.setStatus("holistic-mode", text);
  };

  const setEnabled = (
    next: boolean,
    ctx: ExtensionContext,
    options: { persist?: boolean; notify?: boolean } = {},
  ) => {
    const changed = enabled !== next;
    enabled = next;
    applyToolAvailability();
    updateStatus(ctx);
    if (changed && options.persist !== false) {
      pi.appendEntry(MODE_ENTRY_TYPE, { enabled } satisfies ModeEntryData);
    }
    if (options.notify) {
      ctx.ui.notify(
        enabled
          ? "Subagent mode enabled. Delegation tools and guidance are available."
          : "Subagent mode disabled. The parent will work directly.",
        "info",
      );
    }
  };

  const toggle = (ctx: ExtensionContext) => setEnabled(!enabled, ctx, { notify: true });

  pi.registerShortcut(Key.ctrlShift("s"), {
    description: "Toggle subagent delegation mode",
    handler: async (ctx) => toggle(ctx),
  });

  pi.registerCommand("holistic-mode", {
    description: "Control subagent delegation mode: on, off, toggle, or status",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase() || "toggle";
      if (action === "on") setEnabled(true, ctx, { notify: true });
      else if (action === "off") setEnabled(false, ctx, { notify: true });
      else if (action === "toggle") toggle(ctx);
      else if (action === "status") {
        updateStatus(ctx);
        ctx.ui.notify(`Subagent mode is ${enabled ? "on" : "off"}.`, "info");
      } else {
        ctx.ui.notify("Usage: /holistic-mode [on|off|toggle|status]", "warning");
      }
    },
  });

  const restore = (ctx: ExtensionContext) => {
    const entry = [...ctx.sessionManager.getBranch()]
      .reverse()
      .find((candidate) => candidate.type === "custom" && candidate.customType === MODE_ENTRY_TYPE);
    const data = entry?.type === "custom" ? entry.data as Partial<ModeEntryData> | undefined : undefined;
    setEnabled(data?.enabled === true, ctx, { persist: false });
  };

  pi.on("session_start", async (_event, ctx) => restore(ctx));
  pi.on("session_tree", async (_event, ctx) => restore(ctx));

  pi.on("before_agent_start", async (event) => {
    if (enabled) return;
    return {
      systemPrompt: removeHolisticSkill(event.systemPrompt, event.systemPromptOptions),
    };
  });

  pi.on("tool_call", async (event) => {
    if (!enabled && event.toolName === "holistic_create") {
      return {
        block: true,
        reason: "Subagent mode is off. Work directly or wait for the user to enable it.",
      };
    }
  });

  return { isEnabled: () => enabled };
}

export function removeHolisticSkill(
  systemPrompt: string,
  options: BuildSystemPromptOptions,
): string {
  const skills = options.skills ?? [];
  const filtered = skills.filter((skill) => skill.name !== SKILL_NAME);
  if (filtered.length === skills.length) return systemPrompt;

  options.skills = filtered;
  const currentBlock = formatSkillsForPrompt(skills);
  const filteredBlock = formatSkillsForPrompt(filtered);
  return currentBlock && systemPrompt.includes(currentBlock)
    ? systemPrompt.replace(currentBlock, filteredBlock)
    : systemPrompt;
}
