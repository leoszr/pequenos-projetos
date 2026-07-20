import { describe, expect, it } from "vitest";

import { appPerformance } from "./app-performance";
import { appSchema } from "./app-schema";

describe("appSchema", () => {
  it("publishes the compound interest simulator contract", () => {
    expect(appSchema.canvas.enabled).toBe(true);
    expect(appSchema.canvas.draggable).toBe(false);
    expect(appSchema.canvas.sizing).toMatchObject({ mode: "editable-output" });
    expect(appSchema.canvas.upload).toBe(false);
    expect(appSchema.canvas.renderScale).toMatchObject({ enabled: true });
    expect(appSchema.toolbar).toEqual({ history: true, radar: true, theme: true, zoom: true });
    expect(appSchema.assembly.components).toEqual(["canvas", "controlsPanel", "toolbar"]);
    expect(appSchema.assembly.capabilities).toEqual(expect.arrayContaining(["canvas.editableSize", "controls.panel", "toolbar.zoom"]));
    expect(appSchema.assembly.capabilities).not.toContain("canvas.draggable");
  });

  it("groups product controls by financial meaning", () => {
    const titles = appSchema.panels.controls?.sections.map((section) => section.title);
    expect(titles).toEqual([
      "Setup",
      "Capital",
      "Prazo",
      "Juros",
      "Impostos e Inflação",
      "Cenários",
      "Background",
      "Image Export",
      "Export",
    ]);
  });

  it("exposes required export and background controls", () => {
    const sections = appSchema.panels.controls?.sections ?? [];
    const background = sections.find((section) => section.title === "Background")!;
    expect(background.controls.includeBackground).toMatchObject({ target: "export.includeBackground", type: "switch", label: "Include" });
    expect(background.controls.background).toMatchObject({ target: "appearance.background", type: "color", label: false });
    const image = sections.find((section) => section.title === "Image Export")!;
    expect(image.controls.imageFormat).toMatchObject({ target: "export.image.format", type: "select" });
    expect(image.controls.imageResolution).toMatchObject({ target: "export.image.resolution", type: "select" });
    const exportControl = sections.flatMap((section) => Object.values(section.controls)).find((control) => control.type === "panelActions");
    expect(exportControl?.actions?.[0]).toMatchObject({ label: "Exportar", value: "export-png", icon: "upload-simple" });
  });

  it("declares custom renderer performance coverage", () => {
    expect(appPerformance.usesCustomRenderer).toBe(true);
    expect(appPerformance.rendererStrategy).toBe("dom");
    expect(appPerformance.rendererTechnique?.layers?.length).toBeGreaterThan(0);
    expect(appPerformance.rendererPipeline?.passes.map((pass) => pass.id)).toEqual(expect.arrayContaining(["calculate-series", "svg-paths", "dom-composite", "png-export"]));
  });
});
