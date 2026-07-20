import { describe, expect, it } from "vitest";

import {
  assertAuthorityPreconditions,
  auditAuthority,
  coordinatorEnabled,
  type CommandRunner,
} from "../../src/security/authority.ts";

function runner(status: string): CommandRunner {
  return {
    async run(_command, args) {
      return { stdout: args[0] === "status" ? status : "", stderr: "", code: 0 };
    },
  };
}

describe("declarative authority", () => {
  it("structurally disables coordination in children", () => {
    expect(coordinatorEnabled({ HERDR_ENV: "1" })).toBe(true);
    expect(coordinatorEnabled({ HERDR_ENV: "1", HOLISTIC_SUBAGENT_DEPTH: "1" })).toBe(false);
  });

  it("requires an external sandbox only when explicitly requested", () => {
    expect(() =>
      assertAuthorityPreconditions(
        { mode: "read_only", allowedPaths: [], requireExternalSandbox: true },
        {},
      ),
    ).toThrow("external filesystem sandbox");
    expect(() =>
      assertAuthorityPreconditions(
        { mode: "read_only", allowedPaths: [], requireExternalSandbox: true },
        { HOLISTIC_READONLY_SANDBOX: "1" },
      ),
    ).not.toThrow();
  });

  it("detects read-only side effects without matching tool names", async () => {
    const result = await auditAuthority(
      runner("?? generated.txt\n"),
      "/repo",
      { mode: "read_only", allowedPaths: [] },
      { capturedAt: "now", gitRoot: "/repo", statusLines: [] },
    );
    expect(result.ok).toBe(false);
    expect(result.evidence.changedPaths).toEqual(["generated.txt"]);
  });

  it("audits controlled mutation path boundaries", async () => {
    const result = await auditAuthority(
      runner(" M src/ok.ts\n M package.json\n"),
      "/repo",
      { mode: "controlled_mutation", allowedPaths: ["src"] },
      { capturedAt: "now", gitRoot: "/repo", statusLines: [] },
    );
    expect(result.violations).toEqual(["changed path outside authority: package.json"]);
  });
});
