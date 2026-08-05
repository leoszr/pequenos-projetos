import { describe, expect, it, vi } from "vitest";
import { formatSkillsForPrompt, type BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";

import {
  HOLISTIC_TOOL_NAMES,
  appendSubagentGuidance,
  registerHolisticMode,
  removeHolisticSkill,
} from "../../src/pi/mode.ts";

function skill(name: string) {
  return {
    name,
    description: `${name} description`,
    filePath: `/skills/${name}/SKILL.md`,
    baseDir: `/skills/${name}`,
    sourceInfo: { path: `/skills/${name}/SKILL.md`, source: "test", scope: "temporary", origin: "top-level" },
    disableModelInvocation: false,
  } as const;
}

function fixture(branch: unknown[] = []) {
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const commands = new Map<string, any>();
  let activeTools = ["read", ...HOLISTIC_TOOL_NAMES];
  const pi = {
    getActiveTools: vi.fn(() => [...activeTools]),
    setActiveTools: vi.fn((tools: string[]) => { activeTools = [...tools]; }),
    appendEntry: vi.fn(),
    registerShortcut: vi.fn(),
    registerCommand: vi.fn((name: string, command: any) => commands.set(name, command)),
    on: vi.fn((event: string, handler: (event: any, ctx: any) => any) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    }),
  };
  const ctx = {
    sessionManager: { getBranch: () => branch },
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      setStatus: vi.fn(),
      notify: vi.fn(),
    },
  };
  return { pi, ctx, handlers, commands, activeTools: () => activeTools };
}

describe("holistic mode", () => {
  it("starts off and removes all delegation tools", async () => {
    const value = fixture();
    const mode = registerHolisticMode(value.pi as never);
    await value.handlers.get("session_start")?.[0]?.({}, value.ctx);

    expect(mode.isEnabled()).toBe(false);
    expect(value.activeTools()).toEqual(["read"]);
    expect(value.ctx.ui.setStatus).toHaveBeenCalledWith("holistic-mode", "subagents: off");
  });

  it("toggles on, restores tools, and persists the session state", async () => {
    const value = fixture();
    const mode = registerHolisticMode(value.pi as never);
    await value.handlers.get("session_start")?.[0]?.({}, value.ctx);
    await value.commands.get("holistic-mode").handler("on", value.ctx);

    expect(mode.isEnabled()).toBe(true);
    expect(value.activeTools()).toEqual(["read", ...HOLISTIC_TOOL_NAMES]);
    expect(value.pi.appendEntry).toHaveBeenCalledWith("holistic-mode", { enabled: true });
  });

  it("restores an enabled mode from the active session branch", async () => {
    const value = fixture([{ type: "custom", customType: "holistic-mode", data: { enabled: true } }]);
    const mode = registerHolisticMode(value.pi as never);
    await value.handlers.get("session_start")?.[0]?.({}, value.ctx);

    expect(mode.isEnabled()).toBe(true);
    expect(value.activeTools()).toEqual(["read", ...HOLISTIC_TOOL_NAMES]);
    expect(value.pi.appendEntry).not.toHaveBeenCalled();
  });

  it("removes tools while the coordinator runtime is unavailable", async () => {
    const value = fixture([{ type: "custom", customType: "holistic-mode", data: { enabled: true } }]);
    const mode = registerHolisticMode(value.pi as never);
    await value.handlers.get("session_start")?.[0]?.({}, value.ctx);

    mode.setAvailable(false);
    expect(mode.isEnabled()).toBe(false);
    expect(value.activeTools()).toEqual(["read"]);

    mode.setAvailable(true);
    expect(mode.isEnabled()).toBe(true);
    expect(value.activeTools()).toEqual(["read", ...HOLISTIC_TOOL_NAMES]);
  });

  it("rebuilds mode state after session tree navigation", async () => {
    const branch: unknown[] = [];
    const value = fixture(branch);
    const mode = registerHolisticMode(value.pi as never);
    await value.handlers.get("session_start")?.[0]?.({}, value.ctx);
    branch.push({ type: "custom", customType: "holistic-mode", data: { enabled: true } });
    await value.handlers.get("session_tree")?.[0]?.({}, value.ctx);

    expect(mode.isEnabled()).toBe(true);
    expect(value.activeTools()).toEqual(["read", ...HOLISTIC_TOOL_NAMES]);
  });

  it("blocks a stale create call while off", async () => {
    const value = fixture();
    registerHolisticMode(value.pi as never);
    await value.handlers.get("session_start")?.[0]?.({}, value.ctx);

    const result = await value.handlers.get("tool_call")?.[0]?.({ toolName: "holistic_create" }, value.ctx);
    expect(result).toEqual(expect.objectContaining({ block: true }));
  });
});

describe("removeHolisticSkill", () => {
  it("removes only the holistic skill from the assembled prompt and options", () => {
    const options: BuildSystemPromptOptions = {
      cwd: "/tmp",
      skills: [skill("other"), skill("holistic-subagents")],
    };
    const prompt = `base${formatSkillsForPrompt(options.skills ?? [])}\nend`;
    const result = removeHolisticSkill(prompt, options);

    expect(result).not.toContain("<name>holistic-subagents</name>");
    expect(result).toContain("<name>other</name>");
    expect(options.skills?.map(({ name }) => name)).toEqual(["other"]);
  });
});

describe("subagent guidance injection", () => {
  const HEADING = "# Uso de subagentes";
  const occurrences = (text: string) => text.split(HEADING).length - 1;
  const promptEvent = (systemPrompt: string, skills: ReturnType<typeof skill>[] = []) => ({
    prompt: "run",
    systemPrompt,
    systemPromptOptions: { skills } satisfies Partial<BuildSystemPromptOptions>,
  });

  it("injects the guidance section exactly once while on", async () => {
    const value = fixture();
    registerHolisticMode(value.pi as never);
    await value.handlers.get("session_start")?.[0]?.({}, value.ctx);
    await value.commands.get("holistic-mode").handler("on", value.ctx);

    const handler = value.handlers.get("before_agent_start")?.[0]!;
    const first = await handler(promptEvent("base"), value.ctx);
    expect(first?.systemPrompt).toContain(HEADING);
    expect(occurrences(first!.systemPrompt)).toBe(1);

    const second = await handler(promptEvent(first!.systemPrompt), value.ctx);
    expect(second?.systemPrompt).toBe(first!.systemPrompt);
    expect(occurrences(second!.systemPrompt)).toBe(1);
  });

  it("does not inject guidance while off", async () => {
    const value = fixture();
    registerHolisticMode(value.pi as never);
    await value.handlers.get("session_start")?.[0]?.({}, value.ctx);

    const result = await value.handlers.get("before_agent_start")?.[0]?.(
      promptEvent("base"),
      value.ctx,
    );
    expect(result?.systemPrompt).toBe("base");
    expect(result?.systemPrompt).not.toContain(HEADING);
  });

  it("restores mode on navigation and respects it for guidance injection", async () => {
    const branch: unknown[] = [];
    const value = fixture(branch);
    registerHolisticMode(value.pi as never);
    await value.handlers.get("session_start")?.[0]?.({}, value.ctx);

    branch.push({ type: "custom", customType: "holistic-mode", data: { enabled: true } });
    await value.handlers.get("session_tree")?.[0]?.({}, value.ctx);
    const enabled = await value.handlers.get("before_agent_start")?.[0]?.(
      promptEvent("base"),
      value.ctx,
    );
    expect(enabled?.systemPrompt).toContain(HEADING);

    branch.push({ type: "custom", customType: "holistic-mode", data: { enabled: false } });
    await value.handlers.get("session_tree")?.[0]?.({}, value.ctx);
    const disabled = await value.handlers.get("before_agent_start")?.[0]?.(
      promptEvent("base"),
      value.ctx,
    );
    expect(disabled?.systemPrompt).toBe("base");
    expect(disabled?.systemPrompt).not.toContain(HEADING);
  });

  it("keeps removing the holistic skill while off", async () => {
    const value = fixture();
    registerHolisticMode(value.pi as never);
    await value.handlers.get("session_start")?.[0]?.({}, value.ctx);

    const skills = [skill("other"), skill("holistic-subagents")];
    const event = promptEvent(`base${formatSkillsForPrompt(skills)}\nend`, skills);
    const result = await value.handlers.get("before_agent_start")?.[0]?.(event, value.ctx);

    expect(result?.systemPrompt).not.toContain("<name>holistic-subagents</name>");
    expect(result?.systemPrompt).toContain("<name>other</name>");
    expect((event.systemPromptOptions.skills ?? []).map(({ name }) => name)).toEqual(["other"]);
  });

  it("appends the section once and reuses an already-injected prompt", () => {
    const first = appendSubagentGuidance("base");
    expect(occurrences(first)).toBe(1);
    expect(appendSubagentGuidance(first)).toBe(first);
  });
});
