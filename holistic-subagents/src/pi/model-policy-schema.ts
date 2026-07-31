import { Type, type TUnsafe } from "@sinclair/typebox";

import { CAPABILITIES, type Capability, type ThinkingLevel } from "../domain/types.ts";
import type { ModelPolicy } from "../models/policy.ts";

const capabilityDescriptions: Record<Capability, string> = {
  bounded: "Localized, explicit, low-agency work",
  scoped: "Well-defined multi-step implementation or investigation",
  cross_cutting: "Several modules, wider exploration, or material ambiguity",
  high_agency: "Broad, long-horizon mission requiring sustained autonomy",
};

export function modelRequestSchemas(policy: ModelPolicy): {
  capability: TUnsafe<Capability>;
  effort: TUnsafe<ThinkingLevel | "auto">;
} {
  const capability = stringUnion<Capability>(
    CAPABILITIES,
    Object.fromEntries(CAPABILITIES.map((value) => [value, capabilityDescriptions[value]])),
    "Minimum task capability; concrete model selection stays automatic",
  );
  const efforts = ["auto", ...policy.efforts] as const;
  const effort = stringUnion<ThinkingLevel | "auto">(
    efforts,
    Object.fromEntries(efforts.map((value) => [
      value,
      value === "auto" ? "Use the effective policy default" : `Use configured ${value} reasoning`,
    ])),
    "Reasoning policy exposed by the effective model policy",
  );
  return { capability, effort };
}

function stringUnion<T extends string>(
  values: readonly T[],
  descriptions: Readonly<Record<string, string>>,
  description: string,
): TUnsafe<T> {
  return Type.Unsafe<T>({
    anyOf: values.map((value) => ({
      type: "string",
      const: value,
      description: descriptions[value],
    })),
    description,
  });
}
