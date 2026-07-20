import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export function installIndicator(ctx: ExtensionContext): void {
  if (ctx.mode !== "tui") return;
  const t = ctx.ui.theme;
  ctx.ui.setWorkingIndicator({
    frames: [t.fg("dim", "·"), t.fg("muted", "•"), t.fg("accent", "●"), t.fg("muted", "•")],
    intervalMs: 130,
  });
}
