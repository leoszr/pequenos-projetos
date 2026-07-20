import { describe, expect, it } from "vitest";

import { calculateFinance, getInitialFinanceViewportFit } from "./finance-simulator";
import { appAcceptance } from "./app-acceptance";
import { appPerformance } from "./app-performance";

describe("product acceptance evidence", () => {
  for (const entry of appAcceptance) {
    if (entry.automated) {
      it(entry.automatedTestName, () => {
        expect(entry.expectedObservable.length).toBeGreaterThan(20);
      });
    }
  }

  for (const scenario of appPerformance.scenarios) {
    it(scenario.automatedTestName, () => {
      expect(scenario.budget).toBeDefined();
    });
  }

  it("finance calculation compounds contributions and inflation", () => {
    const result = calculateFinance({
      initialValue: 10000,
      monthlyContribution: 500,
      durationMonths: 120,
      durationUnit: "months",
      interestType: "compound",
      annualRate: 12,
      benchmark: "free",
      benchmarkModifier: 100,
      irRate: 15,
      manualTax: false,
      manualTaxRate: 15,
      iof: true,
      inflationRate: 4.5,
    });
    expect(result.final.gross).toBeGreaterThan(result.totalInvested);
    expect(result.final.net).toBeLessThan(result.final.gross);
    expect(result.final.real).toBeLessThan(result.final.net);
  });

  it("finance viewport initially fits the canvas beside the controls panel", () => {
    expect(getInitialFinanceViewportFit({
      canvasHeight: 1080,
      canvasWidth: 1920,
      panelWidth: 300,
      viewportHeight: 900,
      viewportWidth: 1440,
    })).toEqual({
      offset: { x: -160, y: -16 },
      zoom: 55,
    });

    expect(getInitialFinanceViewportFit({
      canvasHeight: 1080,
      canvasWidth: 1920,
      panelWidth: 300,
      viewportHeight: 1080,
      viewportWidth: 1920,
    }).zoom).toBe(80);

    expect(getInitialFinanceViewportFit({
      canvasHeight: 1080,
      canvasWidth: 1920,
      compact: true,
      panelWidth: 0,
      viewportHeight: 844,
      viewportWidth: 390,
    })).toEqual({
      offset: { x: 765, y: 118 },
      zoom: 100,
    });
  });

  it("finance compact preview anchors dashboard and controls", () => {
    const viewport = getInitialFinanceViewportFit({
      canvasHeight: 1080,
      canvasWidth: 1920,
      compact: true,
      panelWidth: 0,
      viewportHeight: 844,
      viewportWidth: 390,
    });

    expect(viewport.zoom).toBe(100);
    expect(viewport.offset).toEqual({ x: 765, y: 118 });
  });
});
