import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import holisticSubagents from "../../extensions/holistic-subagents.ts";

describe("hybrid package", () => {
  it("loads the extension entrypoint", () => {
    const previous = process.env.HOLISTIC_SUBAGENT_DEPTH;
    process.env.HOLISTIC_SUBAGENT_DEPTH = "1";
    const pi = { on: () => undefined };
    expect(() => holisticSubagents(pi as never)).not.toThrow();
    if (previous === undefined) delete process.env.HOLISTIC_SUBAGENT_DEPTH;
    else process.env.HOLISTIC_SUBAGENT_DEPTH = previous;
  });

  it("publishes the conventional skill directory", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
    expect(packageJson.pi.skills).toEqual(["./skills"]);
    expect(() => readFileSync("skills/holistic-subagents/SKILL.md", "utf8")).not.toThrow();
  });
});
