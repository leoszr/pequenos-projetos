import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  CAPABILITIES,
  DELEGATION_PURPOSES,
  PI_THINKING_LEVELS,
  type Capability,
  type DelegationPurpose,
  type ModelRequest,
  type ModelResolution,
  type ThinkingLevel,
} from "../domain/types.ts";

export const MODEL_POLICY_RELATIVE_PATH = join("holistic-subagents", "model-policy.json");

export interface PolicyModel {
  id: string;
  family: string;
  capability: Capability;
  purposes: DelegationPurpose[];
  thinkingMap: Partial<Record<ThinkingLevel, ThinkingLevel>>;
  tools: string[];
  harness: string[];
  preferenceRank: number;
  latencyRank: number;
  costRank: number;
}

export interface ModelPolicy {
  version: 1;
  providers: string[];
  efforts: ThinkingLevel[];
  defaultEffort: Record<Capability, ThinkingLevel>;
  purposeDefaultEffort: Partial<Record<DelegationPurpose, ThinkingLevel>>;
  models: PolicyModel[];
}

export interface AvailableModel {
  provider: string;
  id: string;
  contextWindow: number;
  input: Array<"text" | "image">;
}

export interface LoadedModelPolicy {
  policy: ModelPolicy;
  path: string;
  scope: "project" | "global";
  created: boolean;
}

export interface ModelPolicyResolver {
  resolve(request: ModelRequest, available: readonly AvailableModel[]): ModelResolution;
  resolveFixed(
    modelId: string,
    request: ModelRequest,
    available: readonly AvailableModel[],
  ): ModelResolution | undefined;
}

export class ModelPolicyError extends Error {
  readonly path?: string;

  constructor(message: string, path?: string) {
    super(path ? `${path}: ${message}` : message);
    this.name = "ModelPolicyError";
    this.path = path;
  }
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

export function globalModelPolicyDirectory(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

export async function loadEffectiveModelPolicy(options: {
  cwd: string;
  projectTrusted: boolean;
  projectConfigDirName: string;
  globalConfigDir?: string;
  defaultPolicyUrl?: URL;
}): Promise<LoadedModelPolicy> {
  const globalPath = join(
    options.globalConfigDir ?? globalModelPolicyDirectory(),
    MODEL_POLICY_RELATIVE_PATH,
  );
  const projectPath = join(options.cwd, options.projectConfigDirName, MODEL_POLICY_RELATIVE_PATH);

  if (options.projectTrusted && await fileExists(projectPath)) {
    return {
      policy: await readModelPolicy(projectPath),
      path: projectPath,
      scope: "project",
      created: false,
    };
  }
  if (await fileExists(globalPath)) {
    return {
      policy: await readModelPolicy(globalPath),
      path: globalPath,
      scope: "global",
      created: false,
    };
  }

  const defaultUrl = options.defaultPolicyUrl ?? new URL("./default-policy.json", import.meta.url);
  const rawDefault = await readFile(defaultUrl, "utf8");
  parseModelPolicy(rawDefault, defaultUrl.pathname);
  await mkdir(dirname(globalPath), { recursive: true });
  let created = true;
  try {
    await writeFile(globalPath, ensureTrailingNewline(rawDefault), { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (!isNodeError(error, "EEXIST")) throw error;
    created = false;
  }
  return {
    policy: await readModelPolicy(globalPath),
    path: globalPath,
    scope: "global",
    created,
  };
}

export async function readModelPolicy(path: string): Promise<ModelPolicy> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    throw new ModelPolicyError(error instanceof Error ? error.message : String(error), path);
  }
  return parseModelPolicy(raw, path);
}

export function parseModelPolicy(raw: string, path?: string): ModelPolicy {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new ModelPolicyError(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`, path);
  }
  return validateModelPolicy(value, path);
}

export function validateModelPolicy(value: unknown, path?: string): ModelPolicy {
  const fail = (message: string): never => { throw new ModelPolicyError(message, path); };
  if (!isRecord(value)) fail("policy must be an object");
  const record = value as Record<string, unknown>;
  assertKnownKeys(
    record,
    ["version", "providers", "efforts", "defaultEffort", "purposeDefaultEffort", "models"],
    "policy",
    fail,
  );
  if (record.version !== 1) fail("unsupported policy version; expected 1");

  const providers = stringArray(record.providers, "providers", fail);
  if (!providers.length) fail("providers must not be empty");
  assertUnique(providers, "providers", fail);

  const efforts = stringArray(record.efforts, "efforts", fail);
  if (!efforts.length) fail("efforts must not be empty");
  assertUnique(efforts, "efforts", fail);
  if (efforts.some((effort) => !isThinkingLevel(effort))) {
    fail(`efforts must use Pi levels: ${PI_THINKING_LEVELS.join(", ")}`);
  }
  const typedEfforts = efforts as ThinkingLevel[];

  const defaults = effortRecord(record.defaultEffort, "defaultEffort", CAPABILITIES, typedEfforts, fail);
  const purposeDefaults = optionalEffortRecord(
    record.purposeDefaultEffort,
    "purposeDefaultEffort",
    DELEGATION_PURPOSES,
    typedEfforts,
    fail,
  );

  const modelValues = record.models;
  if (!Array.isArray(modelValues) || !modelValues.length) fail("models must be a non-empty array");
  const models = (modelValues as unknown[]).map((candidate, index) =>
    validatePolicyModel(candidate, index, providers, typedEfforts, fail));
  assertUnique(models.map((model) => model.id), "model IDs", fail);
  for (const provider of providers) {
    if (!models.some((model) => model.id.startsWith(`${provider}/`))) {
      fail(`provider has no model: ${provider}`);
    }
  }
  for (const purpose of DELEGATION_PURPOSES) {
    if (!models.some((model) => model.purposes.includes(purpose))) {
      fail(`policy has no ${purpose} model`);
    }
  }

  return {
    version: 1,
    providers,
    efforts: typedEfforts,
    defaultEffort: defaults as Record<Capability, ThinkingLevel>,
    purposeDefaultEffort: purposeDefaults as Partial<Record<DelegationPurpose, ThinkingLevel>>,
    models,
  };
}

export function createModelPolicyResolver(input: ModelPolicy): ModelPolicyResolver {
  const policy = validateModelPolicy(structuredClone(input));
  return {
    resolve(request, available) {
      return resolveWithPolicy(policy, request, available);
    },
    resolveFixed(modelId, request, available) {
      const candidate = policy.models.find((model) => model.id === modelId);
      const runtime = available.find((model) => `${model.provider}/${model.id}` === modelId);
      const purpose = request.purpose ?? "execution";
      if (!candidate || !runtime || !candidate.purposes.includes(purpose)) return undefined;
      const effort = request.effort
        ?? policy.purposeDefaultEffort[purpose]
        ?? policy.defaultEffort[request.minimumCapability];
      const thinking = candidate.thinkingMap[effort];
      if (!policy.efforts.includes(effort) || !thinking) return undefined;
      const requirements = request.requirements;
      if (requirements?.minContextWindow && runtime.contextWindow < requirements.minContextWindow) return undefined;
      if (requirements?.modalities?.some((item) => !runtime.input.includes(item))) return undefined;
      if (requirements?.tools?.some((item) => !candidate.tools.includes(item))) return undefined;
      if (requirements?.harness?.some((item) => !candidate.harness.includes(item))) return undefined;
      if (requirements?.maxCostRank && candidate.costRank > requirements.maxCostRank) return undefined;
      if (requirements?.maxLatencyRank && candidate.latencyRank > requirements.maxLatencyRank) return undefined;
      if (request.independence?.required && request.independence.avoidFamily === candidate.family) return undefined;
      const requestedRank = CAPABILITIES.indexOf(request.minimumCapability);
      const providedRank = CAPABILITIES.indexOf(candidate.capability);
      if (!request.allowDegraded && providedRank < requestedRank) return undefined;
      return {
        model: candidate.id,
        provider: candidate.id.split("/", 1)[0]!,
        family: candidate.family,
        thinking,
        requestedCapability: request.minimumCapability,
        providedCapability: candidate.capability,
        degradedCapability: providedRank < requestedRank,
        exactThinking: thinking === effort,
        alternatives: [],
        reason: `Fixed Session model remains eligible; thinking ${effort} -> ${thinking}`,
        requestedEffort: request.effort ?? "auto",
        effectiveEffort: effort,
        purpose,
      };
    },
  };
}

export function unavailablePolicyModels(
  policy: ModelPolicy,
  available: readonly AvailableModel[],
): string[] {
  const ids = new Set(available.map((model) => `${model.provider}/${model.id}`));
  return policy.models.map((model) => model.id).filter((id) => !ids.has(id));
}

function resolveWithPolicy(
  policy: ModelPolicy,
  request: ModelRequest,
  available: readonly AvailableModel[],
): ModelResolution {
  const purpose = request.purpose ?? "execution";
  const requestedEffort = request.effort ?? "auto";
  if (request.effort && !policy.efforts.includes(request.effort)) {
    throw new ModelResolutionError(`Effort is not exposed by the effective policy: ${request.effort}`, {
      code: "INVALID_EFFORT",
    });
  }
  const effectiveEffort = request.effort
    ?? policy.purposeDefaultEffort[purpose]
    ?? policy.defaultEffort[request.minimumCapability];
  const availableById = new Map(
    available.map((model) => [`${model.provider}/${model.id}`, model]),
  );
  const compatible = policy.models.filter((candidate) => {
    const runtime = availableById.get(candidate.id);
    if (!runtime || !candidate.purposes.includes(purpose)) return false;
    const requirements = request.requirements;
    if (requirements?.minContextWindow && runtime.contextWindow < requirements.minContextWindow) return false;
    if (requirements?.modalities?.some((item) => !runtime.input.includes(item))) return false;
    if (requirements?.tools?.some((item) => !candidate.tools.includes(item))) return false;
    if (requirements?.harness?.some((item) => !candidate.harness.includes(item))) return false;
    if (requirements?.maxCostRank && candidate.costRank > requirements.maxCostRank) return false;
    if (requirements?.maxLatencyRank && candidate.latencyRank > requirements.maxLatencyRank) return false;
    if (request.independence?.required && request.independence.avoidFamily === candidate.family) return false;
    return true;
  });

  const requestedRank = CAPABILITIES.indexOf(request.minimumCapability);
  const exactOrBetter = compatible.filter((candidate) =>
    CAPABILITIES.indexOf(candidate.capability) >= requestedRank);
  const degraded = compatible.filter((candidate) =>
    CAPABILITIES.indexOf(candidate.capability) < requestedRank);
  const pool = exactOrBetter.length ? exactOrBetter : request.allowDegraded ? degraded : [];
  if (!pool.length) {
    throw new ModelResolutionError(
      degraded.length
        ? "Only degraded-capability models are available; explicit opt-in is required"
        : "No model in the effective policy satisfies the request",
      {
        alternatives: exactOrBetter.map((model) => model.id),
        degradedAlternatives: degraded.map((model) => model.id),
      },
    );
  }

  const ranked = [...pool].sort((left, right) => {
    const targetDelta = Math.abs(CAPABILITIES.indexOf(left.capability) - requestedRank)
      - Math.abs(CAPABILITIES.indexOf(right.capability) - requestedRank);
    return targetDelta
      || left.preferenceRank - right.preferenceRank
      || left.costRank - right.costRank
      || left.latencyRank - right.latencyRank
      || left.id.localeCompare(right.id);
  });
  const selected = ranked[0]!;
  const thinking = selected.thinkingMap[effectiveEffort];
  if (!thinking) {
    throw new ModelResolutionError(
      `Model ${selected.id} has no thinking translation for ${effectiveEffort}`,
      { code: "INVALID_THINKING_MAP" },
    );
  }
  const [provider] = selected.id.split("/", 1);
  const providedRank = CAPABILITIES.indexOf(selected.capability);
  return {
    model: selected.id,
    provider: provider!,
    family: selected.family,
    thinking,
    requestedCapability: request.minimumCapability,
    providedCapability: selected.capability,
    degradedCapability: providedRank < requestedRank,
    exactThinking: thinking === effectiveEffort,
    alternatives: ranked.slice(1).map((candidate) => candidate.id),
    reason: `Selected ${selected.capability} ${purpose} model for ${request.minimumCapability}; effort ${requestedEffort} -> ${effectiveEffort}; thinking ${effectiveEffort} -> ${thinking}`,
    requestedEffort,
    effectiveEffort,
    purpose,
  };
}

function validatePolicyModel(
  value: unknown,
  index: number,
  providers: readonly string[],
  efforts: readonly ThinkingLevel[],
  fail: (message: string) => never,
): PolicyModel {
  if (!isRecord(value)) fail(`models[${index}] must be an object`);
  assertKnownKeys(
    value,
    [
      "id", "family", "capability", "purposes", "thinkingMap",
      "tools", "harness", "preferenceRank", "latencyRank", "costRank",
    ],
    `models[${index}]`,
    fail,
  );
  const id = requiredString(value.id, `models[${index}].id`, fail);
  const provider = id.split("/", 1)[0]!;
  if (!providers.includes(provider)) fail(`model outside provider allowlist: ${id}`);
  const family = requiredString(value.family, `models[${index}].family`, fail);
  if (!CAPABILITIES.includes(value.capability as Capability)) {
    fail(`invalid capability for ${id}`);
  }
  const purposes = stringArray(value.purposes, `models[${index}].purposes`, fail);
  if (!purposes.length || purposes.some((purpose) => !DELEGATION_PURPOSES.includes(purpose as DelegationPurpose))) {
    fail(`invalid purposes for ${id}`);
  }
  assertUnique(purposes, `purposes for ${id}`, fail);
  if (!isRecord(value.thinkingMap)) fail(`thinkingMap must be an object for ${id}`);
  if (!sameMembers(Object.keys(value.thinkingMap), efforts)) fail(`thinkingMap must cover configured efforts for ${id}`);
  const thinkingMap: Partial<Record<ThinkingLevel, ThinkingLevel>> = {};
  for (const effort of efforts) {
    const translated = value.thinkingMap[effort];
    if (!isThinkingLevel(translated)) fail(`invalid thinking translation for ${id}: ${effort}`);
    thinkingMap[effort] = translated;
  }
  return {
    id,
    family,
    capability: value.capability as Capability,
    purposes: purposes as DelegationPurpose[],
    thinkingMap,
    tools: stringArray(value.tools, `models[${index}].tools`, fail),
    harness: stringArray(value.harness, `models[${index}].harness`, fail),
    preferenceRank: finiteNumber(value.preferenceRank, `models[${index}].preferenceRank`, fail),
    latencyRank: finiteNumber(value.latencyRank, `models[${index}].latencyRank`, fail),
    costRank: finiteNumber(value.costRank, `models[${index}].costRank`, fail),
  };
}

function effortRecord(
  value: unknown,
  label: string,
  keys: readonly string[],
  efforts: readonly ThinkingLevel[],
  fail: (message: string) => never,
): Record<string, ThinkingLevel> {
  if (!isRecord(value) || !sameMembers(Object.keys(value), keys)) fail(`${label} must cover ${keys.join(", ")}`);
  const result: Record<string, ThinkingLevel> = {};
  for (const key of keys) {
    const effort = value[key];
    if (!isThinkingLevel(effort) || !efforts.includes(effort)) fail(`${label}.${key} must be an exposed effort`);
    result[key] = effort;
  }
  return result;
}

function optionalEffortRecord(
  value: unknown,
  label: string,
  keys: readonly string[],
  efforts: readonly ThinkingLevel[],
  fail: (message: string) => never,
): Record<string, ThinkingLevel> {
  if (value === undefined) return {};
  if (!isRecord(value)) fail(`${label} must be an object`);
  const result: Record<string, ThinkingLevel> = {};
  for (const [key, effort] of Object.entries(value)) {
    if (!keys.includes(key)) fail(`${label} has unknown purpose: ${key}`);
    if (!isThinkingLevel(effort) || !efforts.includes(effort)) fail(`${label}.${key} must be an exposed effort`);
    result[key] = effort;
  }
  return result;
}

function stringArray(value: unknown, label: string, fail: (message: string) => never): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    fail(`${label} must be an array of non-empty strings`);
  }
  return value as string[];
}

function requiredString(value: unknown, label: string, fail: (message: string) => never): string {
  if (typeof value !== "string" || !value.trim()) fail(`${label} must be a non-empty string`);
  return value as string;
}

function finiteNumber(value: unknown, label: string, fail: (message: string) => never): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) fail(`${label} must be a non-negative number`);
  return value as number;
}

function assertUnique(values: readonly string[], label: string, fail: (message: string) => never): void {
  if (new Set(values).size !== values.length) fail(`${label} must not contain duplicates`);
}

function assertKnownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
  fail: (message: string) => never,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) fail(`${label} has unknown fields: ${unknown.join(", ")}`);
}

function sameMembers(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && PI_THINKING_LEVELS.includes(value as ThinkingLevel);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
