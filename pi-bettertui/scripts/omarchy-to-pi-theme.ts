#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const home = homedir();
const themeDir = join(home, ".config/omarchy/current/theme");
const outDir = join(home, ".pi/agent/themes");
const out = join(outDir, "omarchy-current.json");

function readColor(name: string, fallback: string): string {
  try {
    const toml = readFileSync(join(themeDir, "colors.toml"), "utf8");
    const m = toml.match(new RegExp(`${name}\\s*=\\s*["'](#?[0-9a-fA-F]{6})["']`));
    return m ? `#${m[1]!.replace("#", "")}` : fallback;
  } catch { return fallback; }
}

const light = existsSync(join(themeDir, "light.mode"));
const bg = readColor("background", light ? "#ffffff" : "#0b0d10");
const fg = readColor("foreground", light ? "#1f2328" : "#e5e7eb");
const accent = readColor("accent", readColor("blue", light ? "#005f87" : "#7aa2f7"));
const muted = light ? "#5f6975" : "#9aa4b2";
const dim = light ? "#7b8490" : "#6f7885";
const borderMuted = light ? "#c4c9d1" : "#303642";
const panel = light ? "#f3f5f7" : "#11151b";

const colors = {
  accent, border: borderMuted, borderAccent: accent, borderMuted, success: light ? "#1a7f37" : "#8bd17c", error: light ? "#cf222e" : "#ff7b72", warning: light ? "#9a6700" : "#e3b341", muted, dim, text: fg, thinkingText: fg,
  selectedBg: panel, userMessageBg: panel, userMessageText: fg, customMessageBg: panel, customMessageText: fg, customMessageLabel: accent, toolPendingBg: panel, toolSuccessBg: panel, toolErrorBg: panel, toolTitle: accent, toolOutput: fg,
  mdHeading: accent, mdLink: accent, mdLinkUrl: muted, mdCode: fg, mdCodeBlock: fg, mdCodeBlockBorder: borderMuted, mdQuote: muted, mdQuoteBorder: borderMuted, mdHr: borderMuted, mdListBullet: accent,
  toolDiffAdded: light ? "#1a7f37" : "#8bd17c", toolDiffRemoved: light ? "#cf222e" : "#ff7b72", toolDiffContext: muted,
  syntaxComment: dim, syntaxKeyword: accent, syntaxFunction: light ? "#8250df" : "#d2a8ff", syntaxVariable: fg, syntaxString: light ? "#0a3069" : "#a5d6ff", syntaxNumber: light ? "#953800" : "#f2cc60", syntaxType: accent, syntaxOperator: muted, syntaxPunctuation: muted,
  thinkingOff: dim, thinkingMinimal: muted, thinkingLow: accent, thinkingMedium: accent, thinkingHigh: accent, thinkingXhigh: accent, bashMode: accent,
};

mkdirSync(outDir, { recursive: true });
writeFileSync(out, JSON.stringify({ name: "omarchy-current", meta: { luminance: light ? "light" : "dark" }, colors }, null, 2) + "\n");
console.log(out);
