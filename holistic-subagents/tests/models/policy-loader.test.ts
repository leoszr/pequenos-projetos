import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  MODEL_POLICY_RELATIVE_PATH,
  ModelPolicyError,
  loadEffectiveModelPolicy,
} from "../../src/models/policy.ts";

const roots: string[] = [];
const defaultUrl = new URL("../../src/models/default-policy.json", import.meta.url);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "holistic-policy-"));
  roots.push(root);
  return { root, cwd: join(root, "project"), global: join(root, "global") };
}

async function put(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

describe("effective model policy loading", () => {
  it("creates the editable global policy once when no config exists", async () => {
    const value = await fixture();
    const loaded = await loadEffectiveModelPolicy({
      cwd: value.cwd,
      projectTrusted: true,
      projectConfigDirName: ".pi",
      globalConfigDir: value.global,
      defaultPolicyUrl: defaultUrl,
    });

    expect(loaded).toMatchObject({ scope: "global", created: true });
    expect(loaded.path).toBe(join(value.global, MODEL_POLICY_RELATIVE_PATH));
    expect(JSON.parse(await readFile(loaded.path, "utf8"))).toMatchObject({ version: 1 });
  });

  it("uses a trusted project policy as an integral replacement", async () => {
    const value = await fixture();
    const raw = await readFile(defaultUrl, "utf8");
    const projectPolicy = JSON.parse(raw);
    projectPolicy.defaultEffort.bounded = "max";
    const globalPath = join(value.global, MODEL_POLICY_RELATIVE_PATH);
    const projectPath = join(value.cwd, ".pi", MODEL_POLICY_RELATIVE_PATH);
    await put(globalPath, raw);
    await put(projectPath, JSON.stringify(projectPolicy));

    const loaded = await loadEffectiveModelPolicy({
      cwd: value.cwd,
      projectTrusted: true,
      projectConfigDirName: ".pi",
      globalConfigDir: value.global,
      defaultPolicyUrl: defaultUrl,
    });

    expect(loaded).toMatchObject({ path: projectPath, scope: "project", created: false });
    expect(loaded.policy.defaultEffort.bounded).toBe("max");
  });

  it("never overwrites an existing global policy", async () => {
    const value = await fixture();
    const raw = await readFile(defaultUrl, "utf8");
    const custom = JSON.parse(raw);
    custom.defaultEffort.bounded = "max";
    const globalPath = join(value.global, MODEL_POLICY_RELATIVE_PATH);
    await put(globalPath, JSON.stringify(custom));

    const loaded = await loadEffectiveModelPolicy({
      cwd: value.cwd,
      projectTrusted: true,
      projectConfigDirName: ".pi",
      globalConfigDir: value.global,
      defaultPolicyUrl: defaultUrl,
    });

    expect(loaded.created).toBe(false);
    expect(loaded.policy.defaultEffort.bounded).toBe("max");
  });

  it("ignores an untrusted project policy", async () => {
    const value = await fixture();
    const raw = await readFile(defaultUrl, "utf8");
    const globalPath = join(value.global, MODEL_POLICY_RELATIVE_PATH);
    await put(globalPath, raw);
    await put(join(value.cwd, ".pi", MODEL_POLICY_RELATIVE_PATH), "not json");

    const loaded = await loadEffectiveModelPolicy({
      cwd: value.cwd,
      projectTrusted: false,
      projectConfigDirName: ".pi",
      globalConfigDir: value.global,
      defaultPolicyUrl: defaultUrl,
    });
    expect(loaded.path).toBe(globalPath);
  });

  it("fails explicitly instead of falling back from an invalid project policy", async () => {
    const value = await fixture();
    const raw = await readFile(defaultUrl, "utf8");
    await put(join(value.global, MODEL_POLICY_RELATIVE_PATH), raw);
    const projectPath = join(value.cwd, ".pi", MODEL_POLICY_RELATIVE_PATH);
    await put(projectPath, "{ invalid");

    await expect(loadEffectiveModelPolicy({
      cwd: value.cwd,
      projectTrusted: true,
      projectConfigDirName: ".pi",
      globalConfigDir: value.global,
      defaultPolicyUrl: defaultUrl,
    })).rejects.toBeInstanceOf(ModelPolicyError);
  });
});
