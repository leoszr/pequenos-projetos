import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Rgb } from "./utils.js";
import { parseAnsiRgb, wcagLuminance } from "./utils.js";

export type Luminance = "light" | "dark";

export interface PanePalette {
  frame(text: string): string;
  prefix(text: string): string;
  time(text: string): string;
  hint(text: string): string;
  muted(text: string): string;
  dim(text: string): string;
  accent(text: string): string;
  warning(text: string): string;
  error(text: string): string;
  panelBg(text: string): string;
  panelEdge: string;
}

export function detectLuminance(theme: Theme): Luminance {
  const omarchy = getOmarchyMode();
  if (omarchy) return omarchy;

  const bg = parseAnsiRgb(theme.getBgAnsi?.("userMessageBg") ?? theme.bg("userMessageBg", " "));
  if (bg) return wcagLuminance(bg) >= 0.5 ? "light" : "dark";

  const name = theme.name?.toLowerCase() ?? "";
  if (name.includes("light")) return "light";
  return "dark";
}

export function resolvePalette(theme: Theme): PanePalette {
  return {
    frame: (text) => theme.fg("borderMuted", text),
    prefix: (text) => theme.fg("accent", theme.bold(text)),
    time: (text) => theme.fg("muted", text),
    hint: (text) => theme.fg("dim", text),
    muted: (text) => theme.fg("muted", text),
    dim: (text) => theme.fg("dim", text),
    accent: (text) => theme.fg("accent", text),
    warning: (text) => theme.fg("warning", text),
    error: (text) => theme.fg("error", text),
    panelBg: (text) => theme.bg("userMessageBg", text),
    panelEdge: theme.getBgAnsi?.("userMessageBg") ?? "",
  };
}

export function getAnimationEndpoints(theme: Theme, luminance: Luminance): { bgStart: Rgb; fgEnd: Rgb } {
  const fgEnd = getOmarchyAccent() ?? parseAnsiRgb(theme.getFgAnsi?.("accent") ?? theme.fg("accent", "x")) ?? (luminance === "light" ? [0, 0, 0] : [255, 255, 255]);
  const realBg = parseAnsiRgb(theme.getBgAnsi?.("userMessageBg") ?? theme.bg("userMessageBg", " "));
  const bgStart = realBg ?? (luminance === "light" ? [255, 255, 255] : [0, 0, 0]);
  return { bgStart, fgEnd };
}

export function getOmarchyThemeName(): string | undefined {
  const path = join(homedir(), ".config/omarchy/current/theme.name");
  try {
    const s = readFileSync(path, "utf8").trim();
    return s || undefined;
  } catch {
    return undefined;
  }
}

export function getOmarchyMode(): Luminance | undefined {
  const themeDir = join(homedir(), ".config/omarchy/current/theme");
  if (existsSync(join(themeDir, "light.mode"))) return "light";
  return undefined;
}

export function getOmarchyAccent(): Rgb | undefined {
  const p = join(homedir(), ".config/omarchy/current/theme/colors.toml");
  try {
    const toml = readFileSync(p, "utf8");
    const m = toml.match(/(?:accent|blue)\s*=\s*["'](#?[0-9a-fA-F]{6})["']/);
    if (!m) return undefined;
    const hex = m[1]!.replace("#", "");
    return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
  } catch {
    return undefined;
  }
}
