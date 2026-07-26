import { describe, expect, it } from "vitest";

import {
  loadModelPolicy,
  ModelResolutionError,
  resolveModel,
  validatePolicy,
  type AvailableModel,
} from "../../src/models/resolve.ts";

const available: AvailableModel[] = [
  { provider: "openai-codex", id: "gpt-5.6-luna", contextWindow: 200_000, input: ["text", "image"] },
  { provider: "openai-codex", id: "gpt-5.6-terra", contextWindow: 200_000, input: ["text", "image"] },
  { provider: "openai-codex", id: "gpt-5.6-sol", contextWindow: 200_000, input: ["text", "image"] },
  { provider: "deepseek", id: "deepseek-v4-flash", contextWindow: 128_000, input: ["text"] },
  { provider: "deepseek", id: "deepseek-v4-pro", contextWindow: 128_000, input: ["text"] },
];

describe("model policy", () => {
  it("contains automatic effort defaults and only OpenAI/DeepSeek models", () => {
    const policy = loadModelPolicy();
    expect(policy.providers).toEqual(["openai-codex", "deepseek"]);
    expect(policy.efforts).toEqual(["low", "medium", "high"]);
    expect(policy.defaultEffort).toEqual({
      bounded: "low",
      scoped: "medium",
      cross_cutting: "medium",
      high_agency: "high",
    });
    expect(policy.models.every((model) => /^(openai-codex|deepseek)\//.test(model.id))).toBe(true);
    expect(
      policy.models
        .filter((model) => model.purposes.includes("verification"))
        .map((model) => model.id),
    ).toEqual(["openai-codex/gpt-5.6-sol"]);
    const pro = policy.models.find((model) => model.id === "deepseek/deepseek-v4-pro")!;
    const terra = policy.models.find((model) => model.id === "openai-codex/gpt-5.6-terra")!;
    expect(pro.preferenceRank).toBeLessThan(terra.preferenceRank);
  });

  it("prioritizes DeepSeek Pro for cross-cutting worker tasks", () => {
    const result = resolveModel(
      { minimumCapability: "cross_cutting" },
      available,
    );
    expect(result.model).toBe("deepseek/deepseek-v4-pro");
    expect(result.degradedCapability).toBe(false);
    expect(result.thinking).toBe("high");
    expect(result.exactThinking).toBe(false);
    expect(result.purpose).toBe("execution");
    expect(result.requestedEffort).toBe("auto");
    expect(result.effectiveEffort).toBe("medium");
  });

  it("uses Sol with high effort for verification regardless of worker capability", () => {
    const result = resolveModel(
      { minimumCapability: "scoped", purpose: "verification" },
      available,
    );
    expect(result.model).toBe("openai-codex/gpt-5.6-sol");
    expect(result.purpose).toBe("verification");
    expect(result.requestedEffort).toBe("auto");
    expect(result.effectiveEffort).toBe("high");
    expect(result.thinking).toBe("high");
  });

  it("never falls back to DeepSeek for verification", () => {
    const withoutSol = available.filter((model) => model.id !== "gpt-5.6-sol");
    expect(() => resolveModel(
      {
        minimumCapability: "cross_cutting",
        purpose: "verification",
        allowDegraded: true,
      },
      withoutSol,
    )).toThrow("No allowlisted OpenAI/DeepSeek model satisfies the request");
  });

  it("enforces provider independence within the two-provider allowlist", () => {
    const result = resolveModel(
      {
        minimumCapability: "scoped",
        effort: "medium",
        independence: { required: true, avoidProvider: "openai-codex" },
      },
      available,
    );
    expect(result.provider).toBe("deepseek");
    expect(result.thinking).toBe("high");
    expect(result.exactThinking).toBe(false);
  });

  it("requires explicit opt-in for degraded capability", () => {
    const lunaOnly = available.slice(0, 1);
    expect(() =>
      resolveModel({ minimumCapability: "high_agency" }, lunaOnly),
    ).toThrow(ModelResolutionError);
    const result = resolveModel(
      { minimumCapability: "high_agency", allowDegraded: true },
      lunaOnly,
    );
    expect(result.degradedCapability).toBe(true);
    expect(result.thinking).toBe("high");
  });

  it("filters context and modality requirements", () => {
    const result = resolveModel(
      {
        minimumCapability: "scoped",
        effort: "low",
        requirements: { minContextWindow: 150_000, modalities: ["image"] },
      },
      available,
    );
    expect(result.provider).toBe("openai-codex");
  });

  it("rejects providers outside the allowlist", () => {
    const policy = loadModelPolicy();
    expect(() =>
      validatePolicy({
        ...policy,
        models: [{ ...policy.models[0]!, id: "openrouter/other" }],
      }),
    ).toThrow("outside provider allowlist");
  });

  it("records an explicit effort override", () => {
    const result = resolveModel(
      { minimumCapability: "scoped", effort: "low" },
      available,
    );
    expect(result.model).toBe("openai-codex/gpt-5.6-luna");
    expect(result.requestedEffort).toBe("low");
    expect(result.effectiveEffort).toBe("low");
  });

  it("falls back to Terra when DeepSeek Pro is unavailable", () => {
    const withoutPro = available.filter((model) => model.id !== "deepseek-v4-pro");
    const result = resolveModel(
      { minimumCapability: "cross_cutting" },
      withoutPro,
    );
    expect(result.model).toBe("openai-codex/gpt-5.6-terra");
  });
});
