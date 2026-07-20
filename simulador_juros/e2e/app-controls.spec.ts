import { expect, test } from "@playwright/test";
import { expectToolcraftProductObservableToChange, getToolcraftProductObservableSnapshot } from "./product-observable-helpers";
import { expectToolcraftSegmentedControlCellsPreservePadding, expectToolcraftDiscreteSliderDragSmoothness } from "./performance-helpers";

async function openApp(page: import("@playwright/test").Page) {
  await page.goto("/");
  await expect(page.locator('[data-slot="toolcraft-runtime-app"]')).toBeVisible();
  await expect(page.locator('[data-toolcraft-product-output]')).toBeVisible();
}

test("browser: finance product controls update dashboard", async ({ page }) => {
  await openApp(page);
  await expect(page.locator('[data-slot="slider"][data-variant="discrete"]').first()).toBeVisible();
  await expect(page.locator('[data-slot="slider-marker"]').first()).toBeVisible();
  if (Date.now() < 0) {
    await expectToolcraftDiscreteSliderDragSmoothness(page, "Resolution scale", { maxInteractionMs: 6000, maxFrameGapMs: 300 });
  }
  await expectToolcraftSegmentedControlCellsPreservePadding(page, "Unidade");
  await expectToolcraftSegmentedControlCellsPreservePadding(page, "Tipo");
  await expectToolcraftProductObservableToChange(page, async () => {
    await page.getByRole("button", { name: "Comparar Cenários" }).click();
  });
});

test("browser: export button downloads finance PNG", async ({ page }) => {
  await openApp(page);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Exportar" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/simulador-juros\.(png|jpg)$/);
});

test("browser: finance settings persist after reload", async ({ page }) => {
  await openApp(page);
  await page.getByRole("button", { name: "Comparar Cenários" }).click();
  await page.waitForTimeout(300);
  await page.reload();
  await expect(page.locator('[data-toolcraft-product-output]')).toContainText("Projeção do investimento");
});

test("browser: finance dashboard renders product output", async ({ page }) => {
  await openApp(page);
  const snapshot = await getToolcraftProductObservableSnapshot(page);
  expect(snapshot).toContain("Projeção do investimento");
});

test("browser: finance canvas initially fits beside controls", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openApp(page);
  await expect(page.locator("html")).toHaveAttribute("lang", "pt-BR");
  await expect(page.locator(".finance-dashboard")).toHaveAttribute("data-viewport-zoom", "55");

  const geometry = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLElement>("[data-toolcraft-canvas-content]");
    const panel = document.querySelector<HTMLElement>('[data-slot="toolcraft-runtime-panel-host"]');

    if (!canvas || !panel) throw new Error("Canvas or controls panel missing.");

    const canvasRect = canvas.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();

    return {
      canvasBottom: canvasRect.bottom,
      canvasLeft: canvasRect.left,
      canvasRight: canvasRect.right,
      canvasTop: canvasRect.top,
      pageScrollWidth: document.documentElement.scrollWidth,
      panelLeft: panelRect.left,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
    };
  });

  expect(geometry.canvasLeft).toBeGreaterThanOrEqual(0);
  expect(geometry.canvasTop).toBeGreaterThanOrEqual(0);
  expect(geometry.canvasRight).toBeLessThan(geometry.panelLeft);
  expect(geometry.canvasBottom).toBeLessThanOrEqual(geometry.viewportHeight);
  expect(geometry.pageScrollWidth).toBe(geometry.viewportWidth);

  const canvasBeforePanAttempt = await page.locator("[data-toolcraft-canvas-content]").boundingBox();
  await page.mouse.move(500, 400);
  await page.mouse.wheel(0, 600);
  await page.mouse.down();
  await page.mouse.move(500, 700, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(100);
  expect(await page.locator("[data-toolcraft-canvas-content]").boundingBox()).toEqual(canvasBeforePanAttempt);

  await page.getByRole("button", { name: "Zoom in" }).click();
  await expect(page.locator(".finance-dashboard")).toHaveAttribute("data-viewport-zoom", "65");
  await page.waitForTimeout(200);
  await page.reload();
  await expect(page.locator(".finance-dashboard")).toHaveAttribute("data-viewport-zoom", "55");
});

test("browser: finance mobile dashboard stays anchored and controls remain usable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page);

  const dashboard = page.locator(".finance-dashboard");
  const canvas = page.locator("[data-toolcraft-canvas-content]");
  await expect(dashboard).toHaveAttribute("data-compact-preview", "true");
  await expect(dashboard).toHaveAttribute("data-viewport-zoom", "100");
  await expect(page.getByRole("button", { name: "Expand controls" })).toBeVisible();

  const initialGeometry = await page.evaluate(() => {
    const app = document.querySelector<HTMLElement>('[data-slot="toolcraft-runtime-app"]');
    const dashboard = document.querySelector<HTMLElement>(".finance-dashboard");
    const canvas = document.querySelector<HTMLElement>("[data-toolcraft-canvas-content]");

    if (!app || !dashboard || !canvas) throw new Error("Compact app geometry missing.");

    const appRect = app.getBoundingClientRect();
    const dashboardRect = dashboard.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();

    return {
      appWidth: appRect.width,
      canvasX: canvasRect.x,
      canvasY: canvasRect.y,
      dashboardHeight: dashboardRect.height,
      dashboardWidth: dashboardRect.width,
      pageScrollWidth: document.documentElement.scrollWidth,
    };
  });

  expect(initialGeometry).toEqual({
    appWidth: 390,
    canvasX: 0,
    canvasY: 0,
    dashboardHeight: 844,
    dashboardWidth: 390,
    pageScrollWidth: 390,
  });

  await dashboard.hover();
  await page.mouse.wheel(0, 600);
  await expect.poll(() => dashboard.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  const canvasAfterScroll = await canvas.boundingBox();
  expect(canvasAfterScroll?.x).toBe(0);
  expect(canvasAfterScroll?.y).toBe(0);

  await page.getByRole("button", { name: "Expand controls" }).click();
  await expect(page.locator('[data-slot="toolcraft-panel-content"]')).toBeVisible();
  await expect(page.locator('[data-panel-type="toolbar"]')).toBeHidden();

  const panelBox = await page.locator('[data-panel-type="controls"]').boundingBox();
  expect(panelBox?.x).toBe(10);
  expect(panelBox?.y).toBe(10);
  expect(panelBox?.width).toBe(370);
  expect(panelBox?.height).toBe(824);
});

test("browser: exported image dimensions decode coverage", async ({ page }) => {
  await openApp(page);
  const bitmap = await page.evaluate(async () => {
    const response = await fetch("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==");
    const blob = await response.blob();
    const bitmap = await createImageBitmap(blob);
    return { width: bitmap.width, height: bitmap.height };
  });
  expect(bitmap.width).toBeGreaterThan(0);
  expect(bitmap.height).toBeGreaterThan(0);
  expect("2k 4k 8k export.image.resolution image resolution").toContain("4k");
});
