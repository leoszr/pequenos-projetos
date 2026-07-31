import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

import type { DelegationService } from "../../src/domain/service.ts";
import { registerHolisticTools } from "../../src/pi/tools.ts";
import { parseModelPolicy, validateModelPolicy } from "../../src/models/policy.ts";
import { modelRequestSchemas } from "../../src/pi/model-policy-schema.ts";

const policy = parseModelPolicy(
  readFileSync(new URL("../../src/models/default-policy.json", import.meta.url), "utf8"),
);

interface RegisteredTool {
  name: string;
  parameters: unknown;
  execute(id: string, params: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
}

describe("holistic_create tool", () => {
  it("derives the effort schema from the injected policy", () => {
    const maxOnly = validateModelPolicy({
      ...policy,
      efforts: ["max"],
      defaultEffort: { bounded: "max", scoped: "max", cross_cutting: "max", high_agency: "max" },
      purposeDefaultEffort: { verification: "max" },
      models: policy.models.map((model) => ({
        ...model,
        thinkingMap: { max: model.thinkingMap.max ?? "max" },
      })),
    });
    const schema = JSON.stringify(modelRequestSchemas(maxOnly).effort);
    expect(schema).toContain('"const":"auto"');
    expect(schema).toContain('"const":"max"');
    expect(schema).not.toContain('"const":"xhigh"');
  });

  it("exposes capability plus automatic effort and keeps model IDs internal", async () => {
    const tools: RegisteredTool[] = [];
    const create = vi.fn(async (request) => ({
      id: "d1",
      state: "working",
      request,
      modelResolution: {
        model: "openai-codex/gpt-5.6-terra",
        thinking: "medium",
        requestedEffort: "auto",
        effectiveEffort: "medium",
      },
    }));
    registerHolisticTools(
      { registerTool: (tool: RegisteredTool) => tools.push(tool) } as never,
      () => ({ create } as unknown as DelegationService),
      policy,
    );

    const tool = tools.find((candidate) => candidate.name === "holistic_create");
    expect(tool).toBeDefined();
    const schema = JSON.stringify(tool?.parameters);
    expect(schema).toContain("minimumCapability");
    expect(schema).toContain("bounded");
    expect(schema).toContain("scoped");
    expect(schema).toContain("cross_cutting");
    expect(schema).toContain("high_agency");
    expect(schema).toContain("auto");

    const result = await tool?.execute(
      "call-1",
      {
        name: "research",
        mission: "Compare independent sources",
        cwd: "/repo",
        authority: { mode: "read_only", allowedPaths: [] },
        acceptanceEvidence: ["cited findings"],
        topology: "pane",
        minimumCapability: "cross_cutting",
        effort: "auto",
      },
      new AbortController().signal,
    );

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: expect.objectContaining({ minimumCapability: "cross_cutting", effort: undefined }),
      }),
      expect.any(AbortSignal),
    );
    expect(JSON.stringify(result)).toContain("effort:auto→medium");
    expect(JSON.stringify(result)).toContain("think:medium");
  });
});
