import * as React from "react";

import {
  createToolcraftPngExportCanvas,
  shouldIncludeToolcraftPreviewBackground,
  type ToolcraftState,
} from "@/toolcraft/runtime";
import { useToolcraft } from "@/toolcraft/runtime/react";

export type FinanceConfig = {
  initialValue: number;
  monthlyContribution: number;
  durationMonths: number;
  durationUnit: "months" | "years";
  interestType: "simple" | "compound";
  annualRate: number;
  benchmark: "free" | "cdi" | "selic" | "ipca";
  benchmarkModifier: number;
  irRate: number;
  manualTax: boolean;
  manualTaxRate: number;
  iof: boolean;
  inflationRate: number;
};

type Scenario = { id: string; name: string; config: FinanceConfig };
type Point = { month: number; invested: number; gross: number; net: number; real: number; grossReturn: number; ir: number; iof: number; inflationLoss: number };
type Results = { points: Point[]; final: Point; effectiveAnnualRate: number; effectiveMonthlyRate: number; totalInvested: number };

const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
const BRL_COMPACT = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", notation: "compact", maximumFractionDigits: 1 });
const PCT = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const benchmarkRates = { free: 0, cdi: 10.65, selic: 10.5, ipca: 4.5 } as const;
const chartFrame = { bottom: 286, left: 76, right: 884, top: 22 } as const;

export type FinanceViewportFit = {
  offset: { x: number; y: number };
  zoom: number;
};

export function getInitialFinanceViewportFit({
  canvasHeight,
  canvasWidth,
  compact = false,
  panelWidth,
  viewportHeight,
  viewportWidth,
}: {
  canvasHeight: number;
  canvasWidth: number;
  compact?: boolean;
  panelWidth: number;
  viewportHeight: number;
  viewportWidth: number;
}): FinanceViewportFit {
  if (compact) {
    return {
      offset: {
        x: (canvasWidth - viewportWidth) / 2,
        y: (canvasHeight - viewportHeight) / 2,
      },
      zoom: 100,
    };
  }

  const outerInset = 24;
  const panelGap = panelWidth > 0 ? 20 : 0;
  const toolbarReserve = 64;
  const availableWidth = Math.max(1, viewportWidth - panelWidth - panelGap - outerInset * 2);
  const availableHeight = Math.max(1, viewportHeight - toolbarReserve - outerInset * 2);
  const zoom = Math.max(
    25,
    Math.min(100, Math.floor(Math.min(availableWidth / canvasWidth, availableHeight / canvasHeight) * 100)),
  );

  return {
    offset: {
      x: panelWidth > 0 ? -(panelWidth + panelGap) / 2 : 0,
      y: -toolbarReserve / 4,
    },
    zoom,
  };
}

function useCompactFinanceViewport(): boolean {
  const [compact, setCompact] = React.useState(false);

  React.useEffect(() => {
    const query = window.matchMedia("(max-width: 1023px)");
    const update = () => setCompact(query.matches);
    query.addEventListener("change", update);
    update();

    return () => query.removeEventListener("change", update);
  }, []);

  return compact;
}

function asNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const normalized = value.replace(/[^\d,.-]/g, "").replace(/\.(?=\d{3})/g, "").replace(",", ".");
    const parsed = Number(normalized);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function valueOf(values: Record<string, unknown>, target: string, fallback: unknown): unknown {
  return values[target] ?? fallback;
}

export function getFinanceConfig(state: ToolcraftState): FinanceConfig {
  const values = state.values;
  const benchmark = String(valueOf(values, "interest.benchmark", "free")) as FinanceConfig["benchmark"];
  const manualAnnual = asNumber(valueOf(values, "interest.annualRate", 12), 12);
  const modifier = asNumber(valueOf(values, "interest.benchmarkModifier", 100), 100);
  const annualRate = benchmark === "free" ? manualAnnual : (benchmarkRates[benchmark] ?? manualAnnual) * (modifier / 100);
  return {
    initialValue: Math.max(0, asNumber(valueOf(values, "capital.initialValue", 10000), 10000)),
    monthlyContribution: Math.max(0, asNumber(valueOf(values, "capital.monthlyContribution", 500), 500)),
    durationMonths: Math.max(1, Math.min(360, Math.round(asNumber(valueOf(values, "period.durationMonths", 120), 120)))),
    durationUnit: String(valueOf(values, "period.durationUnit", "months")) === "years" ? "years" : "months",
    interestType: String(valueOf(values, "interest.type", "compound")) === "simple" ? "simple" : "compound",
    annualRate,
    benchmark,
    benchmarkModifier: modifier,
    irRate: asNumber(valueOf(values, "tax.irRate", 15), 15),
    manualTax: valueOf(values, "tax.manualOverride", false) === true,
    manualTaxRate: asNumber(valueOf(values, "tax.manualRate", 15), 15),
    iof: valueOf(values, "tax.iof", true) === true,
    inflationRate: asNumber(valueOf(values, "inflation.annualRate", 4.5), 4.5),
  };
}

export function calculateFinance(config: FinanceConfig): Results {
  const monthlyRate = Math.pow(1 + config.annualRate / 100, 1 / 12) - 1;
  const monthlyInflation = Math.pow(1 + config.inflationRate / 100, 1 / 12) - 1;
  const taxRate = (config.manualTax ? config.manualTaxRate : config.irRate) / 100;
  const points: Point[] = [];
  for (let month = 0; month <= config.durationMonths; month += 1) {
    const invested = config.initialValue + config.monthlyContribution * month;
    let gross = config.initialValue;
    if (config.interestType === "compound") {
      gross = config.initialValue * Math.pow(1 + monthlyRate, month);
      if (monthlyRate === 0) gross += config.monthlyContribution * month;
      else gross += config.monthlyContribution * ((Math.pow(1 + monthlyRate, month) - 1) / monthlyRate);
    } else {
      const simpleInterest = config.initialValue * monthlyRate * month + config.monthlyContribution * monthlyRate * (month * (month + 1)) / 2;
      gross = invested + simpleInterest;
    }
    const grossReturn = Math.max(0, gross - invested);
    const ir = grossReturn * taxRate;
    const iof = config.iof && month < 1 ? grossReturn * 0.96 : 0;
    const net = gross - ir - iof;
    const real = net / Math.pow(1 + monthlyInflation, month);
    const inflationLoss = Math.max(0, net - real);
    points.push({ month, invested, gross, net, real, grossReturn, ir, iof, inflationLoss });
  }
  const final = points[points.length - 1] ?? points[0]!;
  return { points, final, effectiveAnnualRate: config.annualRate, effectiveMonthlyRate: monthlyRate * 100, totalInvested: final.invested };
}

function getScenarios(state: ToolcraftState): Scenario[] {
  const raw = state.values["scenario.saved"];
  return Array.isArray(raw) ? raw.filter(Boolean).slice(0, 3) as Scenario[] : [];
}

export function createSavedScenario(state: ToolcraftState): Scenario[] {
  const current = getScenarios(state);
  const name = String(state.values["scenario.name"] ?? `Cenário ${current.length + 1}`);
  return [...current.filter((item) => item.name !== name), { id: `${Date.now()}`, name, config: getFinanceConfig(state) }].slice(-3);
}

function linePath(points: Point[], key: "gross" | "net" | "real", max: number): string {
  const width = chartFrame.right - chartFrame.left;
  const height = chartFrame.bottom - chartFrame.top;
  return points.map((point, index) => {
    const x = chartFrame.left + (point.month / Math.max(1, points[points.length - 1]!.month)) * width;
    const y = chartFrame.top + height - (point[key] / max) * height;
    return `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
}

function formatDuration(config: FinanceConfig): string {
  if (config.durationUnit === "years") {
    const years = config.durationMonths / 12;
    return `${new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 }).format(years)} ${years === 1 ? "ano" : "anos"}`;
  }

  return `${config.durationMonths} ${config.durationMonths === 1 ? "mês" : "meses"}`;
}

function benchmarkLabel(benchmark: FinanceConfig["benchmark"]): string {
  return benchmark === "free" ? "Taxa livre" : benchmark === "ipca" ? "IPCA+" : benchmark.toUpperCase();
}

function FinanceViewportFitter({ compact }: { compact: boolean }): null {
  const { dispatch, state } = useToolcraft();
  const { offset, size, zoom } = state.canvas;
  const fitOnNextLayoutRef = React.useRef(true);
  const compactPanelInitializedRef = React.useRef(false);
  const previousSizeRef = React.useRef(size);
  const [layoutRevision, setLayoutRevision] = React.useState(0);

  React.useEffect(() => {
    const handleResize = () => {
      fitOnNextLayoutRef.current = true;
      setLayoutRevision((revision) => revision + 1);
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  React.useEffect(() => {
    if (!compact) {
      compactPanelInitializedRef.current = false;
      return;
    }

    if (compactPanelInitializedRef.current) return;
    compactPanelInitializedRef.current = true;

    const frame = window.requestAnimationFrame(() => {
      const collapseButton = document.querySelector<HTMLButtonElement>(
        'button[aria-label="Collapse controls"]',
      );
      collapseButton?.click();
    });

    return () => window.cancelAnimationFrame(frame);
  }, [compact]);

  React.useEffect(() => {
    const stopCanvasWheelPan = (event: WheelEvent) => {
      const target = event.target;
      const canvas = document.querySelector<HTMLElement>('[data-slot="toolcraft-runtime-canvas"]');

      if (!(target instanceof Node) || !canvas?.contains(target)) return;
      if (!compact && event.ctrlKey) return;

      event.stopPropagation();
    };

    document.addEventListener("wheel", stopCanvasWheelPan, { capture: true, passive: true });
    return () => document.removeEventListener("wheel", stopCanvasWheelPan, { capture: true });
  }, [compact]);

  React.useLayoutEffect(() => {
    if (typeof document === "undefined") return;

    if (
      previousSizeRef.current.width !== size.width ||
      previousSizeRef.current.height !== size.height
    ) {
      previousSizeRef.current = size;
      fitOnNextLayoutRef.current = true;
    }

    const app = document.querySelector<HTMLElement>('[data-slot="toolcraft-runtime-app"]');
    const panel = document.querySelector<HTMLElement>('[data-slot="toolcraft-runtime-panel-host"]');

    if (!app) return;

    const appRect = app.getBoundingClientRect();
    const panelRect = panel?.getBoundingClientRect();
    const panelWidth = !compact && panelRect && panelRect.right > appRect.right - 32 ? panelRect.width : 0;
    const fittedViewport = getInitialFinanceViewportFit({
      canvasHeight: size.height,
      canvasWidth: size.width,
      compact,
      panelWidth,
      viewportHeight: appRect.height,
      viewportWidth: appRect.width,
    });
    const nextViewport = {
      offset: fittedViewport.offset,
      zoom: compact || fitOnNextLayoutRef.current ? fittedViewport.zoom : zoom,
    };

    if (
      nextViewport.zoom === zoom &&
      nextViewport.offset.x === offset.x &&
      nextViewport.offset.y === offset.y
    ) {
      fitOnNextLayoutRef.current = false;
      return;
    }

    dispatch({
      offset: nextViewport.offset,
      type: "canvas.setViewport",
      zoom: nextViewport.zoom,
    });
  }, [compact, dispatch, layoutRevision, offset.x, offset.y, size.height, size.width, zoom]);

  return null;
}

export function FinanceDashboard(): React.JSX.Element {
  const { state } = useToolcraft();
  const compact = useCompactFinanceViewport();
  const config = getFinanceConfig(state);
  const results = calculateFinance(config);
  const scenarios = getScenarios(state);
  const bg = (state.values["appearance.background"] as { hex?: string } | undefined)?.hex ?? "#08110d";
  const includeBg = shouldIncludeToolcraftPreviewBackground({ state });
  const f = results.final;
  const simple = calculateFinance({ ...config, interestType: "simple" }).final;
  const compound = calculateFinance({ ...config, interestType: "compound" }).final;
  const chartMax = Math.max(...results.points.flatMap((point) => [point.gross, point.net, point.real]), 1);
  const investedShare = (f.invested / Math.max(f.gross, 1)) * 100;
  const interestShare = (f.grossReturn / Math.max(f.gross, 1)) * 100;
  const taxRate = config.manualTax ? config.manualTaxRate : config.irRate;
  const axisTicks = [0, 0.25, 0.5, 0.75, 1];
  const duration = formatDuration(config);
  return (
    <div
      className="finance-dashboard"
      data-toolcraft-product-output
      data-compact-preview={compact ? "true" : "false"}
      data-viewport-zoom={state.canvas.zoom}
      style={{ background: includeBg ? bg : "transparent" }}
    >
      <FinanceViewportFitter compact={compact} />
      <style>{financeStyles}</style>
      <header className="finance-header">
        <div className="finance-heading">
          <p>Simulador de juros</p>
          <h1>Projeção do investimento</h1>
          <div className="finance-context" aria-label="Premissas principais">
            <span>{duration}</span>
            <span>{benchmarkLabel(config.benchmark)}</span>
            <span>{config.interestType === "compound" ? "Juros compostos" : "Juros simples"}</span>
          </div>
        </div>
        <div className="finance-primary-result">
          <span>Patrimônio líquido estimado</span>
          <strong>{BRL.format(f.net)}</strong>
          <small>Ganho líquido de {BRL.format(f.net - results.totalInvested)}</small>
        </div>
        <div className="finance-rate" aria-label="Taxa efetiva">
          <span>{PCT.format(results.effectiveAnnualRate)}% a.a.</span>
          <small>{PCT.format(results.effectiveMonthlyRate)}% ao mês</small>
        </div>
      </header>

      <section className="finance-metrics" aria-label="Resumo financeiro">
        <div><span>Total investido</span><strong>{BRL.format(results.totalInvested)}</strong><small>Capital próprio</small></div>
        <div><span>Rendimento bruto</span><strong>{BRL.format(f.grossReturn)}</strong><small>Antes de impostos</small></div>
        <div><span>Rendimento líquido</span><strong>{BRL.format(f.net - results.totalInvested)}</strong><small>Após IR e IOF</small></div>
        <div><span>Patrimônio real</span><strong>{BRL.format(f.real)}</strong><small>Descontada a inflação</small></div>
      </section>

      <section className="finance-main-grid">
        <article className="finance-panel finance-chart">
          <div className="finance-panel-heading">
            <div><h2>Evolução patrimonial</h2><p>Valores acumulados ao longo de {duration}</p></div>
            <span className="finance-scenario-count">{scenarios.length}/3 cenários</span>
          </div>
          <svg viewBox="0 0 920 330" role="img" aria-labelledby="finance-chart-title finance-chart-description">
            <title id="finance-chart-title">Evolução do patrimônio bruto, líquido e real</title>
            <desc id="finance-chart-description">Ao fim de {duration}, o patrimônio líquido estimado é {BRL.format(f.net)} e o patrimônio real é {BRL.format(f.real)}.</desc>
            {axisTicks.map((tick) => {
              const y = chartFrame.bottom - tick * (chartFrame.bottom - chartFrame.top);
              return <g className="finance-grid-line" key={tick}><line x1={chartFrame.left} x2={chartFrame.right} y1={y} y2={y}/><text x={chartFrame.left - 12} y={y + 4}>{BRL_COMPACT.format(chartMax * tick)}</text></g>;
            })}
            <line className="finance-axis" x1={chartFrame.left} x2={chartFrame.right} y1={chartFrame.bottom} y2={chartFrame.bottom}/>
            <text className="finance-axis-label" x={chartFrame.left} y="316">Início</text>
            <text className="finance-axis-label" textAnchor="middle" x={(chartFrame.left + chartFrame.right) / 2} y="316">{Math.round(config.durationMonths / 2)} meses</text>
            <text className="finance-axis-label" textAnchor="end" x={chartFrame.right} y="316">{config.durationMonths} meses</text>
            <path d={linePath(results.points, "gross", chartMax)} className="gross"/>
            <path d={linePath(results.points, "net", chartMax)} className="net"/>
            <path d={linePath(results.points, "real", chartMax)} className="real"/>
            {scenarios.map((scenario, index) => <path key={scenario.id} d={linePath(calculateFinance(scenario.config).points, "net", chartMax)} className={`scenario s${index}`}/>)}</svg>
          <div className="finance-legend" aria-label="Legenda do gráfico">
            <span className="gross">Bruto</span><span className="net">Líquido</span><span className="real">Real</span>
            {scenarios.map((scenario, index) => <span className={`scenario s${index}`} key={scenario.id}>{scenario.name}</span>)}
          </div>
        </article>

        <article className="finance-panel finance-composition">
          <div className="finance-panel-heading"><div><h2>Composição final</h2><p>Origem do patrimônio bruto</p></div></div>
          <div className="finance-stack" aria-label={`${investedShare.toFixed(0)}% capital investido e ${interestShare.toFixed(0)}% juros`}>
            <span className="invested" style={{ width: `${investedShare}%` }}/>
            <span className="interest" style={{ width: `${interestShare}%` }}/>
          </div>
          <div className="finance-share"><strong>{investedShare.toFixed(0)}%</strong><span>do montante veio dos seus aportes</span></div>
          <dl className="finance-breakdown">
            <div className="invested"><dt>Capital investido</dt><dd>{BRL.format(f.invested)}</dd></div>
            <div className="interest"><dt>Juros brutos</dt><dd>{BRL.format(f.grossReturn)}</dd></div>
            <div className="tax"><dt>IR e IOF</dt><dd>− {BRL.format(f.ir + f.iof)}</dd></div>
            <div className="inflation"><dt>Efeito da inflação</dt><dd>− {BRL.format(f.inflationLoss)}</dd></div>
          </dl>
        </article>
      </section>

      <section className="finance-bottom-grid">
        <article className="finance-panel finance-comparison">
          <div className="finance-panel-heading"><div><h2>Simples versus composto</h2><p>Mesmos aportes, prazo e taxa</p></div><span className="finance-delta">+ {BRL.format(compound.net - simple.net)}</span></div>
          <div className="finance-table-wrap">
            <table>
              <thead><tr><th>Regime</th><th>Montante líquido</th><th>Ganho líquido</th><th>Patrimônio real</th></tr></thead>
              <tbody>
                <tr><th scope="row">Juros simples</th><td>{BRL.format(simple.net)}</td><td>{BRL.format(simple.net - simple.invested)}</td><td>{BRL.format(simple.real)}</td></tr>
                <tr className="selected"><th scope="row">Juros compostos</th><td>{BRL.format(compound.net)}</td><td>{BRL.format(compound.net - compound.invested)}</td><td>{BRL.format(compound.real)}</td></tr>
              </tbody>
            </table>
          </div>
        </article>

        <article className="finance-panel finance-assumptions">
          <div className="finance-panel-heading"><div><h2>Premissas</h2><p>Condições aplicadas à projeção</p></div></div>
          <dl>
            <div><dt>Taxa</dt><dd>{PCT.format(config.annualRate)}% a.a.</dd></div>
            <div><dt>Imposto de renda</dt><dd>{PCT.format(taxRate)}%</dd></div>
            <div><dt>Inflação</dt><dd>{PCT.format(config.inflationRate)}% a.a.</dd></div>
            <div><dt>Aporte mensal</dt><dd>{BRL.format(config.monthlyContribution)}</dd></div>
          </dl>
        </article>
      </section>
    </div>
  );
}

export async function exportFinancePng(state: ToolcraftState, reportProgress: (progress: number) => void): Promise<void> {
  reportProgress(0.15);
  const bg = (state.values["appearance.background"] as { hex?: string } | undefined)?.hex ?? "#08110d";
  const includeBackground = state.values["export.includeBackground"] !== false;
  const resolution = String(state.values["export.image.resolution"] ?? "4k");
  const config = getFinanceConfig(state);
  const results = calculateFinance(config);
  const canvas = createToolcraftPngExportCanvas({ background: bg, includeBackground, resolution, state, render: ({ context, cssWidth, cssHeight }) => {
    drawFinanceExport(context, cssWidth, cssHeight, bg, includeBackground, results);
  }});
  reportProgress(0.7);
  const type = state.values["export.image.format"] === "jpg" ? "image/jpeg" : "image/png";
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => b ? resolve(b) : reject(new Error("PNG export failed.")), type, 0.92));
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `simulador-juros.${type === "image/jpeg" ? "jpg" : "png"}`; a.click();
  URL.revokeObjectURL(url);
  reportProgress(1);
}

function drawFinanceExport(ctx: CanvasRenderingContext2D, w: number, h: number, bg: string, includeBg: boolean, results: Results): void {
  if (includeBg) { ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h); }
  ctx.fillStyle = "#0d1f16"; ctx.fillRect(w * 0.04, h * 0.06, w * 0.92, h * 0.88);
  ctx.fillStyle = "#dfffea"; ctx.font = `${Math.max(32, w * 0.035)}px Inter, sans-serif`; ctx.fillText("Simulador de Juros Compostos", w * 0.08, h * 0.14);
  ctx.fillStyle = "#22c55e"; ctx.font = `${Math.max(28, w * 0.03)}px Inter, sans-serif`; ctx.fillText(`Montante líquido: ${BRL.format(results.final.net)}`, w * 0.08, h * 0.24);
  ctx.fillStyle = "#9ff7bd"; ctx.font = `${Math.max(20, w * 0.018)}px Inter, sans-serif`; ctx.fillText(`Rendimento real: ${BRL.format(results.final.real - results.totalInvested)} • Total investido: ${BRL.format(results.totalInvested)}`, w * 0.08, h * 0.31);
  ctx.strokeStyle = "#22c55e"; ctx.lineWidth = Math.max(3, w * 0.004); ctx.beginPath();
  const max = Math.max(...results.points.map((p) => p.net), 1); const left = w * 0.08; const top = h * 0.4; const cw = w * 0.84; const ch = h * 0.38;
  results.points.forEach((p, i) => { const x = left + (p.month / results.final.month) * cw; const y = top + ch - (p.net / max) * ch; if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }); ctx.stroke();
  ctx.fillStyle = "#183b27"; ctx.fillRect(left, h * 0.84, cw, h * 0.035); ctx.fillStyle = "#22c55e"; ctx.fillRect(left, h * 0.84, cw * 0.7, h * 0.035);
}

const financeStyles = `
.finance-dashboard{--fin-bg:#07110d;--fin-surface:#0b1b14;--fin-surface-strong:#0e2419;--fin-border:#214333;--fin-border-soft:#173326;--fin-text:#edf7f1;--fin-muted:#a5b9ad;--fin-subtle:#7f9589;--fin-accent:#55d989;--fin-accent-strong:#1fc76a;--fin-cyan:#56b9d8;--fin-warm:#e5d89b;width:100%;height:100%;padding:42px 46px 38px;color:var(--fin-text);font-family:Inter,ui-sans-serif,system-ui,sans-serif;box-sizing:border-box;overflow:hidden;container-type:size;font-variant-numeric:tabular-nums}.finance-dashboard *{box-sizing:border-box}.finance-dashboard p,.finance-dashboard h1,.finance-dashboard h2,.finance-dashboard dl{margin:0}.finance-header{height:108px;display:grid;grid-template-columns:minmax(0,1fr) minmax(380px,.72fr) 238px;gap:36px;align-items:center;border-bottom:1px solid var(--fin-border)}.finance-heading>p{color:var(--fin-accent);font-size:13px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;margin-bottom:7px}.finance-heading h1{font-size:31px;line-height:1.15;letter-spacing:-.025em;text-wrap:balance}.finance-context{display:flex;gap:18px;margin-top:10px;color:var(--fin-muted);font-size:13px}.finance-context span+span{position:relative}.finance-context span+span:before{content:"";position:absolute;left:-10px;top:50%;width:3px;height:3px;border-radius:50%;background:var(--fin-subtle)}.finance-primary-result{padding-left:28px;border-left:1px solid var(--fin-border)}.finance-primary-result>span,.finance-rate>small{display:block;color:var(--fin-muted);font-size:13px}.finance-primary-result>strong{display:block;margin:4px 0 3px;color:var(--fin-text);font-size:39px;line-height:1.08;letter-spacing:-.035em}.finance-primary-result>small{color:var(--fin-accent);font-size:13px}.finance-rate{text-align:right}.finance-rate>span{display:block;color:var(--fin-accent);font-size:25px;font-weight:750;letter-spacing:-.02em}.finance-rate>small{margin-top:5px}.finance-metrics{height:122px;display:grid;grid-template-columns:repeat(4,1fr);margin:20px 0;border:1px solid var(--fin-border);border-radius:14px;background:var(--fin-surface)}.finance-metrics>div{min-width:0;padding:19px 24px}.finance-metrics>div+div{border-left:1px solid var(--fin-border-soft)}.finance-metrics span,.finance-metrics small{display:block;color:var(--fin-muted);font-size:12px}.finance-metrics strong{display:block;margin:7px 0 4px;font-size:24px;line-height:1.1;letter-spacing:-.025em}.finance-metrics small{color:var(--fin-subtle)}.finance-main-grid{height:440px;display:grid;grid-template-columns:minmax(0,2.25fr) minmax(360px,.75fr);gap:20px}.finance-panel{min-width:0;border:1px solid var(--fin-border);border-radius:14px;background:var(--fin-surface);padding:22px 24px}.finance-panel-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.finance-panel-heading h2{font-size:17px;line-height:1.25;letter-spacing:-.01em}.finance-panel-heading p{margin-top:4px;color:var(--fin-muted);font-size:12px}.finance-scenario-count,.finance-delta{flex:none;border:1px solid var(--fin-border);border-radius:999px;padding:6px 9px;color:var(--fin-muted);font-size:11px}.finance-delta{color:var(--fin-accent)}.finance-chart{display:flex;min-height:0;flex-direction:column}.finance-chart svg{display:block;width:100%;min-height:0;flex:1;margin-top:6px;overflow:visible}.finance-chart path{fill:none;stroke-linecap:round;stroke-linejoin:round}.finance-chart path.gross{stroke:var(--fin-accent);stroke-width:3}.finance-chart path.net{stroke:var(--fin-cyan);stroke-width:3.5}.finance-chart path.real{stroke:var(--fin-warm);stroke-width:2.5;stroke-dasharray:8 7}.finance-chart path.scenario{stroke:#db8dac;stroke-width:2;stroke-dasharray:4 7}.finance-chart path.s1{stroke:#e4a76d}.finance-chart path.s2{stroke:#a995df}.finance-grid-line line{stroke:var(--fin-border-soft);stroke-width:1}.finance-grid-line text,.finance-axis-label{fill:var(--fin-subtle);font-size:11px}.finance-grid-line text{text-anchor:end}.finance-axis{stroke:var(--fin-border);stroke-width:1}.finance-legend{display:flex;align-items:center;gap:22px;min-height:18px;color:var(--fin-muted);font-size:12px}.finance-legend span{display:inline-flex;align-items:center;gap:8px}.finance-legend span:before{content:"";width:17px;height:2px;background:currentColor}.finance-legend .gross{color:var(--fin-accent)}.finance-legend .net{color:var(--fin-cyan)}.finance-legend .real{color:var(--fin-warm)}.finance-legend .scenario{color:#db8dac}.finance-legend .s1{color:#e4a76d}.finance-legend .s2{color:#a995df}.finance-composition{display:flex;flex-direction:column}.finance-stack{display:flex;height:20px;margin:35px 0 18px;overflow:hidden;border-radius:5px;background:var(--fin-border-soft)}.finance-stack .invested{background:var(--fin-cyan)}.finance-stack .interest{background:var(--fin-accent-strong)}.finance-share{display:flex;align-items:baseline;gap:10px;padding-bottom:19px;border-bottom:1px solid var(--fin-border-soft)}.finance-share strong{font-size:27px;letter-spacing:-.03em}.finance-share span{max-width:190px;color:var(--fin-muted);font-size:12px;line-height:1.35}.finance-breakdown{display:grid;gap:13px;margin-top:18px}.finance-breakdown>div{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:12px;padding-left:18px;position:relative}.finance-breakdown>div:before{content:"";position:absolute;left:0;width:8px;height:8px;border-radius:2px;background:var(--fin-subtle)}.finance-breakdown>.invested:before{background:var(--fin-cyan)}.finance-breakdown>.interest:before{background:var(--fin-accent-strong)}.finance-breakdown>.tax:before{background:#d68d81}.finance-breakdown>.inflation:before{background:var(--fin-warm)}.finance-breakdown dt{color:var(--fin-muted);font-size:12px}.finance-breakdown dd{margin:0;font-size:13px;font-weight:650}.finance-bottom-grid{height:232px;display:grid;grid-template-columns:minmax(0,1.55fr) minmax(340px,.65fr);gap:20px;margin-top:20px}.finance-comparison,.finance-assumptions{padding-top:20px}.finance-table-wrap{margin-top:14px}.finance-dashboard table{width:100%;border-collapse:collapse}.finance-dashboard th,.finance-dashboard td{height:47px;border-top:1px solid var(--fin-border-soft);padding:0 13px;text-align:right;font-size:13px}.finance-dashboard th:first-child{text-align:left}.finance-dashboard thead th{height:33px;border-top:0;color:var(--fin-subtle);font-size:10px;font-weight:650;letter-spacing:.06em;text-transform:uppercase}.finance-dashboard tbody th{color:var(--fin-muted);font-weight:500}.finance-dashboard tbody tr.selected{background:var(--fin-surface-strong)}.finance-dashboard tbody tr.selected th,.finance-dashboard tbody tr.selected td{color:var(--fin-text);font-weight:650}.finance-assumptions>dl{display:grid;grid-template-columns:1fr 1fr;gap:0 24px;margin-top:13px}.finance-assumptions>dl>div{display:flex;justify-content:space-between;gap:12px;padding:13px 0;border-top:1px solid var(--fin-border-soft)}.finance-assumptions dt{color:var(--fin-muted);font-size:12px}.finance-assumptions dd{margin:0;font-size:12px;font-weight:650;white-space:nowrap}
@container(max-width:1200px){.finance-dashboard{padding:28px}.finance-header{grid-template-columns:1fr 1fr}.finance-rate{display:none}.finance-main-grid{grid-template-columns:1.7fr 1fr}.finance-primary-result>strong{font-size:32px}.finance-bottom-grid{grid-template-columns:1.35fr 1fr}}
@container(max-width:860px){.finance-dashboard{height:auto;min-height:100%;overflow:auto}.finance-header{height:auto;grid-template-columns:1fr;padding-bottom:22px}.finance-primary-result{padding:18px 0 0;border-top:1px solid var(--fin-border);border-left:0}.finance-metrics{height:auto;grid-template-columns:1fr 1fr}.finance-metrics>div:nth-child(3){border-left:0}.finance-metrics>div:nth-child(n+3){border-top:1px solid var(--fin-border-soft)}.finance-main-grid,.finance-bottom-grid{height:auto;grid-template-columns:1fr}.finance-chart{min-height:380px}.finance-composition,.finance-comparison,.finance-assumptions{min-height:260px}.finance-bottom-grid{padding-bottom:28px}}
@media(max-width:1023px){.finance-dashboard{width:100dvw;height:100dvh;min-height:100dvh;padding:max(68px,calc(env(safe-area-inset-top) + 58px)) max(16px,env(safe-area-inset-right)) max(84px,calc(env(safe-area-inset-bottom) + 72px)) max(16px,env(safe-area-inset-left));overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable}.finance-header{height:auto;grid-template-columns:1fr;padding-bottom:20px}.finance-heading h1{font-size:25px}.finance-context{gap:14px;overflow:hidden;white-space:nowrap}.finance-primary-result{padding:18px 0 0;border-top:1px solid var(--fin-border);border-left:0}.finance-primary-result>strong{font-size:34px}.finance-rate{display:none}.finance-metrics{height:auto;grid-template-columns:1fr 1fr;margin:16px 0}.finance-metrics>div{padding:16px}.finance-metrics>div:nth-child(3){border-left:0}.finance-metrics>div:nth-child(n+3){border-top:1px solid var(--fin-border-soft)}.finance-metrics strong{font-size:19px}.finance-main-grid,.finance-bottom-grid{height:auto;grid-template-columns:1fr;gap:16px}.finance-panel{padding:19px 17px}.finance-chart{min-height:350px;overflow:hidden}.finance-chart svg{min-width:0;transform-origin:left center}.finance-chart .finance-grid-line text{display:none}.finance-chart .finance-axis-label{font-size:24px}.finance-legend{width:max-content}.finance-composition,.finance-comparison,.finance-assumptions{min-height:0}.finance-bottom-grid{margin-top:16px}.finance-table-wrap{overflow-x:auto}.finance-dashboard table{min-width:620px}.finance-assumptions>dl{grid-template-columns:1fr}.finance-bottom-grid{padding-bottom:24px}}
@media(prefers-reduced-motion:reduce){.finance-dashboard *{scroll-behavior:auto!important}}
`;
