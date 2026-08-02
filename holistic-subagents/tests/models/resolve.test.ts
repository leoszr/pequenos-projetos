import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import {
  createModelPolicyResolver,
  ModelResolutionError,
  parseModelPolicy,
  validateModelPolicy,
  type AvailableModel,
} from "../../src/models/policy.ts";

const policy = parseModelPolicy(
  readFileSync(new URL("../../src/models/default-policy.json", import.meta.url), "utf8"),
);
const resolveModel = createModelPolicyResolver(policy).resolve;
const resolveFixed = createModelPolicyResolver(policy).resolveFixed;

const available: AvailableModel[] = [
  { provider: "openai-codex", id: "gpt-5.6-luna", contextWindow: 200_000, input: ["text", "image"] },
  { provider: "openai-codex", id: "gpt-5.6-terra", contextWindow: 200_000, input: ["text", "image"] },
  { provider: "openai-codex", id: "gpt-5.6-sol", contextWindow: 200_000, input: ["text", "image"] },
];

describe("model policy", () => {
  it("contains the packaged automatic effort defaults", () => {
    expect(policy.providers).toEqual(["openai-codex"]);
    expect(policy.efforts).toEqual(["low", "medium", "xhigh", "max"]);
    expect(policy.defaultEffort).toEqual({
      bounded: "xhigh",
      scoped: "max",
      cross_cutting: "xhigh",
      high_agency: "medium",
    });
    expect(policy.models.every((model) => model.id.startsWith("openai-codex/gpt-5.6-"))).toBe(true);
    expect(
      policy.models
        .filter((model) => model.purposes.includes("verification"))
        .map((model) => model.id),
    ).toEqual(["openai-codex/gpt-5.6-sol"]);
  });

  it("uses Terra xhigh for cross-cutting worker tasks", () => {
    const result = resolveModel({ minimumCapability: "cross_cutting" }, available);
    expect(result.model).toBe("openai-codex/gpt-5.6-terra");
    expect(result.degradedCapability).toBe(false);
    expect(result.thinking).toBe("xhigh");
    expect(result.exactThinking).toBe(true);
    expect(result.purpose).toBe("execution");
    expect(result.requestedEffort).toBe("auto");
    expect(result.effectiveEffort).toBe("xhigh");
  });

  it("uses Sol medium for verification regardless of worker capability", () => {
    const result = resolveModel(
      { minimumCapability: "scoped", purpose: "verification" },
      available,
    );
    expect(result.model).toBe("openai-codex/gpt-5.6-sol");
    expect(result.purpose).toBe("verification");
    expect(result.requestedEffort).toBe("auto");
    expect(result.effectiveEffort).toBe("medium");
    expect(result.thinking).toBe("medium");
  });

  it("never falls back to an execution-only GPT for verification", () => {
    const withoutSol = available.filter((model) => model.id !== "gpt-5.6-sol");
    expect(() => resolveModel(
      {
        minimumCapability: "cross_cutting",
        purpose: "verification",
        allowDegraded: true,
      },
      withoutSol,
    )).toThrow("No model in the effective policy satisfies the request");
  });

  it("enforces family independence within the GPT allowlist", () => {
    const result = resolveModel({
      minimumCapability: "scoped",
      independence: { required: true, avoidFamily: "gpt-5.6-luna" },
    }, available);
    expect(result.model).toBe("openai-codex/gpt-5.6-terra");
  });

  it("requires explicit opt-in for degraded capability", () => {
    const lunaOnly = available.slice(0, 1);
    expect(() => resolveModel({ minimumCapability: "high_agency" }, lunaOnly))
      .toThrow(ModelResolutionError);
    const result = resolveModel(
      { minimumCapability: "high_agency", allowDegraded: true },
      lunaOnly,
    );
    expect(result.degradedCapability).toBe(true);
    expect(result.thinking).toBe("xhigh");
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
    expect(() => validateModelPolicy({
      ...policy,
      models: [{ ...policy.models[0]!, id: "openrouter/other" }],
    })).toThrow("outside provider allowlist");
  });

  it("never launches Luna below xhigh", () => {
    const result = resolveModel(
      { minimumCapability: "scoped", effort: "low" },
      available,
    );
    expect(result.model).toBe("openai-codex/gpt-5.6-luna");
    expect(result.requestedEffort).toBe("low");
    expect(result.effectiveEffort).toBe("low");
    expect(result.thinking).toBe("xhigh");
    expect(result.exactThinking).toBe(false);
  });

  it("evaluates an eligible fixed model without requiring it to be preferred", () => {
    expect(resolveModel(
      { minimumCapability: "scoped", effort: "medium" },
      available,
    ).model).toBe("openai-codex/gpt-5.6-luna");
    expect(resolveFixed(
      "openai-codex/gpt-5.6-sol",
      { minimumCapability: "scoped", effort: "medium" },
      available,
    )).toMatchObject({
      model: "openai-codex/gpt-5.6-sol",
      thinking: "medium",
    });
  });

  it("uses Luna max for scoped volume work", () => {
    const result = resolveModel({ minimumCapability: "scoped" }, available);
    expect(result.model).toBe("openai-codex/gpt-5.6-luna");
    expect(result.thinking).toBe("max");
  });
});
