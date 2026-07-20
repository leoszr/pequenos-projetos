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
  it("contains only OpenAI and DeepSeek with low/medium/high effort", () => {
    const policy = loadModelPolicy();
    expect(policy.providers).toEqual(["openai-codex", "deepseek"]);
    expect(policy.efforts).toEqual(["low", "medium", "high"]);
    expect(policy.models.every((model) => /^(openai-codex|deepseek)\//.test(model.id))).toBe(true);
  });

  it("selects the smallest sufficient task capability", () => {
    const result = resolveModel(
      { minimumCapability: "cross_cutting", effort: "medium" },
      available,
    );
    expect(result.model).toBe("openai-codex/gpt-5.6-terra");
    expect(result.degradedCapability).toBe(false);
    expect(result.thinking).toBe("medium");
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
      resolveModel({ minimumCapability: "high_agency", effort: "high" }, lunaOnly),
    ).toThrow(ModelResolutionError);
    const result = resolveModel(
      { minimumCapability: "high_agency", effort: "high", allowDegraded: true },
      lunaOnly,
    );
    expect(result.degradedCapability).toBe(true);
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
});
