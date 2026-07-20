import { readFile } from "node:fs/promises";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { detectLuminance, getAnimationEndpoints, getOmarchyThemeName, resolvePalette } from "./palette.js";
import { shortenPath } from "./utils.js";

const LOGO = [
  "     ██  ██",
  "  ██████████████",
  "     ██    ██",
  "     ██    ██",
];

const WHITE = "[38;2;255;255;255m";
const BLACK = "[38;2;0;0;0m";
const RESET_FG = "[39m";
const LOGO_WIDTH = Math.max(...LOGO.map((line) => line.length));

interface VersionState { latest?: string; checked: boolean }

export function installHeader(ctx: ExtensionContext): void {
  if (ctx.mode !== "tui") return;
  const versionState: VersionState = { checked: false };
  void fetchLatest(versionState).then(() => ctx.ui.setStatus("bettertui", undefined));

  ctx.ui.setHeader((tui, theme) => {
    let frame = 0;
    return {
      invalidate() { frame = 0; },
      render(width: number): string[] {
        const p = resolvePalette(theme);
        const logo = renderLogo(theme, frame);
        const themeName = getOmarchyThemeName() ?? theme.name ?? "theme";
        const cwd = shortenPath(ctx.cwd, Math.max(18, width - 24));
        const info = p.muted(`π v${VERSION} · ${themeName} · ${cwd}`);
        const ver = renderVersion(theme, versionState);
        return [...logo.map((l) => truncateToWidth(l, width, "")), truncateToWidth(info, width, ""), ...(ver ? [truncateToWidth(ver, width, "")] : [])];
      },
    };
  });
}

function renderLogo(_theme: Theme, _frame: number): string[] {
  const top = `${WHITE}┌${"─".repeat(LOGO_WIDTH + 2)}┐${RESET_FG}`;
  const body = LOGO.map((line) => {
    const padded = line.padEnd(LOGO_WIDTH, " ");
    return `${WHITE}│ ${BLACK}${padded}${RESET_FG} ${WHITE}│${RESET_FG}`;
  });
  const bottom = `${WHITE}└${"─".repeat(LOGO_WIDTH + 2)}┘${RESET_FG}`;
  return [top, ...body, bottom];
}

function renderVersion(theme: Theme, state: VersionState): string | undefined {
  if (!state.checked) return theme.fg("dim", "checking latest…");
  if (!state.latest) return undefined;
  if (state.latest !== VERSION) return theme.fg("accent", `update available: local v${VERSION} · latest v${state.latest}`);
  return theme.fg("dim", `latest v${state.latest}`);
}

async function fetchLatest(state: VersionState): Promise<void> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    const res = await fetch("https://registry.npmjs.org/@earendil-works/pi-coding-agent/latest", { signal: controller.signal });
    clearTimeout(timeout);
    const data = await res.json() as { version?: string };
    state.latest = data.version;
  } catch {
    // fallback for offline dev: local package if present
    try {
      const pkg = JSON.parse(await readFile("node_modules/@earendil-works/pi-coding-agent/package.json", "utf8")) as { version?: string };
      state.latest = pkg.version;
    } catch {}
  } finally { state.checked = true; }
}
