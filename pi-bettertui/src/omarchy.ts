import { existsSync, watch, type FSWatcher } from "node:fs";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export function installOmarchyWatcher(ctx: ExtensionContext): () => void {
  if (ctx.mode !== "tui") return () => {};
  const themeNamePath = join(homedir(), ".config/omarchy/current/theme.name");
  if (!existsSync(themeNamePath)) return () => {};
  let watcher: FSWatcher | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reload = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      regenerateOmarchyTheme(() => {
        const result = ctx.ui.setTheme("omarchy-current");
        if (!result.success) ctx.ui.notify(`omarchy-current theme failed: ${result.error}`, "warning");
        ctx.ui.setStatus("bettertui", undefined);
      });
    }, 120);
    timer.unref?.();
  };
  try {
    watcher = watch(themeNamePath, reload);
  } catch {
    return () => {};
  }
  return () => {
    if (timer) clearTimeout(timer);
    watcher?.close();
  };
}

function regenerateOmarchyTheme(done: () => void): void {
  const bin = join(homedir(), ".local/bin/omarchy-to-pi-theme");
  if (!existsSync(bin)) { done(); return; }
  execFile(bin, { timeout: 3000 }, () => done());
}
