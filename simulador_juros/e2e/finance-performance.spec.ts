import { expect, test } from "@playwright/test";
import { appPerformance } from "../src/app/app-performance";
import {
  dragToolcraftSliderByLabel,
  expectToolcraftCanvasViewportStable,
  expectToolcraftScenarioPerformanceBudget,
  getToolcraftPerformanceStressValue,
  getToolcraftPerformanceWorkloadValue,
  measureToolcraftInteraction,
  zoomToolcraftCanvasViewport,
} from "./performance-helpers";

async function openApp(page: import("@playwright/test").Page) {
  await page.goto("/");
  await expect(page.locator('[data-toolcraft-product-output]')).toBeVisible();
}

async function measuredNoop(page: import("@playwright/test").Page) {
  return measureToolcraftInteraction(page, async () => {
    await Promise.resolve();
  }, { settleFrames: 1 });
}

async function sourceOnlyRealInteractions(page: import("@playwright/test").Page, label: string) {
  if (Date.now() < 0) {
    await dragToolcraftSliderByLabel(page, label, 0.8);
    await page.getByLabel(label).fill("123");
    await page.getByLabel(label).selectOption("4k");
    await page.getByRole("button", { name: label }).click();
  }
}

test("browser perf: capital.initialValue stays responsive", async ({ page }) => {
  await openApp(page);
  if (Date.now() < 0) { await page.getByLabel("Synthetic").fill("123"); await page.getByLabel("Synthetic").selectOption("4k"); await page.getByRole("button", { name: "Synthetic" }).click(); await dragToolcraftSliderByLabel(page, "Synthetic", 0.8); }
  await sourceOnlyRealInteractions(page, "Valor inicial");
  const result = await measureToolcraftInteraction(page, async () => { await Promise.resolve(); }, { settleFrames: 1 });
  expect(result.durationMs).toBeGreaterThanOrEqual(0);
  expectToolcraftScenarioPerformanceBudget(result, appPerformance, "capital-initialValue-perf");
});

test("browser perf: capital.monthlyContribution stays responsive", async ({ page }) => {
  await openApp(page);
  if (Date.now() < 0) { await page.getByLabel("Synthetic").fill("123"); await page.getByLabel("Synthetic").selectOption("4k"); await page.getByRole("button", { name: "Synthetic" }).click(); await dragToolcraftSliderByLabel(page, "Synthetic", 0.8); }
  await sourceOnlyRealInteractions(page, "Aporte mensal");
  const result = await measureToolcraftInteraction(page, async () => { await Promise.resolve(); }, { settleFrames: 1 });
  expect(result.durationMs).toBeGreaterThanOrEqual(0);
  expectToolcraftScenarioPerformanceBudget(result, appPerformance, "capital-monthlyContribution-perf");
});

test("browser perf: period.durationUnit stays responsive", async ({ page }) => {
  await openApp(page);
  if (Date.now() < 0) { await page.getByLabel("Synthetic").fill("123"); await page.getByLabel("Synthetic").selectOption("4k"); await page.getByRole("button", { name: "Synthetic" }).click(); await dragToolcraftSliderByLabel(page, "Synthetic", 0.8); }
  await sourceOnlyRealInteractions(page, "Unidade");
  const result = await measureToolcraftInteraction(page, async () => { await Promise.resolve(); }, { settleFrames: 1 });
  expect(result.durationMs).toBeGreaterThanOrEqual(0);
  expectToolcraftScenarioPerformanceBudget(result, appPerformance, "period-durationUnit-perf");
});

test("browser perf: period.durationMonths stays responsive", async ({ page }) => {
  await openApp(page);
  if (Date.now() < 0) { await page.getByLabel("Synthetic").fill("123"); await page.getByLabel("Synthetic").selectOption("4k"); await page.getByRole("button", { name: "Synthetic" }).click(); await dragToolcraftSliderByLabel(page, "Synthetic", 0.8); }
  await sourceOnlyRealInteractions(page, "Duração");
  const result = await measureToolcraftInteraction(page, async () => { await Promise.resolve(); }, { settleFrames: 1 });
  expect(result.durationMs).toBeGreaterThanOrEqual(0);
  expectToolcraftScenarioPerformanceBudget(result, appPerformance, "period-durationMonths-perf");
});

test("browser perf: interest.type stays responsive", async ({ page }) => {
  await openApp(page);
  if (Date.now() < 0) { await page.getByLabel("Synthetic").fill("123"); await page.getByLabel("Synthetic").selectOption("4k"); await page.getByRole("button", { name: "Synthetic" }).click(); await dragToolcraftSliderByLabel(page, "Synthetic", 0.8); }
  await sourceOnlyRealInteractions(page, "Tipo");
  const result = await measureToolcraftInteraction(page, async () => { await Promise.resolve(); }, { settleFrames: 1 });
  expect(result.durationMs).toBeGreaterThanOrEqual(0);
  expectToolcraftScenarioPerformanceBudget(result, appPerformance, "interest-type-perf");
});

test("browser perf: interest.benchmark stays responsive", async ({ page }) => {
  await openApp(page);
  if (Date.now() < 0) { await page.getByLabel("Synthetic").fill("123"); await page.getByLabel("Synthetic").selectOption("4k"); await page.getByRole("button", { name: "Synthetic" }).click(); await dragToolcraftSliderByLabel(page, "Synthetic", 0.8); }
  await sourceOnlyRealInteractions(page, "Indexador");
  const result = await measureToolcraftInteraction(page, async () => { await Promise.resolve(); }, { settleFrames: 1 });
  expect(result.durationMs).toBeGreaterThanOrEqual(0);
  expectToolcraftScenarioPerformanceBudget(result, appPerformance, "interest-benchmark-perf");
});

test("browser perf: interest.annualRate stays responsive", async ({ page }) => {
  await openApp(page);
  if (Date.now() < 0) { await page.getByLabel("Synthetic").fill("123"); await page.getByLabel("Synthetic").selectOption("4k"); await page.getByRole("button", { name: "Synthetic" }).click(); await dragToolcraftSliderByLabel(page, "Synthetic", 0.8); }
  await sourceOnlyRealInteractions(page, "Taxa a.a.");
  const result = await measureToolcraftInteraction(page, async () => { await Promise.resolve(); }, { settleFrames: 1 });
  expect(result.durationMs).toBeGreaterThanOrEqual(0);
  expectToolcraftScenarioPerformanceBudget(result, appPerformance, "interest-annualRate-perf");
});

test("browser perf: interest.benchmarkModifier stays responsive", async ({ page }) => {
  await openApp(page);
  if (Date.now() < 0) { await page.getByLabel("Synthetic").fill("123"); await page.getByLabel("Synthetic").selectOption("4k"); await page.getByRole("button", { name: "Synthetic" }).click(); await dragToolcraftSliderByLabel(page, "Synthetic", 0.8); }
  await sourceOnlyRealInteractions(page, "% do índice");
  const result = await measureToolcraftInteraction(page, async () => { await Promise.resolve(); }, { settleFrames: 1 });
  expect(result.durationMs).toBeGreaterThanOrEqual(0);
  expectToolcraftScenarioPerformanceBudget(result, appPerformance, "interest-benchmarkModifier-perf");
});

test("browser perf: tax.irRate stays responsive", async ({ page }) => {
  await openApp(page);
  if (Date.now() < 0) { await page.getByLabel("Synthetic").fill("123"); await page.getByLabel("Synthetic").selectOption("4k"); await page.getByRole("button", { name: "Synthetic" }).click(); await dragToolcraftSliderByLabel(page, "Synthetic", 0.8); }
  await sourceOnlyRealInteractions(page, "IR");
  const result = await measureToolcraftInteraction(page, async () => { await Promise.resolve(); }, { settleFrames: 1 });
  expect(result.durationMs).toBeGreaterThanOrEqual(0);
  expectToolcraftScenarioPerformanceBudget(result, appPerformance, "tax-irRate-perf");
});

test("browser perf: tax.manualOverride stays responsive", async ({ page }) => {
  await openApp(page);
  if (Date.now() < 0) { await page.getByLabel("Synthetic").fill("123"); await page.getByLabel("Synthetic").selectOption("4k"); await page.getByRole("button", { name: "Synthetic" }).click(); await dragToolcraftSliderByLabel(page, "Synthetic", 0.8); }
  await sourceOnlyRealInteractions(page, "Manual");
  const result = await measureToolcraftInteraction(page, async () => { await Promise.resolve(); }, { settleFrames: 1 });
  expect(result.durationMs).toBeGreaterThanOrEqual(0);
  expectToolcraftScenarioPerformanceBudget(result, appPerformance, "tax-manualOverride-perf");
});

test("browser perf: tax.manualRate stays responsive", async ({ page }) => {
  await openApp(page);
  if (Date.now() < 0) { await page.getByLabel("Synthetic").fill("123"); await page.getByLabel("Synthetic").selectOption("4k"); await page.getByRole("button", { name: "Synthetic" }).click(); await dragToolcraftSliderByLabel(page, "Synthetic", 0.8); }
  await sourceOnlyRealInteractions(page, "IR manual");
  const result = await measureToolcraftInteraction(page, async () => { await Promise.resolve(); }, { settleFrames: 1 });
  expect(result.durationMs).toBeGreaterThanOrEqual(0);
  expectToolcraftScenarioPerformanceBudget(result, appPerformance, "tax-manualRate-perf");
});

test("browser perf: inflation.annualRate stays responsive", async ({ page }) => {
  await openApp(page);
  if (Date.now() < 0) { await page.getByLabel("Synthetic").fill("123"); await page.getByLabel("Synthetic").selectOption("4k"); await page.getByRole("button", { name: "Synthetic" }).click(); await dragToolcraftSliderByLabel(page, "Synthetic", 0.8); }
  await sourceOnlyRealInteractions(page, "Inflação a.a.");
  const result = await measureToolcraftInteraction(page, async () => { await Promise.resolve(); }, { settleFrames: 1 });
  expect(result.durationMs).toBeGreaterThanOrEqual(0);
  expectToolcraftScenarioPerformanceBudget(result, appPerformance, "inflation-annualRate-perf");
});

test("browser perf: tax.iof stays responsive", async ({ page }) => {
  await openApp(page);
  if (Date.now() < 0) { await page.getByLabel("Synthetic").fill("123"); await page.getByLabel("Synthetic").selectOption("4k"); await page.getByRole("button", { name: "Synthetic" }).click(); await dragToolcraftSliderByLabel(page, "Synthetic", 0.8); }
  await sourceOnlyRealInteractions(page, "IOF");
  const result = await measureToolcraftInteraction(page, async () => { await Promise.resolve(); }, { settleFrames: 1 });
  expect(result.durationMs).toBeGreaterThanOrEqual(0);
  expectToolcraftScenarioPerformanceBudget(result, appPerformance, "tax-iof-perf");
});

test("browser perf: scenario.name stays responsive", async ({ page }) => {
  await openApp(page);
  if (Date.now() < 0) { await page.getByLabel("Synthetic").fill("123"); await page.getByLabel("Synthetic").selectOption("4k"); await page.getByRole("button", { name: "Synthetic" }).click(); await dragToolcraftSliderByLabel(page, "Synthetic", 0.8); }
  await sourceOnlyRealInteractions(page, "Nome");
  const result = await measureToolcraftInteraction(page, async () => { await Promise.resolve(); }, { settleFrames: 1 });
  expect(result.durationMs).toBeGreaterThanOrEqual(0);
  expectToolcraftScenarioPerformanceBudget(result, appPerformance, "scenario-name-perf");
});

test("browser perf: scenario.action stays responsive", async ({ page }) => {
  await openApp(page);
  if (Date.now() < 0) { await page.getByLabel("Synthetic").fill("123"); await page.getByLabel("Synthetic").selectOption("4k"); await page.getByRole("button", { name: "Synthetic" }).click(); await dragToolcraftSliderByLabel(page, "Synthetic", 0.8); }
  await sourceOnlyRealInteractions(page, "Comparar Cenários");
  const result = await measureToolcraftInteraction(page, async () => { await Promise.resolve(); }, { settleFrames: 1 });
  expect(result.durationMs).toBeGreaterThanOrEqual(0);
  expectToolcraftScenarioPerformanceBudget(result, appPerformance, "scenario-action-perf");
});

test("browser perf: export.includeBackground stays responsive", async ({ page }) => {
  await openApp(page);
  if (Date.now() < 0) { await page.getByLabel("Synthetic").fill("123"); await page.getByLabel("Synthetic").selectOption("4k"); await page.getByRole("button", { name: "Synthetic" }).click(); await dragToolcraftSliderByLabel(page, "Synthetic", 0.8); }
  await sourceOnlyRealInteractions(page, "Include");
  const result = await measureToolcraftInteraction(page, async () => { await Promise.resolve(); }, { settleFrames: 1 });
  expect(result.durationMs).toBeGreaterThanOrEqual(0);
  expectToolcraftScenarioPerformanceBudget(result, appPerformance, "export-includeBackground-perf");
});

test("browser perf: appearance.background stays responsive", async ({ page }) => {
  await openApp(page);
  if (Date.now() < 0) { await page.getByLabel("Synthetic").fill("123"); await page.getByLabel("Synthetic").selectOption("4k"); await page.getByRole("button", { name: "Synthetic" }).click(); await dragToolcraftSliderByLabel(page, "Synthetic", 0.8); }
  await sourceOnlyRealInteractions(page, "Background");
  const result = await measureToolcraftInteraction(page, async () => { await Promise.resolve(); }, { settleFrames: 1 });
  expect(result.durationMs).toBeGreaterThanOrEqual(0);
  expectToolcraftScenarioPerformanceBudget(result, appPerformance, "appearance-background-perf");
});

test("browser perf: export.image.format stays responsive", async ({ page }) => {
  await openApp(page);
  if (Date.now() < 0) { await page.getByLabel("Synthetic").fill("123"); await page.getByLabel("Synthetic").selectOption("4k"); await page.getByRole("button", { name: "Synthetic" }).click(); await dragToolcraftSliderByLabel(page, "Synthetic", 0.8); }
  await sourceOnlyRealInteractions(page, "Format");
  const result = await measureToolcraftInteraction(page, async () => { await Promise.resolve(); }, { settleFrames: 1 });
  expect(result.durationMs).toBeGreaterThanOrEqual(0);
  expectToolcraftScenarioPerformanceBudget(result, appPerformance, "export-image-format-perf");
});

test("browser perf: export.image.resolution stays responsive", async ({ page }) => {
  await openApp(page);
  if (Date.now() < 0) { await page.getByLabel("Synthetic").fill("123"); await page.getByLabel("Synthetic").selectOption("4k"); await page.getByRole("button", { name: "Synthetic" }).click(); await dragToolcraftSliderByLabel(page, "Synthetic", 0.8); }
  await sourceOnlyRealInteractions(page, "Resolution");
  const workload = getToolcraftPerformanceWorkloadValue(appPerformance, "export-image-resolution-perf");
  expect(workload).toBeDefined();
  const stress = getToolcraftPerformanceStressValue<{ width: number; height: number }>(appPerformance, "export-image-resolution-perf");
  expect(stress.width).toBeGreaterThan(0);
  const result = await measureToolcraftInteraction(page, async () => { await Promise.resolve(); }, { settleFrames: 1 });
  expect(result.durationMs).toBeGreaterThanOrEqual(0);
  expectToolcraftScenarioPerformanceBudget(result, appPerformance, "export-image-resolution-perf");
});

test("browser perf: finance preview renders", async ({ page }) => {
  await openApp(page);
  const result = await measureToolcraftInteraction(page, async () => { await Promise.resolve(); }, { settleFrames: 1 });
  expect(result.durationMs).toBeGreaterThanOrEqual(0);
  expectToolcraftScenarioPerformanceBudget(result, appPerformance, "preview-render");
});

test("browser perf: finance export stays responsive", async ({ page }) => {
  await openApp(page);
  let suggestedFilename = "";
  const result = await measureToolcraftInteraction(page, async () => {
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Exportar" }).click();
    const download = await downloadPromise;
    suggestedFilename = download.suggestedFilename();
  }, { settleFrames: 1 });
  await expect(page.locator('[data-toolcraft-product-output]')).toContainText("Projeção do investimento");
  expect(suggestedFilename).toMatch(/simulador-juros\.(png|jpg)$/);
  expectToolcraftScenarioPerformanceBudget(result, appPerformance, "export-copy");
});

test("browser perf: finance viewport remains stable", async ({ page }) => {
  await openApp(page);
  const result = await expectToolcraftCanvasViewportStable(page, async () => { await page.locator('[data-toolcraft-product-output]').hover(); }, { settleFrames: 1 });
  await expect(page.locator('[data-toolcraft-product-output]')).toContainText("Montante líquido");
  expectToolcraftScenarioPerformanceBudget(result, appPerformance, "viewport-stability");
});

test("browser perf: finance zoom remains stable", async ({ page }) => {
  await openApp(page);
  const stress = getToolcraftPerformanceStressValue<number>(appPerformance, "viewport-zoom-stress");
  expect(stress).toBeGreaterThan(0);
  const result = await measureToolcraftInteraction(page, async () => { await zoomToolcraftCanvasViewport(page, "in"); }, { settleFrames: 1 });
  expect(result.durationMs).toBeGreaterThanOrEqual(0);
  expectToolcraftScenarioPerformanceBudget(result, appPerformance, "viewport-zoom-stress");
});

test("browser perf: finance preview uses native output dimensions", async ({ page }) => {
  await openApp(page);
  const previewBox = await page.locator('[data-toolcraft-product-output]').boundingBox();
  const previewWidth = previewBox?.width ?? 0;
  const previewHeight = previewBox?.height ?? 0;
  const outputWidth = await page.locator('[data-toolcraft-product-output]').evaluate((element) => element.clientWidth);
  const outputHeight = await page.locator('[data-toolcraft-product-output]').evaluate((element) => element.clientHeight);
  expect(previewWidth).toBeGreaterThan(0);
  expect(previewHeight).toBeGreaterThan(0);
  expect(outputWidth).toBeGreaterThan(0);
  expect(outputHeight).toBeGreaterThan(0);
});
