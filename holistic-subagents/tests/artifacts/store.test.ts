import { chmod, lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ArtifactStore, type ArtifactRoot } from "../../src/artifacts/store.ts";
import { sha256HexOf, type ArtifactRef } from "../../src/protocol/handoff.ts";

let base: string;
let store: ArtifactStore;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "artifact-store-test-"));
  store = new ArtifactStore({ baseDir: base });
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

function mode(path: string): Promise<number> {
  return lstat(path).then((stat) => stat.mode & 0o777);
}

async function publish(root: ArtifactRoot, data = "content", id = "artifact-1") {
  return store.put(root.id, {
    runId: "run-1",
    cycleId: "cycle-1",
    mediaType: "text/plain",
    data,
    id,
  });
}

describe("ArtifactStore", () => {
  it("publishes atomically under private 0700/0600 Run-cycle paths", async () => {
    const root = await store.createRoot("session");
    const ref = await publish(root);
    const dir = join(root.path, "run-1", "cycle-1");

    expect(await mode(root.path)).toBe(0o700);
    expect(await mode(join(root.path, "run-1"))).toBe(0o700);
    expect(await mode(dir)).toBe(0o700);
    expect(await mode(join(dir, ref.id))).toBe(0o600);
    expect(await readdir(dir)).toEqual([ref.id]);
    await expect(store.get(root.id, ref.id)).resolves.toMatchObject({ ref });
  });

  it("registers a persisted root and verifies child-published files after reload", async () => {
    const root = await store.createRoot("session");
    const dir = join(root.path, "run-1", "cycle-1");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(join(root.path, "run-1"), 0o700);
    await chmod(dir, 0o700);
    const data = Buffer.from("external");
    await writeFile(join(dir, "artifact-1"), data, { mode: 0o600 });
    const reloaded = new ArtifactStore({ baseDir: base });
    await reloaded.registerRoot(root.id, root.path);
    const ref: ArtifactRef = {
      id: "artifact-1",
      rootId: root.id,
      mediaType: "text/plain",
      size: data.length,
      sha256: sha256HexOf(data),
    };

    await expect(reloaded.verify(ref, { runId: "run-1", cycleId: "cycle-1" }))
      .resolves.toMatchObject({ ref, data });
  });

  it("rejects unregistered roots and traversal in root, Run, cycle or artifact ids", async () => {
    const root = await store.createRoot();
    await expect(store.put("unknown", {
      runId: "run", cycleId: "cycle", mediaType: "text/plain", data: "x",
    })).rejects.toMatchObject({ code: "UNREGISTERED_ROOT" });
    for (const input of [
      { runId: "../run", cycleId: "cycle", id: "file" },
      { runId: "run", cycleId: "../cycle", id: "file" },
      { runId: "run", cycleId: "cycle", id: "../file" },
    ]) {
      await expect(store.put(root.id, {
        ...input,
        mediaType: "text/plain",
        data: "x",
      })).rejects.toBeInstanceOf(Error);
    }
    await expect(store.registerRoot("outside", "relative/path"))
      .rejects.toMatchObject({ code: "CONTAINMENT_VIOLATION" });
  });

  it("rejects symlinked files and path components", async () => {
    const root = await store.createRoot();
    const ref = await publish(root);
    const target = join(root.path, "run-1", "cycle-1", ref.id);
    const outside = join(base, "outside");
    await writeFile(outside, "content");
    await rm(target);
    await symlink(outside, target);
    await expect(store.get(root.id, ref.id)).rejects.toMatchObject({ code: "SYMLINK_NOT_ALLOWED" });
  });

  it("rejects ownership and permission divergence", async () => {
    const root = await store.createRoot();
    const foreign = new ArtifactStore({ baseDir: base, currentUid: 424_242 });
    await expect(foreign.registerRoot(root.id, root.path))
      .rejects.toMatchObject({ code: "OWNERSHIP_MISMATCH" });

    const ref = await publish(root);
    await chmod(join(root.path, "run-1", "cycle-1", ref.id), 0o644);
    await expect(store.get(root.id, ref.id)).rejects.toMatchObject({ code: "PERMISSIONS_MISMATCH" });
    await chmod(join(root.path, "run-1", "cycle-1", ref.id), 0o600);
    await chmod(root.path, 0o755);
    await expect(store.get(root.id, ref.id)).rejects.toMatchObject({ code: "PERMISSIONS_MISMATCH" });
  });

  it("detects partial, resized and hash-divergent files", async () => {
    const root = await store.createRoot();
    const ref = await publish(root, "original");
    const path = join(root.path, "run-1", "cycle-1", ref.id);
    await writeFile(path, "changed!", { mode: 0o600 });
    await expect(store.get(root.id, ref.id)).rejects.toMatchObject({ code: "HASH_MISMATCH" });
    await writeFile(path, "short", { mode: 0o600 });
    await expect(store.get(root.id, ref.id)).rejects.toMatchObject({ code: "SIZE_MISMATCH" });
  });

  it("enforces media type, per-file and total-root limits", async () => {
    const limited = new ArtifactStore({
      baseDir: base,
      limits: { maxFileSizeBytes: 8, maxRootBytes: 10 },
    });
    const root = await limited.createRoot();
    await expect(limited.put(root.id, {
      runId: "run", cycleId: "cycle", mediaType: "text/html", data: "x",
    })).rejects.toMatchObject({ code: "INVALID_MEDIA_TYPE" });
    await expect(limited.put(root.id, {
      runId: "run", cycleId: "cycle", mediaType: "text/plain", data: "123456789",
    })).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    await limited.put(root.id, {
      runId: "run", cycleId: "one", mediaType: "text/plain", data: "12345678",
    });
    await expect(limited.put(root.id, {
      runId: "run", cycleId: "two", mediaType: "text/plain", data: "123",
    })).rejects.toMatchObject({ code: "ROOT_LIMIT_EXCEEDED" });
  });

  it("cleans temporary roots idempotently even when artifacts already vanished", async () => {
    const root = await store.createRoot();
    await publish(root);
    await rm(join(root.path, "run-1"), { recursive: true });
    await store.removeRoot(root.id);
    await expect(store.removeRoot(root.id)).resolves.toBeUndefined();
    await expect(lstat(root.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("unregisters durable roots without deleting their files", async () => {
    const path = join(base, "durable");
    await mkdir(path);
    await writeFile(join(path, "kept.txt"), "keep");
    await store.registerRoot("durable-root", path, { durable: true });
    await store.removeRoot("durable-root");
    expect(await readdir(path)).toEqual(["kept.txt"]);
    expect(store.root("durable-root")).toBeUndefined();
  });
});
