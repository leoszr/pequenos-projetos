import { CustomEditor, type ExtensionContext, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { resolvePalette } from "./palette.js";

export interface BetterEditorOptions {
  getTheme(): Theme;
  isIdle(): boolean;
  shutdown(): void;
}

export class PiPaneEditor extends CustomEditor {
  private quitHintUntil = 0;
  private lastEmptyCtrlC = 0;

  constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, private opts: BetterEditorOptions) {
    super(tui, theme, keybindings);
  }

  override handleInput(data: string): void {
    if (matchesKey(data, "ctrl+c")) {
      if (this.getText().length > 0) {
        this.setText("");
        this.clearHint();
        this.tui.requestRender();
        return;
      }
      const now = Date.now();
      if (now - this.lastEmptyCtrlC < 900) {
        this.opts.shutdown();
        return;
      }
      this.lastEmptyCtrlC = now;
      this.quitHintUntil = now + 650;
      setTimeout(() => { this.clearExpiredHint(); this.tui.requestRender(); }, 700).unref?.();
      this.tui.requestRender();
      return;
    }

    this.clearHint();
    super.handleInput(data);
  }

  override render(width: number): string[] {
    const theme = this.opts.getTheme();
    const p = resolvePalette(theme);
    const innerWidth = Math.max(1, width - 2);
    const base = super.render(Math.max(1, innerWidth - 2));
    const lines = base.length ? base : [""];
    const top = p.frame("┌" + "─".repeat(innerWidth) + "┐");
    const bottomText = this.quitHintUntil > Date.now() ? p.hint(" ctrl+c to quit ") : "";
    const bottomFill = Math.max(0, innerWidth - visibleWidth(bottomText));
    const bottom = p.frame("└") + bottomText + p.frame("─".repeat(bottomFill) + "┘");
    const body = lines.map((line, i) => {
      const prefix = i === 0 ? p.prefix("π ") : "  ";
      const available = Math.max(0, innerWidth - visibleWidth(prefix));
      const content = prefix + truncateToWidth(line, available, "");
      const pad = " ".repeat(Math.max(0, innerWidth - visibleWidth(content)));
      return p.frame("│") + p.panelBg(content + pad) + p.frame("│");
    });
    return [truncateToWidth(top, width, ""), ...body.map((l) => truncateToWidth(l, width, "")), truncateToWidth(bottom, width, "")];
  }

  private clearHint(): void { this.quitHintUntil = 0; }
  private clearExpiredHint(): void { if (this.quitHintUntil < Date.now()) this.quitHintUntil = 0; }
}

export function installEditor(ctx: ExtensionContext): void {
  if (ctx.mode !== "tui") return;
  ctx.ui.setEditorComponent((tui, theme, keybindings) => new PiPaneEditor(tui, theme, keybindings, {
    getTheme: () => ctx.ui.theme,
    isIdle: () => ctx.isIdle(),
    shutdown: () => ctx.shutdown(),
  }));
}
