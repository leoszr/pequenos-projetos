import { homedir } from "node:os";
import { relative } from "node:path";
import { visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";

export type Rgb = [number, number, number];

export function hasTruecolor(env = process.env): boolean {
  return /truecolor|24bit/i.test(env.COLORTERM ?? "");
}

export function ansiFg([r, g, b]: Rgb, text: string): string {
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
}

export function lerpRgb(a: Rgb, b: Rgb, t: number): Rgb {
  const p = Math.max(0, Math.min(1, t));
  return [
    Math.round(a[0] + (b[0] - a[0]) * p),
    Math.round(a[1] + (b[1] - a[1]) * p),
    Math.round(a[2] + (b[2] - a[2]) * p),
  ];
}

export function wcagLuminance([r, g, b]: Rgb): number {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function parseAnsiRgb(ansi: string): Rgb | undefined {
  const m = ansi.match(/\x1b\[(?:38|48);2;(\d{1,3});(\d{1,3});(\d{1,3})m/);
  if (!m) return undefined;
  const rgb = [Number(m[1]), Number(m[2]), Number(m[3])] as Rgb;
  return rgb.every((n) => Number.isFinite(n) && n >= 0 && n <= 255) ? rgb : undefined;
}

export function shortenPath(path: string, max = 48): string {
  const home = homedir();
  let out = path.startsWith(home) ? `~/${relative(home, path)}` : path;
  if (out === "~/") out = "~";
  return visibleWidth(out) > max ? truncateToWidth(out, max, "…") : out;
}

export function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${Math.round(n)}`;
}

export function fmtMs(ms: number | undefined): string {
  if (!ms || ms < 0) return "--";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

export function fitTwoColumns(left: string, right: string, width: number): string {
  const lw = visibleWidth(left);
  const rw = visibleWidth(right);
  if (lw + 1 + rw <= width) return left + " ".repeat(width - lw - rw) + right;
  const half = Math.max(8, Math.floor((width - 1) / 2));
  const l = truncateToWidth(left, Math.max(0, width - rw - 1), "…");
  if (visibleWidth(l) + 1 + rw <= width) return l + " ".repeat(width - visibleWidth(l) - rw) + right;
  const r = truncateToWidth(right, half, "…");
  const ll = truncateToWidth(left, Math.max(0, width - visibleWidth(r) - 1), "…");
  return truncateToWidth(ll + " " + r, width, "");
}
