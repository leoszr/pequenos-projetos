import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertAuthorityPreconditions,
  auditAuthority,
  captureAuthorityBaseline,
  coordinatorEnabled,
  parseStatusEntries,
  pathsFromEntry,
  type CommandResult,
  type CommandRunner,
} from "../../src/security/authority.ts";

type Handler = (args: string[]) => CommandResult;

function git(handlers: Record<string, Handler> = {}): CommandRunner {
  const fallback: CommandResult = { stdout: "", stderr: "", code: 0 };
  return {
    async run(_command, args) {
      const key = args[0] === "rev-parse" ? `rev-parse:${args[1] ?? ""}` : args[0];
      return handlers[key]?.(args) ?? fallback;
    },
  };
}

const ok = (stdout: string): CommandResult => ({ stdout, stderr: "", code: 0 });

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
    expect(() =>
      assertAuthorityPreconditions(
        { mode: "controlled_mutation", allowedPaths: [], requireExternalSandbox: true },
        {},
      ),
    ).toThrow("external filesystem sandbox");
  });

  it("parses porcelain -z entries without inventing paths from ' -> '", () => {
    const stdout = [
      " M src/plain.ts",
      "R  renamed -> dest.txt",
      "has -> arrow.txt",
      "C  copy \"quoted\".txt",
      "src/copied.txt",
      "?? untracked with space.txt",
    ].join("\0") + "\0";
    expect(parseStatusEntries(stdout)).toEqual([
      [" M src/plain.ts"],
      ["R  renamed -> dest.txt", "has -> arrow.txt"],
      ["C  copy \"quoted\".txt", "src/copied.txt"],
      ["?? untracked with space.txt"],
    ]);
    expect(parseStatusEntries(stdout).flatMap(pathsFromEntry)).toEqual([
      "src/plain.ts",
      "renamed -> dest.txt",
      "has -> arrow.txt",
      "copy \"quoted\".txt",
      "src/copied.txt",
      "untracked with space.txt",
    ]);
  });

  it("detects read-only side effects without matching tool names", async () => {
    const result = await auditAuthority(
      git({
        status: () => ok("?? generated.txt\0"),
        "rev-parse:HEAD": () => ok("abc\n"),
      }),
      "/repo",
      { mode: "read_only", allowedPaths: [] },
      {
        capturedAt: "now",
        valid: true,
        gitRoot: "/repo",
        head: "abc",
        statusLines: [],
        pathEvidence: {},
      },
    );
    expect(result.ok).toBe(false);
    expect(result.evidence.changedPaths).toEqual(["generated.txt"]);
  });

  it("audits controlled mutation path boundaries", async () => {
    const result = await auditAuthority(
      git({
        status: () => ok(" M src/ok.ts\0 M package.json\0"),
        "rev-parse:HEAD": () => ok("abc\n"),
      }),
      "/repo",
      { mode: "controlled_mutation", allowedPaths: ["src"] },
      {
        capturedAt: "now",
        valid: true,
        gitRoot: "/repo",
        head: "abc",
        statusLines: [],
        pathEvidence: {},
      },
    );
    expect(result.violations).toEqual(["changed path outside authority: package.json"]);
  });

  it("detects a later change to a path already dirty in the baseline", async () => {
    let diff = "baseline diff";
    const gitRunner = git({
      status: () => ok(" M src/dirty.ts\0"),
      diff: () => ok(diff),
      "rev-parse:HEAD": () => ok("abc\n"),
      "rev-parse:--show-toplevel": () => ok("/repo\n"),
    });
    const baseline = await captureAuthorityBaseline(gitRunner, "/repo");
    diff = "later diff";

    const result = await auditAuthority(
      gitRunner,
      "/repo",
      { mode: "read_only", allowedPaths: [] },
      baseline,
    );

    expect(result.ok).toBe(false);
    expect(result.evidence.changedPaths).toEqual(["src/dirty.ts"]);
  });

  it("accepts an intact preexisting dirty path", async () => {
    const gitRunner = git({
      status: () => ok(" M src/dirty.ts\0"),
      diff: () => ok("same diff"),
      "rev-parse:HEAD": () => ok("abc\n"),
      "rev-parse:--show-toplevel": () => ok("/repo\n"),
    });
    const baseline = await captureAuthorityBaseline(gitRunner, "/repo");

    const result = await auditAuthority(
      gitRunner,
      "/repo",
      { mode: "read_only", allowedPaths: [] },
      baseline,
    );

    expect(result.ok).toBe(true);
    expect(result.evidence.changedPaths).toEqual([]);
  });

  it("fails closed when git collection fails during baseline capture", async () => {
    const baseline = await captureAuthorityBaseline(
      git({ status: () => ({ stdout: "", stderr: "fatal: not a git repository", code: 128 }) }),
      "/repo",
    );
    expect(baseline.valid).toBe(false);
    expect(baseline.invalidReason).toBe(
      "git status failed (128): fatal: not a git repository",
    );

    const brokenHead = await captureAuthorityBaseline(
      git({ "rev-parse:HEAD": () => ({ stdout: "", stderr: "fatal: bad revision", code: 128 }) }),
      "/repo",
    );
    expect(brokenHead.valid).toBe(false);
    expect(brokenHead.invalidReason).toContain("git rev-parse HEAD failed (128)");

    const audit = await auditAuthority(
      git(),
      "/repo",
      { mode: "read_only", allowedPaths: [] },
      baseline,
    );
    expect(audit.ok).toBe(false);
    expect(audit.violations).toEqual([
      "authority baseline invalid: git status failed (128): fatal: not a git repository",
    ]);
  });

  it("fails closed with a diagnostic when git status fails during audit", async () => {
    const result = await auditAuthority(
      git({ status: () => ({ stdout: "", stderr: "fatal: not a git repository", code: 128 }) }),
      "/repo",
      { mode: "controlled_mutation", allowedPaths: [] },
      {
        capturedAt: "now",
        valid: true,
        gitRoot: "/repo",
        head: "abc",
        statusLines: [],
        pathEvidence: {},
      },
    );
    expect(result.ok).toBe(false);
    expect(result.violations).toEqual([
      "git status failed (128): fatal: not a git repository",
    ]);
  });

  it("rejects a missing baseline fail-closed", async () => {
    const result = await auditAuthority(
      git(),
      "/repo",
      { mode: "read_only", allowedPaths: [] },
      undefined,
    );
    expect(result.ok).toBe(false);
    expect(result.violations).toEqual(["authority baseline invalid: missing baseline"]);
  });

  it("rejects a legacy baseline without the explicit valid marker", async () => {
    const result = await auditAuthority(
      git(),
      "/repo",
      { mode: "read_only", allowedPaths: [] },
      { capturedAt: "now", gitRoot: "/repo", statusLines: [] },
    );
    expect(result.ok).toBe(false);
    expect(result.violations).toEqual([
      "authority baseline invalid: baseline not explicitly marked valid",
    ]);
  });

  it("rejects an incomplete baseline missing required contract fields", async () => {
    const result = await auditAuthority(
      git(),
      "/repo",
      { mode: "read_only", allowedPaths: [] },
      {
        capturedAt: "now",
        valid: true,
        gitRoot: "/repo",
        statusLines: [],
        pathEvidence: {},
      },
    );
    expect(result.ok).toBe(false);
    expect(result.violations).toEqual(["authority baseline invalid: missing head"]);
  });

  it("accepts a new fully valid baseline when nothing changed", async () => {
    const result = await auditAuthority(
      git({ "rev-parse:HEAD": () => ok("abc\n") }),
      "/repo",
      { mode: "read_only", allowedPaths: [] },
      {
        capturedAt: "now",
        valid: true,
        gitRoot: "/repo",
        head: "abc",
        statusLines: [],
        pathEvidence: {},
      },
    );
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("fails closed when diff evidence collection fails during audit", async () => {
    let diffCode = 0;
    const gitRunner = git({
      status: () => ok(" M src/a.ts\0"),
      diff: () => ({
        stdout: "",
        stderr: diffCode === 0 ? "" : "fatal: repository corruption",
        code: diffCode,
      }),
      "rev-parse:HEAD": () => ok("abc\n"),
      "rev-parse:--show-toplevel": () => ok("/repo\n"),
    });
    const baseline = await captureAuthorityBaseline(gitRunner, "/repo");
    diffCode = 128;

    const result = await auditAuthority(
      gitRunner,
      "/repo",
      { mode: "read_only", allowedPaths: [] },
      baseline,
    );

    expect(result.ok).toBe(false);
    expect(result.violations).toEqual([
      "git diff --binary -- src/a.ts failed (128): fatal: repository corruption",
    ]);
  });

  it("fails closed when hash-object fails during baseline capture", async () => {
    const baseline = await captureAuthorityBaseline(
      git({
        status: () => ok("?? new.txt\0"),
        "hash-object": () => ({
          stdout: "",
          stderr: "fatal: could not open 'new.txt' for reading",
          code: 128,
        }),
        "rev-parse:HEAD": () => ok("abc\n"),
        "rev-parse:--show-toplevel": () => ok("/repo\n"),
      }),
      "/repo",
    );
    expect(baseline.valid).toBe(false);
    expect(baseline.invalidReason).toContain(
      "git hash-object --no-filters -- new.txt failed (128)",
    );
  });

  it("fails when a change followed by a commit restores the status but moves HEAD", async () => {
    let status = " M src/a.ts\0";
    let head = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
    const gitRunner = git({
      status: () => ok(status),
      diff: () => ok("worktree diff"),
      "rev-parse:HEAD": () => ok(`${head}\n`),
      "rev-parse:--show-toplevel": () => ok("/repo\n"),
    });
    const baseline = await captureAuthorityBaseline(gitRunner, "/repo");
    status = "";
    head = "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2";

    const result = await auditAuthority(
      gitRunner,
      "/repo",
      { mode: "read_only", allowedPaths: [] },
      baseline,
    );

    expect(result.ok).toBe(false);
    expect(result.violations).toContain(
      "delegation changed git HEAD (a1a1a1a1a1a1..b2b2b2b2b2b2)",
    );
  });

  it("enforces forbiddenPaths on filenames containing ' -> '", async () => {
    const result = await auditAuthority(
      git({
        status: () => ok("R  renamed -> dest.txt\0has -> arrow.txt\0"),
        "rev-parse:HEAD": () => ok("abc\n"),
      }),
      "/repo",
      {
        mode: "controlled_mutation",
        allowedPaths: [],
        forbiddenPaths: ["renamed -> dest.txt"],
      },
      {
        capturedAt: "now",
        valid: true,
        gitRoot: "/repo",
        head: "abc",
        statusLines: [],
        pathEvidence: {},
      },
    );
    expect(result.ok).toBe(false);
    expect(result.evidence.changedPaths).toEqual([
      "renamed -> dest.txt",
      "has -> arrow.txt",
    ]);
    expect(result.violations).toEqual(["changed forbidden path: renamed -> dest.txt"]);
  });

  it("preserves allowed and forbidden path contracts for later dirty-path changes", async () => {
    let diffs: Record<string, string> = {
      "src/allowed.ts": "allowed baseline",
      "src/forbidden.ts": "forbidden baseline",
    };
    const gitRunner = git({
      status: () => ok(" M src/allowed.ts\0 M src/forbidden.ts\0"),
      diff: (args) => ok(diffs[args.at(-1) ?? ""] ?? ""),
      "rev-parse:HEAD": () => ok("abc\n"),
      "rev-parse:--show-toplevel": () => ok("/repo\n"),
    });
    const baseline = await captureAuthorityBaseline(gitRunner, "/repo");
    diffs = { "src/allowed.ts": "allowed later", "src/forbidden.ts": "forbidden later" };

    const result = await auditAuthority(
      gitRunner,
      "/repo",
      {
        mode: "controlled_mutation",
        allowedPaths: ["src"],
        forbiddenPaths: ["src/forbidden.ts"],
      },
      baseline,
    );

    expect(result.violations).toEqual(["changed forbidden path: src/forbidden.ts"]);
  });
});

describe("real git fixtures", () => {
  const execGit = promisify(execFile);
  const realGit: CommandRunner = {
    async run(_command, args, cwd) {
      try {
        const { stdout } = await execGit("git", args, { cwd });
        return { stdout, stderr: "", code: 0 };
      } catch (error) {
        const failure = error as { code?: unknown; stderr?: unknown; stdout?: unknown };
        return {
          stdout: typeof failure.stdout === "string" ? failure.stdout : "",
          stderr: typeof failure.stderr === "string" ? failure.stderr : "",
          code: typeof failure.code === "number" ? failure.code : 1,
        };
      }
    },
  };
  const tempDirs: string[] = [];
  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("parses real -z status with ' -> ' names and fails when the delegation commits", async () => {
    const dir = await mkdtemp(join(tmpdir(), "holistic-authority-"));
    tempDirs.push(dir);
    await realGit.run("git", ["init", "-q"], dir);
    await realGit.run("git", ["config", "user.email", "authority@test"], dir);
    await realGit.run("git", ["config", "user.name", "authority"], dir);
    await writeFile(join(dir, "tracked.txt"), "base\n");
    await realGit.run("git", ["add", "."], dir);
    await realGit.run("git", ["commit", "-qm", "init"], dir);
    const baseline = await captureAuthorityBaseline(realGit, dir);
    expect(baseline.valid).toBe(true);
    expect(baseline.gitRoot).toBe(dir);
    expect(typeof baseline.head).toBe("string");
    expect(baseline.head).not.toBe("");

    // Delegation effects: staged rename to a " -> " destination plus an
    // untracked file whose name also contains the literal " -> ".
    await realGit.run("git", ["mv", "tracked.txt", "renamed -> dest.txt"], dir);
    await writeFile(join(dir, "has -> arrow.txt"), "untracked\n");

    const dirtyBaseline = await captureAuthorityBaseline(realGit, dir);
    expect(dirtyBaseline.valid).toBe(true);
    expect(dirtyBaseline.statusLines).toContain(
      "R  renamed -> dest.txt\u0000tracked.txt",
    );
    expect(dirtyBaseline.statusLines).toContain("?? has -> arrow.txt");
    expect(Object.keys(dirtyBaseline.pathEvidence ?? {})).toEqual(
      expect.arrayContaining(["renamed -> dest.txt", "has -> arrow.txt"]),
    );

    const audit = await auditAuthority(
      realGit,
      dir,
      {
        mode: "controlled_mutation",
        allowedPaths: [],
        forbiddenPaths: ["renamed -> dest.txt"],
      },
      baseline,
    );
    expect(audit.ok).toBe(false);
    expect([...(audit.evidence.changedPaths ?? [])].sort()).toEqual([
      "has -> arrow.txt",
      "renamed -> dest.txt",
      "tracked.txt",
    ]);
    expect(audit.violations).toEqual(["changed forbidden path: renamed -> dest.txt"]);

    // Committing restores a clean status but moves HEAD: the audit fails.
    await realGit.run("git", ["add", "-A"], dir);
    await realGit.run("git", ["commit", "-qm", "delegation work"], dir);
    const afterCommit = await auditAuthority(
      realGit,
      dir,
      { mode: "read_only", allowedPaths: [] },
      baseline,
    );
    expect(afterCommit.ok).toBe(false);
    expect(
      afterCommit.violations.some((violation) =>
        violation.startsWith("delegation changed git HEAD"),
      ),
    ).toBe(true);
  });
});
