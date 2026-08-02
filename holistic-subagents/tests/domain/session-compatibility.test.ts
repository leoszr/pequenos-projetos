import { describe, expect, it } from "vitest";

import {
  authorityContained,
  sessionEnvironmentCompatible,
} from "../../src/domain/service.ts";
import type {
  AgentSession,
  AuthorityPolicy,
  DelegationRequest,
} from "../../src/domain/types.ts";

const readOnly: AuthorityPolicy = { mode: "read_only", allowedPaths: [] };
const controlledWide: AuthorityPolicy = {
  mode: "controlled_mutation",
  allowedPaths: [],
};
const controlledSrc: AuthorityPolicy = {
  mode: "controlled_mutation",
  allowedPaths: ["src"],
};
const isolated: AuthorityPolicy = {
  mode: "isolated_mutation",
  allowedPaths: [],
};

describe("Agent Session authority containment", () => {
  it("uses mode semantics instead of an authority rank", () => {
    expect(authorityContained(readOnly, controlledSrc, "/repo", "/repo")).toBe(true);
    expect(authorityContained(readOnly, isolated, "/repo", "/repo")).toBe(true);
    expect(authorityContained(controlledWide, isolated, "/repo", "/repo")).toBe(false);
    expect(authorityContained(isolated, controlledWide, "/repo", "/repo")).toBe(false);
    expect(authorityContained(controlledSrc, controlledWide, "/repo", "/repo")).toBe(true);
  });

  it("treats an empty mutation allowlist as workspace-wide", () => {
    expect(authorityContained(controlledSrc, controlledWide, "/repo", "/repo")).toBe(true);
    expect(authorityContained(controlledWide, controlledSrc, "/repo", "/repo")).toBe(false);
  });

  it("canonicalizes relative and absolute allowlists", () => {
    expect(authorityContained(
      { mode: "controlled_mutation", allowedPaths: ["../src/domain"] },
      { mode: "controlled_mutation", allowedPaths: ["/repo/src"] },
      "/repo/packages",
      "/repo",
    )).toBe(true);
    expect(authorityContained(
      { mode: "controlled_mutation", allowedPaths: ["..foo"] },
      { mode: "controlled_mutation", allowedPaths: ["/repo"] },
      "/repo",
      "/repo",
    )).toBe(true);
  });

  it("requires every ceiling prohibition to be inherited by the Run", () => {
    const ceiling: AuthorityPolicy = {
      mode: "controlled_mutation",
      allowedPaths: [],
      forbiddenPaths: ["package.json"],
    };
    expect(authorityContained(controlledSrc, ceiling, "/repo", "/repo")).toBe(false);
    expect(authorityContained(
      { ...controlledSrc, forbiddenPaths: ["package.json"] },
      ceiling,
      "/repo",
      "/repo",
    )).toBe(true);
    expect(authorityContained(
      { mode: "controlled_mutation", allowedPaths: ["package.json"], forbiddenPaths: ["package.json"] },
      ceiling,
      "/repo",
      "/repo",
    )).toBe(true);
  });

  it("requires an external sandbox guarantee when the Run requests it", () => {
    expect(authorityContained(
      { ...readOnly, requireExternalSandbox: true },
      readOnly,
      "/repo",
      "/repo",
    )).toBe(false);
    expect(authorityContained(
      readOnly,
      { ...readOnly, requireExternalSandbox: true },
      "/repo",
      "/repo",
    )).toBe(true);
  });
});

describe("Agent Session physical environment compatibility", () => {
  const request: DelegationRequest = {
    name: "task",
    mission: "mission",
    cwd: "/repo",
    authority: readOnly,
    acceptanceEvidence: [],
    topology: "worktree",
    baseRef: "main",
    branch: "agent/task",
    model: { minimumCapability: "bounded" },
  };
  const session: AgentSession = {
    version: 2,
    id: "as1",
    ownershipId: "as1",
    parentSessionId: "parent",
    parentPaneId: "pane",
    state: "idle",
    trustScope: "/repo",
    authorityCeiling: readOnly,
    modelResolution: {
      model: "p/m", provider: "p", family: "f", thinking: "low",
      requestedCapability: "bounded", providedCapability: "bounded",
      degradedCapability: false, exactThinking: true, alternatives: [], reason: "test",
      requestedEffort: "low", effectiveEffort: "low", purpose: "execution",
    },
    topology: "worktree",
    cwd: "/repo",
    resources: [],
    callbackToken: "token",
    createdAt: "now",
    updatedAt: "now",
    lastUsedAt: "now",
  };

  it("requires exact cwd/topology and defers worktree reuse", () => {
    expect(sessionEnvironmentCompatible(session, request, "/repo")).toBe(false);
    expect(sessionEnvironmentCompatible(session, { ...request, cwd: "/repo/pkg" }, "/repo")).toBe(false);
    expect(sessionEnvironmentCompatible(session, { ...request, topology: "pane" }, "/repo")).toBe(false);
    expect(sessionEnvironmentCompatible(session, { ...request, baseRef: "release" }, "/repo")).toBe(false);
    expect(sessionEnvironmentCompatible(session, { ...request, branch: "agent/other" }, "/repo")).toBe(false);
  });
});
