import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { resolvePalette } from "./palette.js";
import { fitTwoColumns, fmtNum, shortenPath } from "./utils.js";

export interface TimingState { turnStartedAt?: number; lastResponseMs?: number }

interface UsageTotals {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export function installFooter(ctx: ExtensionContext, _timing: TimingState): void {
  if (ctx.mode !== "tui") return;

  ctx.ui.setFooter((_tui, theme) => ({
    invalidate() {},
    render(width: number): string[] {
      const p = resolvePalette(theme);
      const cwd = p.dim(shortenPath(ctx.cwd, Math.max(20, width - 2)));

      const usage = collectUsage(ctx);
      const maxCtx = getMaxContext(ctx);
      const usedCtx = getUsedContext(ctx, usage);
      const pct = maxCtx > 0 ? Math.min(999, (usedCtx / maxCtx) * 100) : 0;
      const cacheHit = cacheHitPercent(usage);
      const auth = getAuthLabel(ctx);
      const thinking = getThinking(ctx);
      const model = ctx.model?.id ?? "no-model";
      const api = formatApi(ctx.model);

      const leftRaw = [
        `↑${fmtNum(usage.input)}`,
        `↓${fmtNum(usage.output)}`,
        `R${fmtNum(usage.reasoning)}`,
        `CH${cacheHit.toFixed(1)}%`,
        `$${usage.cost.toFixed(3)}`,
        auth,
        `${pct.toFixed(1)}%/${fmtNum(maxCtx)}`,
        "(auto)",
      ].filter(Boolean).join(" ");

      const rightRaw = `(${api}) ${model} • ${thinking}`;
      const second = fitTwoColumns(p.dim(leftRaw), p.dim(rightRaw), width);
      return [truncateToWidth(cwd, width, ""), truncateToWidth(second, width, "")];
    },
  }));
}

export function bindFooterEvents(pi: ExtensionAPI, timing: TimingState): void {
  pi.on("turn_start", (event) => { timing.turnStartedAt = event.timestamp ?? Date.now(); });
  pi.on("turn_end", (_event, ctx) => {
    if (timing.turnStartedAt) timing.lastResponseMs = Date.now() - timing.turnStartedAt;
    ctx.ui.setStatus("bettertui", undefined);
  });
  pi.on("message_end", (_event, ctx) => { ctx.ui.setStatus("bettertui", undefined); });
}

function collectUsage(ctx: ExtensionContext): UsageTotals {
  const total: UsageTotals = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const e of ctx.sessionManager.getBranch()) {
    if (e.type !== "message" || e.message.role !== "assistant") continue;
    const m = e.message as AssistantMessage;
    total.input += m.usage?.input ?? 0;
    total.output += m.usage?.output ?? 0;
    total.reasoning += m.usage?.reasoning ?? 0;
    total.cacheRead += m.usage?.cacheRead ?? 0;
    total.cacheWrite += m.usage?.cacheWrite ?? 0;
    total.cost += m.usage?.cost?.total ?? 0;
  }
  return total;
}

function cacheHitPercent(u: UsageTotals): number {
  const denom = u.input + u.cacheRead + u.cacheWrite;
  if (denom <= 0) return 0;
  return (u.cacheRead / denom) * 100;
}

function getUsedContext(ctx: ExtensionContext, usage: UsageTotals): number {
  try {
    const context = ctx.getContextUsage?.();
    if (context?.tokens) return context.tokens;
  } catch {}
  return usage.input + usage.output;
}

function getMaxContext(ctx: ExtensionContext): number {
  const model = ctx.model as unknown as { maxInputTokens?: number; contextWindow?: number; context_window?: number } | undefined;
  return model?.maxInputTokens ?? model?.contextWindow ?? model?.context_window ?? 200_000;
}

function getThinking(ctx: ExtensionContext): string {
  const anyCtx = ctx as unknown as { thinking?: string };
  return anyCtx.thinking ?? "off";
}

function getAuthLabel(ctx: ExtensionContext): string {
  try {
    if (ctx.model && ctx.modelRegistry.isUsingOAuth(ctx.model)) return "(sub)";
  } catch {}
  return "";
}

function formatApi(model: unknown): string {
  const m = model as { api?: string; provider?: string } | undefined;
  const api = m?.api ?? m?.provider ?? "unknown";
  return api.replace(/-responses$/, "").replace(/-messages$/, "").replace(/-completions$/, "");
}
