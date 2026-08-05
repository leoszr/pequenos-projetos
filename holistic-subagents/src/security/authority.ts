import { isAbsolute, relative, resolve, sep } from "node:path";

import type {
  AuthorityBaseline,
  AuthorityPolicy,
  DelegationEvidence,
} from "../domain/types.ts";

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface CommandRunner {
  run(command: string, args: string[], cwd: string): Promise<CommandResult>;
}

export interface AuthorityAudit {
  ok: boolean;
  evidence: DelegationEvidence;
  violations: string[];
}

/**
 * Porcelain v1 with -z: fields are NUL-separated, paths are never C-quoted and
 * rename/copy entries span two fields (destination first, then source). This
 * keeps filenames containing " -> ", spaces or quotes as single paths.
 */
const STATUS_ARGS = ["status", "--porcelain=v1", "-z", "-uall"] as const;

export function coordinatorEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.HERDR_ENV === "1" && !env.HOLISTIC_SUBAGENT_DEPTH;
}

export function assertAuthorityPreconditions(
  authority: AuthorityPolicy,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (authority.requireExternalSandbox) {
    if (env.HOLISTIC_READONLY_SANDBOX !== "1") {
      throw new Error("read_only delegation requires an external filesystem sandbox");
    }
  }
}

export async function captureAuthorityBaseline(
  runner: CommandRunner,
  cwd: string,
  now = new Date().toISOString(),
): Promise<AuthorityBaseline> {
  const [root, head, status] = await Promise.all([
    runner.run("git", ["rev-parse", "--show-toplevel"], cwd),
    runner.run("git", ["rev-parse", "HEAD"], cwd),
    runner.run("git", [...STATUS_ARGS], cwd),
  ]);
  const checks: Array<[label: string, result: CommandResult]> = [
    ["git rev-parse --show-toplevel", root],
    ["git rev-parse HEAD", head],
    ["git status", status],
  ];
  const failure = checks.find(([, result]) => result.code !== 0);
  if (failure) {
    return invalidBaseline(now, `${failure[0]} failed (${failure[1].code}): ${diagnostic(failure[1])}`);
  }
  const entries = parseStatusEntries(status.stdout);
  const evidence = await collectPathEvidence(runner, root.stdout.trim(), entries);
  if (!evidence.ok) return invalidBaseline(now, evidence.diagnostic);
  return {
    capturedAt: now,
    valid: true,
    gitRoot: root.stdout.trim(),
    head: head.stdout.trim(),
    statusLines: entries.map((entry) => entry.join("\0")),
    pathEvidence: evidence.evidence,
  };
}

/**
 * A baseline is only trustworthy when it is explicitly valid:true AND carries
 * every field of the contract (gitRoot, head, statusLines, pathEvidence).
 * Missing, legacy or incomplete baselines are rejected fail-closed here; a
 * never-captured baseline (undefined) is a violation, not a clean state.
 */
export async function auditAuthority(
  runner: CommandRunner,
  cwd: string,
  authority: AuthorityPolicy,
  baseline: AuthorityBaseline | undefined,
  now = new Date().toISOString(),
): Promise<AuthorityAudit> {
  if (!baseline) return baselineRejected("missing baseline", now);
  if (baseline.valid !== true) {
    return baselineRejected(
      baseline.invalidReason ?? "baseline not explicitly marked valid",
      now,
    );
  }
  if (typeof baseline.gitRoot !== "string" || baseline.gitRoot === "") {
    return baselineRejected("missing gitRoot", now);
  }
  if (typeof baseline.head !== "string" || baseline.head === "") {
    return baselineRejected("missing head", now);
  }
  if (!Array.isArray(baseline.statusLines)) {
    return baselineRejected("missing statusLines", now);
  }
  if (!baseline.pathEvidence || typeof baseline.pathEvidence !== "object") {
    return baselineRejected("missing pathEvidence", now);
  }
  const baselinePathEvidence = baseline.pathEvidence;
  const [status, head] = await Promise.all([
    runner.run("git", [...STATUS_ARGS], cwd),
    runner.run("git", ["rev-parse", "HEAD"], cwd),
  ]);
  if (status.code !== 0) {
    return {
      ok: false,
      violations: [`git status failed (${status.code}): ${diagnostic(status)}`],
      evidence: { capturedAt: now, gitStatus: status.stdout.trim(), changedPaths: [] },
    };
  }
  if (head.code !== 0) {
    return {
      ok: false,
      violations: [`git rev-parse HEAD failed (${head.code}): ${diagnostic(head)}`],
      evidence: { capturedAt: now, gitStatus: status.stdout.trim(), changedPaths: [] },
    };
  }
  const currentEntries = parseStatusEntries(status.stdout);
  const currentEvidence = await collectPathEvidence(
    runner,
    baseline.gitRoot,
    currentEntries,
  );
  if (!currentEvidence.ok) {
    return {
      ok: false,
      violations: [currentEvidence.diagnostic],
      evidence: { capturedAt: now, gitStatus: status.stdout.trim(), changedPaths: [] },
    };
  }
  const currentSet = new Set(currentEntries.map((entry) => entry.join("\0")));
  const baselineSet = new Set(baseline.statusLines);
  const changedStatusLines = [
    ...currentEntries.filter((entry) => !baselineSet.has(entry.join("\0"))).map((entry) => entry.join("\0")),
    ...baseline.statusLines.filter((line) => !currentSet.has(line)),
  ];
  const evidenceChangedPaths = Object.keys(currentEvidence.evidence).filter(
    (path) =>
      baselinePathEvidence[path] !== undefined &&
      baselinePathEvidence[path] !== currentEvidence.evidence[path],
  );
  const changedPaths = [
    ...new Set([
      ...changedStatusLines.flatMap(pathsFromEntryString),
      ...evidenceChangedPaths,
    ]),
  ];
  const violations: string[] = [];

  if (head.stdout.trim() !== baseline.head) {
    violations.push(
      `delegation changed git HEAD (${shortSha(baseline.head)}..${shortSha(head.stdout.trim())})`,
    );
  }
  if (authority.mode === "read_only" && changedPaths.length > 0) {
    violations.push(`read_only delegation changed: ${changedPaths.join(", ")}`);
  }
  if (authority.mode !== "read_only" && authority.allowedPaths.length > 0) {
    for (const path of changedPaths) {
      if (!isAllowed(path, authority.allowedPaths, cwd, baseline.gitRoot)) {
        violations.push(`changed path outside authority: ${path}`);
      }
    }
  }
  for (const path of changedPaths) {
    if (isForbidden(path, authority.forbiddenPaths ?? [], cwd, baseline.gitRoot)) {
      violations.push(`changed forbidden path: ${path}`);
    }
  }

  return {
    ok: violations.length === 0,
    violations,
    evidence: {
      capturedAt: now,
      gitStatus: status.stdout.trim(),
      changedPaths,
    },
  };
}

function baselineRejected(reason: string, now: string): AuthorityAudit {
  return {
    ok: false,
    violations: [`authority baseline invalid: ${reason}`],
    evidence: { capturedAt: now, gitStatus: "", changedPaths: [] },
  };
}

/**
 * Splits porcelain v1 -z output into entries. A rename/copy entry ("R"/"C")
 * consumes the next NUL field as its source path; every other entry is a
 * single field. The trailing NUL produces an empty chunk that is dropped.
 */
export function parseStatusEntries(stdout: string): string[][] {
  const chunks = stdout.split("\0");
  if (chunks.at(-1) === "") chunks.pop();
  const entries: string[][] = [];
  for (let index = 0; index < chunks.length; index++) {
    const entry = [chunks[index]];
    if (
      (chunks[index].startsWith("R") || chunks[index].startsWith("C"))
      && index + 1 < chunks.length
    ) {
      entry.push(chunks[++index]);
    }
    entries.push(entry);
  }
  return entries;
}

/** Extracts real paths from an entry: field 0 carries the "XY " prefix. */
export function pathsFromEntry(entry: string[]): string[] {
  return entry
    .map((field, index) => (index === 0 ? field.slice(3) : field))
    .filter(Boolean);
}

function pathsFromEntryString(entry: string): string[] {
  return pathsFromEntry(entry.split("\0"));
}

function shortSha(sha: string): string {
  return sha.length > 12 ? sha.slice(0, 12) : sha;
}

interface EvidenceOutcome {
  ok: boolean;
  evidence: Record<string, string>;
  diagnostic: string;
}

/**
 * Per-path evidence: tracked paths are characterized by the unstaged and
 * staged diffs (byte-exact), untracked paths by their worktree blob hash.
 * Every git command must succeed; any code != 0 fails closed instead of
 * serializing error/empty output as valid evidence.
 */
async function collectPathEvidence(
  runner: CommandRunner,
  cwd: string,
  entries: string[][],
): Promise<EvidenceOutcome> {
  const paths = [...new Set(entries.flatMap(pathsFromEntry))];
  const untracked = new Set(
    entries
      .filter((entry) => entry[0]?.startsWith("?? "))
      .flatMap(pathsFromEntry),
  );
  const evidence: Record<string, string> = {};
  for (const path of paths) {
    const commands = untracked.has(path)
      ? [["hash-object", "--no-filters", "--", path]]
      : [["diff", "--binary", "--", path], ["diff", "--binary", "--cached", "--", path]];
    const results = await Promise.all(
      commands.map((command) => runner.run("git", command, cwd)),
    );
    const failed = results.findIndex((result) => result.code !== 0);
    if (failed !== -1) {
      return {
        ok: false,
        evidence: {},
        diagnostic: `git ${commands[failed].join(" ")} failed (${results[failed].code}): ${diagnostic(results[failed])}`,
      };
    }
    evidence[path] = untracked.has(path)
      ? JSON.stringify({ content: results[0].stdout })
      : JSON.stringify({ unstaged: results[0].stdout, staged: results[1].stdout });
  }
  return { ok: true, evidence, diagnostic: "" };
}

function invalidBaseline(capturedAt: string, invalidReason: string): AuthorityBaseline {
  return { capturedAt, statusLines: [], valid: false, invalidReason };
}

function diagnostic(result: CommandResult): string {
  return result.stderr.trim() || result.stdout.trim() || "no diagnostic";
}

function isAllowed(path: string, allowed: string[], cwd: string, root: string): boolean {
  const target = resolve(root, path);
  return allowed.some((entry) => contains(resolveBoundary(entry, cwd), target));
}

function isForbidden(path: string, forbidden: string[], cwd: string, root: string): boolean {
  const target = resolve(root, path);
  return forbidden.some((entry) => contains(resolveBoundary(entry, cwd), target));
}

function resolveBoundary(entry: string, cwd: string): string {
  return resolve(isAbsolute(entry) ? entry : cwd, isAbsolute(entry) ? "." : entry);
}

function contains(boundary: string, target: string): boolean {
  const delta = relative(boundary, target);
  return delta === "" || (!delta.startsWith(".." + sep) && delta !== "..");
}
