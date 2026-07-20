import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { installEditor } from "./editor.js";
import { bindFooterEvents, installFooter, type TimingState } from "./footer.js";
import { installHeader } from "./header.js";
import { installIndicator } from "./indicator.js";
import { installOmarchyWatcher } from "./omarchy.js";

interface RuntimeState { enabled: boolean; cleanup: Array<() => void>; timing: TimingState }

export default function (pi: ExtensionAPI) {
  const state: RuntimeState = { enabled: true, cleanup: [], timing: {} };
  bindFooterEvents(pi, state.timing);

  pi.on("session_start", (_event, ctx) => {
    restoreState(ctx, state);
    if (state.enabled) enable(ctx, state);
  });

  pi.on("session_shutdown", () => disableRuntime(state));

  pi.registerCommand("bettertui", {
    description: "Control pi-bettertui: enable, disable, status, reload",
    handler: async (args, ctx) => {
      const cmd = args.trim() || "status";
      if (cmd === "enable") {
        state.enabled = true;
        persist(pi, true);
        enable(ctx, state);
        ctx.ui.notify("bettertui enabled", "info");
        return;
      }
      if (cmd === "disable") {
        state.enabled = false;
        persist(pi, false);
        disable(ctx, state);
        ctx.ui.notify("bettertui disabled", "info");
        return;
      }
      if (cmd === "reload") {
        disable(ctx, state);
        if (state.enabled) enable(ctx, state);
        ctx.ui.notify("bettertui reloaded", "info");
        return;
      }
      if (cmd === "status") {
        ctx.ui.notify(`bettertui ${state.enabled ? "enabled" : "disabled"}`, "info");
        return;
      }
      ctx.ui.notify("usage: /bettertui enable|disable|status|reload", "warning");
    },
    getArgumentCompletions(prefix) {
      return ["enable", "disable", "status", "reload"].filter((v) => v.startsWith(prefix)).map((v) => ({ value: v, label: v }));
    },
  });
}

function enable(ctx: ExtensionContext, state: RuntimeState): void {
  if (ctx.mode !== "tui") return;
  disableRuntime(state);
  installHeader(ctx);
  installFooter(ctx, state.timing);
  installEditor(ctx);
  installIndicator(ctx);
  state.cleanup.push(installOmarchyWatcher(ctx));
}

function disable(ctx: ExtensionContext, state: RuntimeState): void {
  disableRuntime(state);
  ctx.ui.setHeader(undefined);
  ctx.ui.setFooter(undefined);
  ctx.ui.setEditorComponent(undefined);
  ctx.ui.setWorkingIndicator();
  ctx.ui.setStatus("bettertui", undefined);
}

function disableRuntime(state: RuntimeState): void {
  for (const fn of state.cleanup.splice(0)) {
    try { fn(); } catch {}
  }
}

function persist(pi: ExtensionAPI, enabled: boolean): void {
  pi.appendEntry("bettertui-state", { enabled });
}

function restoreState(ctx: ExtensionContext, state: RuntimeState): void {
  for (const e of ctx.sessionManager.getEntries()) {
    if (e.type === "custom" && e.customType === "bettertui-state") {
      const data = e.data as { enabled?: boolean } | undefined;
      if (typeof data?.enabled === "boolean") state.enabled = data.enabled;
    }
  }
}
