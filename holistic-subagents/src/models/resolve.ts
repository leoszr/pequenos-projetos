import { readFileSync } from "node:fs";

import type {
  CanonicalEffort,
  Capability,
  ModelRequest,
  ModelResolution,
} from "../domain/types.ts";

export interface PolicyModel {
  id: string;
  family: string;
  capability: Capability;
  thinkingMap: Record<CanonicalEffort, CanonicalEffort>;
  tools: string[];
  harness: string[];
  preferenceRank: number;
  latencyRank: number;
  costRank: number;
}

export interface ModelPolicy {
  version: 1;
  providers: Array<"openai-codex" | "deepseek">;
  capabilities: Capability[];
  efforts: CanonicalEffort[];
  models: PolicyModel[];
}

export interface AvailableModel {
  provider: string;
  id: string;
  contextWindow: number;
  input: Array<"text" | "image">;
}

export class ModelResolutionError extends Error {
  readonly code: string;
  readonly alternatives: string[];
  readonly degradedAlternatives: string[];

  constructor(
    message: string,
    details: { code?: string; alternatives?: string[]; degradedAlternatives?: string[] } = {},
  ) {
    super(message);
    this.name = "ModelResolutionError";
    this.code = details.code ?? "NO_COMPATIBLE_MODEL";
    this.alternatives = details.alternatives ?? [];
    this.degradedAlternatives = details.degradedAlternatives ?? [];
  }
}

export function loadModelPolicy(): ModelPolicy {
  const policy = JSON.parse(
    readFileSync(new URL("./policy.json", import.meta.url), "utf8"),
  ) as ModelPolicy;
  validatePolicy(policy);
  return policy;
}

export function validatePolicy(policy: ModelPolicy): void {
  if (policy.version !== 1) throw new Error("Unsupported model policy version");
  if (policy.efforts.join(",") !== "low,medium,high") {
    throw new Error("Model policy efforts must be low, medium, high");
  }
  for (const model of policy.models) {
    const provider = model.id.split("/", 1)[0] as "openai-codex" | "deepseek";
    if (!policy.providers.includes(provider)) {
      throw new Error(`Model outside provider allowlist: ${model.id}`);
    }
    for (const effort of policy.efforts) {
      if (!policy.efforts.includes(model.thinkingMap[effort])) {
        throw new Error(`Invalid thinking translation for ${model.id}`);
      }
    }
  }
}

export function resolveModel(
  request: ModelRequest,
  available: readonly AvailableModel[],
  policy = loadModelPolicy(),
): ModelResolution {
  validatePolicy(policy);
  const capabilities = policy.capabilities;
  const availableById = new Map(
    available.map((model) => [`${model.provider}/${model.id}`, model]),
  );
  const compatible = policy.models.filter((candidate) => {
    const runtime = availableById.get(candidate.id);
    if (!runtime) return false;
    const requirements = request.requirements;
    if (requirements?.minContextWindow && runtime.contextWindow < requirements.minContextWindow) {
      return false;
    }
    if (requirements?.modalities?.some((item) => !runtime.input.includes(item))) return false;
    if (requirements?.tools?.some((item) => !candidate.tools.includes(item))) return false;
    if (requirements?.harness?.some((item) => !candidate.harness.includes(item))) return false;
    if (requirements?.maxCostRank && candidate.costRank > requirements.maxCostRank) return false;
    if (requirements?.maxLatencyRank && candidate.latencyRank > requirements.maxLatencyRank) return false;
    const independence = request.independence;
    const [provider] = candidate.id.split("/", 1);
    if (independence?.required && independence.avoidProvider === provider) return false;
    if (independence?.required && independence.avoidFamily === candidate.family) return false;
    return true;
  });

  const requestedRank = capabilities.indexOf(request.minimumCapability);
  const exactOrBetter = compatible.filter(
    (candidate) => capabilities.indexOf(candidate.capability) >= requestedRank,
  );
  const degraded = compatible.filter(
    (candidate) => capabilities.indexOf(candidate.capability) < requestedRank,
  );
  const pool = exactOrBetter.length > 0
    ? exactOrBetter
    : request.allowDegraded
      ? degraded
      : [];

  if (pool.length === 0) {
    throw new ModelResolutionError(
      degraded.length > 0
        ? "Only degraded-capability models are available; explicit opt-in is required"
        : "No allowlisted OpenAI/DeepSeek model satisfies the request",
      {
        alternatives: exactOrBetter.map((model) => model.id),
        degradedAlternatives: degraded.map((model) => model.id),
      },
    );
  }

  const ranked = [...pool].sort((left, right) => {
    const leftCapability = capabilities.indexOf(left.capability);
    const rightCapability = capabilities.indexOf(right.capability);
    const targetDelta = Math.abs(leftCapability - requestedRank) - Math.abs(rightCapability - requestedRank);
    if (targetDelta !== 0) return targetDelta;
    return (
      left.preferenceRank - right.preferenceRank ||
      left.costRank - right.costRank ||
      left.latencyRank - right.latencyRank ||
      left.id.localeCompare(right.id)
    );
  });
  const selected = ranked[0]!;
  const [provider] = selected.id.split("/", 1) as ["openai-codex" | "deepseek"];
  const providedRank = capabilities.indexOf(selected.capability);
  const thinking = selected.thinkingMap[request.effort];
  return {
    model: selected.id,
    provider,
    family: selected.family,
    thinking,
    requestedCapability: request.minimumCapability,
    providedCapability: selected.capability,
    degradedCapability: providedRank < requestedRank,
    exactThinking: thinking === request.effort,
    alternatives: ranked.slice(1).map((candidate) => candidate.id),
    reason: `Selected ${selected.capability} for ${request.minimumCapability}; thinking ${request.effort} -> ${thinking}`,
  };
}
