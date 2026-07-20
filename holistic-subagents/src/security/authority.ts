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

export function coordinatorEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.HERDR_ENV === "1" && !env.HOLISTIC_SUBAGENT_DEPTH;
}

export function assertAuthorityPreconditions(
  authority: AuthorityPolicy,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (authority.mode === "read_only" && authority.requireExternalSandbox) {
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
    runner.run("git", ["status", "--porcelain=v1", "-uall"], cwd),
  ]);
  if (root.code !== 0) return { capturedAt: now, statusLines: [] };
  return {
    capturedAt: now,
    gitRoot: root.stdout.trim(),
    head: head.code === 0 ? head.stdout.trim() : undefined,
    statusLines: nonEmptyLines(status.stdout),
  };
}

export async function auditAuthority(
  runner: CommandRunner,
  cwd: string,
  authority: AuthorityPolicy,
  baseline: AuthorityBaseline,
  now = new Date().toISOString(),
): Promise<AuthorityAudit> {
  const status = await runner.run("git", ["status", "--porcelain=v1", "-uall"], cwd);
  const current = nonEmptyLines(status.stdout);
  const baselineSet = new Set(baseline.statusLines);
  const newLines = current.filter((line) => !baselineSet.has(line));
  const changedPaths = newLines.flatMap(pathsFromStatusLine);
  const violations: string[] = [];

  if (authority.mode === "read_only" && newLines.length > 0) {
    violations.push(`read_only delegation changed: ${changedPaths.join(", ")}`);
  }
  if (authority.mode !== "read_only" && authority.allowedPaths.length > 0) {
    for (const path of changedPaths) {
      if (!isAllowed(path, authority.allowedPaths, cwd, baseline.gitRoot ?? cwd)) {
        violations.push(`changed path outside authority: ${path}`);
      }
    }
  }
  for (const path of changedPaths) {
    if (isForbidden(path, authority.forbiddenPaths ?? [], cwd, baseline.gitRoot ?? cwd)) {
      violations.push(`changed forbidden path: ${path}`);
    }
  }

  return {
    ok: violations.length === 0,
    violations,
    evidence: {
      capturedAt: now,
      gitStatus: status.stdout.trim(),
      changedPaths: [...new Set(changedPaths)],
    },
  };
}

function nonEmptyLines(value: string): string[] {
  return value.split(/\r?\n/).filter(Boolean);
}

export function pathsFromStatusLine(line: string): string[] {
  const payload = line.length > 3 ? line.slice(3).trim() : "";
  if (!payload) return [];
  const parts = payload.split(" -> ");
  return parts.map(unquoteGitPath);
}

function unquoteGitPath(path: string): string {
  if (path.startsWith('"') && path.endsWith('"')) {
    try {
      return JSON.parse(path) as string;
    } catch {
      return path.slice(1, -1);
    }
  }
  return path;
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
