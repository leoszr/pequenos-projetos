import { randomBytes, timingSafeEqual } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, realpath, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  OPAQUE_ID_PATTERN,
  assertArtifactRef,
  sha256HexOf,
  type ArtifactRef,
} from "../protocol/handoff.ts";

/**
 * Artifact store with private per-session roots and integrity validation.
 *
 * Roots are registered in an in-memory ledger. Temporary roots are created
 * under `os.tmpdir()` with `mkdtemp`, directories are `0700`, files `0600`,
 * publishing is temp-file + atomic rename, and resolution/reading re-validates
 * containment, symlinks, ownership, permissions, size and SHA-256. Remote URIs
 * are not part of the protocol; `ArtifactRef` comes from `protocol/handoff.ts`.
 */

export type ArtifactStoreErrorCode =
  | "UNREGISTERED_ROOT"
  | "UNKNOWN_ARTIFACT"
  | "INVALID_ARTIFACT_ID"
  | "INVALID_RUN_ID"
  | "INVALID_CYCLE_ID"
  | "INVALID_MEDIA_TYPE"
  | "LIMIT_EXCEEDED"
  | "ROOT_LIMIT_EXCEEDED"
  | "ALREADY_EXISTS"
  | "CONTAINMENT_VIOLATION"
  | "SYMLINK_NOT_ALLOWED"
  | "OWNERSHIP_MISMATCH"
  | "PERMISSIONS_MISMATCH"
  | "SIZE_MISMATCH"
  | "HASH_MISMATCH"
  | "NOT_A_FILE"
  | "NOT_A_DIRECTORY"
  | "IO_ERROR";

export class ArtifactStoreError extends Error {
  readonly code: ArtifactStoreErrorCode;

  constructor(code: ArtifactStoreErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ArtifactStoreError";
    this.code = code;
  }
}

export interface ArtifactRoot {
  /** Opaque id used by `ArtifactRef.rootId`. */
  id: string;
  /** Absolute path of the root directory. */
  path: string;
  /** Durable roots are ledger-only: `removeRoot` never deletes their files. */
  durable: boolean;
  createdAt: string;
}

export interface PublishInput {
  runId: string;
  cycleId: string;
  mediaType: string;
  data: Uint8Array | string;
  /** Optional opaque id; defaults to a random hex id. */
  id?: string;
}

export interface ResolvedArtifact {
  ref: ArtifactRef;
  root: ArtifactRoot;
  /** Absolute path of the artifact file on disk. */
  path: string;
  data: Buffer;
}

export interface ClaimedArtifactLocation {
  runId: string;
  cycleId: string;
  id: string;
  sha256: string;
  maxSizeBytes?: number;
}

export interface StoreLimits {
  /** Maximum bytes per artifact. */
  maxFileSizeBytes: number;
  /** Maximum total bytes published in one root. */
  maxRootBytes: number;
}

export const DEFAULT_LIMITS: StoreLimits = {
  maxFileSizeBytes: 8 * 1024 * 1024,
  maxRootBytes: 64 * 1024 * 1024,
};

export const DEFAULT_ALLOWED_MEDIA_TYPES: readonly string[] = [
  "application/json",
  "text/markdown",
  "text/plain",
  "application/octet-stream",
];

export interface ArtifactStoreOptions {
  /** Base directory for temporary roots (default: `os.tmpdir()`). */
  baseDir?: string;
  limits?: Partial<StoreLimits>;
  allowedMediaTypes?: readonly string[];
  /** Owning uid used for ownership checks (default: `process.getuid()`). */
  currentUid?: number;
}

interface ArtifactEntry {
  ref: ArtifactRef;
  runId: string;
  cycleId: string;
}

interface RootEntry {
  root: ArtifactRoot;
  artifacts: Map<string, ArtifactEntry>;
  rootBytes: number;
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === "string" && OPAQUE_ID_PATTERN.test(value);
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "ENOENT"
  );
}

function safeHexEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Pure containment check: `candidate` must resolve inside `rootPath`. */
export function isWithin(rootPath: string, candidate: string): boolean {
  const root = resolve(rootPath);
  const file = resolve(candidate);
  if (file !== root && !file.startsWith(root + sep)) return false;
  const rel = relative(root, file);
  return rel === "" || !rel.startsWith("..");
}

export function assertContained(rootPath: string, candidate: string): void {
  if (!isWithin(rootPath, candidate)) {
    throw new ArtifactStoreError("CONTAINMENT_VIOLATION", `path escapes registered root: ${candidate}`);
  }
}

export function isOwnedBy(stat: { uid: number }, uid: number): boolean {
  return stat.uid === uid;
}

export class ArtifactStore {
  private readonly baseDir: string;
  private readonly limits: StoreLimits;
  private readonly allowedMediaTypes: readonly string[];
  private readonly currentUid: number;
  private readonly roots = new Map<string, RootEntry>();

  constructor(options: ArtifactStoreOptions = {}) {
    this.baseDir = options.baseDir ?? tmpdir();
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.allowedMediaTypes = options.allowedMediaTypes ?? DEFAULT_ALLOWED_MEDIA_TYPES;
    // getuid is optional in the Node types (POSIX-only); without it no file
    // can match ownership, so the store fails safe by default.
    this.currentUid = options.currentUid ?? process.getuid?.() ?? -1;
  }

  /**
   * Create a private temporary root (0700) under the base dir and register it
   * in the ledger. `removeRoot` deletes its files.
   */
  async createRoot(label = "artifact"): Promise<ArtifactRoot> {
    const safeLabel = label.replace(/[^A-Za-z0-9._-]/g, "_");
    let path: string;
    try {
      path = await mkdtemp(join(this.baseDir, `${safeLabel}-`));
      await chmod(path, 0o700);
    } catch (error) {
      throw new ArtifactStoreError("IO_ERROR", `cannot create root under ${this.baseDir}: ${(error as Error).message}`, { cause: error });
    }
    const root: ArtifactRoot = {
      id: randomBytes(16).toString("hex"),
      path,
      durable: false,
      createdAt: new Date().toISOString(),
    };
    this.roots.set(root.id, { root, artifacts: new Map(), rootBytes: 0 });
    return root;
  }

  /**
   * Register an existing directory (temporary or durable) in the ledger.
   * Durable roots keep their files when removed from the ledger.
   */
  async registerRoot(id: string, path: string, options: { durable?: boolean } = {}): Promise<ArtifactRoot> {
    if (!isOpaqueId(id)) {
      throw new ArtifactStoreError("INVALID_ARTIFACT_ID", `invalid root id: ${id}`);
    }
    if (this.roots.has(id)) {
      throw new ArtifactStoreError("ALREADY_EXISTS", `root already registered: ${id}`);
    }
    if (!isAbsolute(path)) {
      throw new ArtifactStoreError("CONTAINMENT_VIOLATION", `root path must be absolute: ${path}`);
    }
    let stat: Stats;
    try {
      stat = await lstat(path);
    } catch (error) {
      if (isEnoent(error)) {
        throw new ArtifactStoreError("IO_ERROR", `root path does not exist: ${path}`);
      }
      throw new ArtifactStoreError("IO_ERROR", `cannot inspect root path: ${(error as Error).message}`, { cause: error });
    }
    if (stat.isSymbolicLink()) {
      throw new ArtifactStoreError("SYMLINK_NOT_ALLOWED", `root path must not be a symlink: ${path}`);
    }
    if (!stat.isDirectory()) {
      throw new ArtifactStoreError("NOT_A_DIRECTORY", `root path is not a directory: ${path}`);
    }
    if (!isOwnedBy(stat, this.currentUid)) {
      throw new ArtifactStoreError("OWNERSHIP_MISMATCH", `root path not owned by current user: ${path}`);
    }
    if (!(options.durable ?? false) && (stat.mode & 0o777) !== 0o700) {
      throw new ArtifactStoreError("PERMISSIONS_MISMATCH", `temporary root must be 0700: ${path}`);
    }
    const root: ArtifactRoot = {
      id,
      path: resolve(path),
      durable: options.durable ?? false,
      createdAt: new Date().toISOString(),
    };
    this.roots.set(id, { root, artifacts: new Map(), rootBytes: 0 });
    return root;
  }

  /**
   * Publish an artifact under `<root>/<runId>/<cycleId>/` via temp file +
   * atomic rename. Returns a validated `ArtifactRef`.
   */
  async put(rootId: string, input: PublishInput): Promise<ArtifactRef> {
    const entry = this.roots.get(rootId);
    if (!entry) {
      throw new ArtifactStoreError("UNREGISTERED_ROOT", `no registered root: ${rootId}`);
    }
    if (!isOpaqueId(input.runId)) {
      throw new ArtifactStoreError("INVALID_RUN_ID", `invalid run id: ${input.runId}`);
    }
    if (!isOpaqueId(input.cycleId)) {
      throw new ArtifactStoreError("INVALID_CYCLE_ID", `invalid cycle id: ${input.cycleId}`);
    }
    if (!this.allowedMediaTypes.includes(input.mediaType)) {
      throw new ArtifactStoreError("INVALID_MEDIA_TYPE", `media type not allowed: ${input.mediaType}`);
    }
    const data = typeof input.data === "string"
      ? Buffer.from(input.data, "utf8")
      : Buffer.from(input.data);
    const size = data.byteLength;
    if (size > this.limits.maxFileSizeBytes) {
      throw new ArtifactStoreError(
        "LIMIT_EXCEEDED",
        `artifact of ${size} bytes exceeds per-file limit ${this.limits.maxFileSizeBytes}`,
      );
    }
    const id = input.id ?? randomBytes(16).toString("hex");
    if (!isOpaqueId(id)) {
      throw new ArtifactStoreError("INVALID_ARTIFACT_ID", `invalid artifact id: ${id}`);
    }
    const sha256 = sha256HexOf(data);
    const existing = entry.artifacts.get(id);
    if (existing) {
      if (
        existing.ref.mediaType !== input.mediaType
        || existing.ref.size !== size
        || existing.ref.sha256 !== sha256
      ) {
        throw new ArtifactStoreError("ALREADY_EXISTS", `artifact id already registered with different content: ${id}`);
      }
      const onDisk = join(entry.root.path, existing.runId, existing.cycleId, id);
      try {
        await lstat(onDisk);
        return existing.ref; // idempotent re-publish of identical content
      } catch (error) {
        if (!isEnoent(error)) {
          throw new ArtifactStoreError("IO_ERROR", `cannot inspect existing artifact: ${(error as Error).message}`, { cause: error });
        }
        // ledger entry is stale (file removed); republish below
      }
    }
    if (entry.rootBytes + size > this.limits.maxRootBytes) {
      throw new ArtifactStoreError(
        "ROOT_LIMIT_EXCEEDED",
        `publishing ${size} bytes would exceed root limit ${this.limits.maxRootBytes}`,
      );
    }
    const dir = join(entry.root.path, input.runId, input.cycleId);
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await chmod(join(entry.root.path, input.runId), 0o700);
      await chmod(dir, 0o700);
    } catch (error) {
      throw new ArtifactStoreError("IO_ERROR", `cannot create artifact directories: ${(error as Error).message}`, { cause: error });
    }
    await this.walkComponents(entry.root.path, dir, {
      expectFile: false,
      enforcePrivateRoot: !entry.root.durable,
    });
    const target = join(dir, id);
    const tmp = join(dir, `.tmp-${id}-${randomBytes(4).toString("hex")}`);
    try {
      const handle = await open(tmp, "wx", 0o600);
      try {
        await handle.writeFile(data);
        await handle.sync();
      } finally {
        await handle.close();
      }
      let planted = false;
      try {
        await lstat(target);
        planted = true;
      } catch (error) {
        if (!isEnoent(error)) throw error;
      }
      if (planted) {
        throw new ArtifactStoreError("ALREADY_EXISTS", `artifact file already exists on disk: ${target}`);
      }
      await rename(tmp, target);
      await chmod(target, 0o600);
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => {});
      if (error instanceof ArtifactStoreError) throw error;
      throw new ArtifactStoreError("IO_ERROR", `cannot publish artifact: ${(error as Error).message}`, { cause: error });
    }
    const ref: ArtifactRef = { id, rootId, mediaType: input.mediaType, size, sha256 };
    assertArtifactRef(ref);
    entry.artifacts.set(id, { ref, runId: input.runId, cycleId: input.cycleId });
    entry.rootBytes += size;
    return ref;
  }

  /**
   * Resolve and verify an artifact: registered root, ledger entry, containment,
   * no symlinks, ownership, 0700/0600 permissions, size and SHA-256.
   */
  async get(rootId: string, artifactId: string): Promise<ResolvedArtifact> {
    const entry = this.roots.get(rootId);
    if (!entry) {
      throw new ArtifactStoreError("UNREGISTERED_ROOT", `no registered root: ${rootId}`);
    }
    const artifact = entry.artifacts.get(artifactId);
    if (!artifact) {
      throw new ArtifactStoreError("UNKNOWN_ARTIFACT", `no artifact in root ${rootId}: ${artifactId}`);
    }
    const filePath = join(entry.root.path, artifact.runId, artifact.cycleId, artifact.ref.id);
    const fileStat = await this.walkComponents(entry.root.path, filePath, {
      expectFile: true,
      missingAs: "UNKNOWN_ARTIFACT",
      enforcePrivateRoot: !entry.root.durable,
    });
    if (!fileStat) {
      throw new ArtifactStoreError("UNKNOWN_ARTIFACT", `artifact file vanished: ${filePath}`);
    }
    if (fileStat.size !== artifact.ref.size) {
      throw new ArtifactStoreError(
        "SIZE_MISMATCH",
        `artifact size changed: expected ${artifact.ref.size}, found ${fileStat.size}`,
      );
    }
    const data = await this.readVerifiedFile(entry.root.path, filePath, fileStat);
    if (data.byteLength !== artifact.ref.size) {
      throw new ArtifactStoreError(
        "SIZE_MISMATCH",
        `artifact size changed while reading: expected ${artifact.ref.size}, found ${data.byteLength}`,
      );
    }
    if (!safeHexEqual(sha256HexOf(data), artifact.ref.sha256)) {
      throw new ArtifactStoreError("HASH_MISMATCH", `artifact SHA-256 mismatch for ${artifactId}`);
    }
    return { ref: artifact.ref, root: entry.root, path: filePath, data };
  }

  /**
   * Read a child-published file which was not created by this process. This is
   * the reload-safe path used for manifests: identity comes from the registered
   * root plus opaque Run/cycle/file ids, and integrity comes from the claim.
   */
  async readClaimed(rootId: string, location: ClaimedArtifactLocation): Promise<Buffer> {
    const entry = this.roots.get(rootId);
    if (!entry) {
      throw new ArtifactStoreError("UNREGISTERED_ROOT", `no registered root: ${rootId}`);
    }
    if (!isOpaqueId(location.runId)) {
      throw new ArtifactStoreError("INVALID_RUN_ID", `invalid run id: ${location.runId}`);
    }
    if (!isOpaqueId(location.cycleId)) {
      throw new ArtifactStoreError("INVALID_CYCLE_ID", `invalid cycle id: ${location.cycleId}`);
    }
    if (!isOpaqueId(location.id)) {
      throw new ArtifactStoreError("INVALID_ARTIFACT_ID", `invalid artifact id: ${location.id}`);
    }
    const path = join(entry.root.path, location.runId, location.cycleId, location.id);
    const stat = await this.walkComponents(entry.root.path, path, {
      expectFile: true,
      missingAs: "UNKNOWN_ARTIFACT",
      enforcePrivateRoot: !entry.root.durable,
    });
    const limit = Math.min(location.maxSizeBytes ?? this.limits.maxFileSizeBytes, this.limits.maxFileSizeBytes);
    if (!stat || stat.size > limit) {
      throw new ArtifactStoreError("LIMIT_EXCEEDED", `claimed file exceeds limit ${limit}`);
    }
    const data = await this.readVerifiedFile(entry.root.path, path, stat);
    if (data.byteLength !== stat.size) {
      throw new ArtifactStoreError("SIZE_MISMATCH", "claimed file changed while reading");
    }
    if (!safeHexEqual(sha256HexOf(data), location.sha256)) {
      throw new ArtifactStoreError("HASH_MISMATCH", `claimed file SHA-256 mismatch for ${location.id}`);
    }
    return data;
  }

  /** Validate a manifest ArtifactRef directly from disk, including after reload. */
  async verify(
    ref: ArtifactRef,
    location: { runId: string; cycleId: string },
  ): Promise<ResolvedArtifact> {
    assertArtifactRef(ref);
    if (!this.allowedMediaTypes.includes(ref.mediaType)) {
      throw new ArtifactStoreError("INVALID_MEDIA_TYPE", `media type not allowed: ${ref.mediaType}`);
    }
    const data = await this.readClaimed(ref.rootId, {
      ...location,
      id: ref.id,
      sha256: ref.sha256,
      maxSizeBytes: ref.size,
    });
    if (data.byteLength !== ref.size) {
      throw new ArtifactStoreError("SIZE_MISMATCH", `artifact size changed: expected ${ref.size}, found ${data.byteLength}`);
    }
    const root = this.roots.get(ref.rootId)!.root;
    const path = join(root.path, location.runId, location.cycleId, ref.id);
    return { ref, root, path, data };
  }

  /**
   * Remove a root from the ledger. Idempotent. Temporary roots have their
   * files removed (tolerating already-deleted files); durable roots keep them.
   */
  async removeRoot(rootId: string): Promise<void> {
    const entry = this.roots.get(rootId);
    if (!entry) return;
    if (entry.root.durable) {
      this.roots.delete(rootId);
      return;
    }
    let rootStat: Stats;
    try {
      rootStat = await lstat(entry.root.path);
    } catch (error) {
      if (isEnoent(error)) {
        this.roots.delete(rootId);
        return;
      }
      throw new ArtifactStoreError("IO_ERROR", `cannot inspect root during cleanup: ${(error as Error).message}`, { cause: error });
    }
    if (!isOwnedBy(rootStat, this.currentUid)) {
      throw new ArtifactStoreError("OWNERSHIP_MISMATCH", `refusing to remove root not owned by current user: ${entry.root.path}`);
    }
    try {
      await rm(entry.root.path, { recursive: true, force: true, maxRetries: 2 });
      this.roots.delete(rootId);
    } catch (error) {
      throw new ArtifactStoreError("IO_ERROR", `cannot remove root: ${(error as Error).message}`, { cause: error });
    }
  }

  root(rootId: string): ArtifactRoot | undefined {
    return this.roots.get(rootId)?.root;
  }

  listRoots(): ArtifactRoot[] {
    return [...this.roots.values()].map((entry) => entry.root);
  }

  /**
   * Walk every path component (root inclusive) and reject symlinks, divergent
   * ownership and wrong permissions; directories must be 0700 and the final
   * file (when `expectFile`) 0600. The root's own mode is not enforced so
   * pre-existing durable roots with looser modes still work.
   */
  private async walkComponents(
    rootPath: string,
    targetPath: string,
    options: {
      expectFile: boolean;
      missingAs?: ArtifactStoreErrorCode;
      enforcePrivateRoot?: boolean;
    },
  ): Promise<Stats | undefined> {
    const missingCode = options.missingAs ?? "IO_ERROR";
    assertContained(rootPath, targetPath);
    const rel = relative(rootPath, targetPath);
    const parts = rel === "" ? [] : rel.split(sep);
    const chain: string[] = [rootPath];
    let cursor = rootPath;
    for (const part of parts) {
      cursor = join(cursor, part);
      chain.push(cursor);
    }
    let fileStat: Stats | undefined;
    for (let i = 0; i < chain.length; i += 1) {
      const path = chain[i];
      let stat: Stats;
      try {
        stat = await lstat(path);
      } catch (error) {
        if (isEnoent(error)) {
          throw new ArtifactStoreError(missingCode, `missing path in artifact tree: ${path}`);
        }
        throw new ArtifactStoreError("IO_ERROR", `cannot inspect ${path}: ${(error as Error).message}`, { cause: error });
      }
      if (stat.isSymbolicLink()) {
        throw new ArtifactStoreError("SYMLINK_NOT_ALLOWED", `symlink in artifact path: ${path}`);
      }
      if (!isOwnedBy(stat, this.currentUid)) {
        throw new ArtifactStoreError("OWNERSHIP_MISMATCH", `path not owned by current user: ${path}`);
      }
      if (path === rootPath && options.enforcePrivateRoot && (stat.mode & 0o777) !== 0o700) {
        throw new ArtifactStoreError("PERMISSIONS_MISMATCH", `temporary root must be 0700: ${path}`);
      }
      const isFileComponent = options.expectFile && i === chain.length - 1;
      if (isFileComponent) {
        if (!stat.isFile()) {
          throw new ArtifactStoreError("NOT_A_FILE", `artifact is not a regular file: ${path}`);
        }
        if ((stat.mode & 0o777) !== 0o600) {
          throw new ArtifactStoreError("PERMISSIONS_MISMATCH", `artifact file must be 0600: ${path}`);
        }
        fileStat = stat;
      } else if (path !== rootPath) {
        if (!stat.isDirectory()) {
          throw new ArtifactStoreError("NOT_A_DIRECTORY", `artifact path must be a directory: ${path}`);
        }
        if ((stat.mode & 0o777) !== 0o700) {
          throw new ArtifactStoreError("PERMISSIONS_MISMATCH", `artifact directory must be 0700: ${path}`);
        }
      }
    }
    return fileStat;
  }

  /** Open without following the final symlink and verify the opened inode/path. */
  private async readVerifiedFile(
    rootPath: string,
    filePath: string,
    expected: Stats,
  ): Promise<Buffer> {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== expected.dev || opened.ino !== expected.ino) {
        throw new ArtifactStoreError(
          "CONTAINMENT_VIOLATION",
          `artifact changed between validation and open: ${filePath}`,
        );
      }
      // Herdr is Linux-hosted. Resolving the open descriptor closes the
      // directory-component swap race that path-only lstat checks cannot.
      const openedPath = await realpath(`/proc/self/fd/${handle.fd}`);
      assertContained(rootPath, openedPath);
      return await handle.readFile();
    } catch (error) {
      if (error instanceof ArtifactStoreError) throw error;
      if (isEnoent(error)) {
        throw new ArtifactStoreError("UNKNOWN_ARTIFACT", `artifact file vanished: ${filePath}`);
      }
      const code = typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : "";
      if (code === "ELOOP") {
        throw new ArtifactStoreError("SYMLINK_NOT_ALLOWED", `symlink in artifact path: ${filePath}`);
      }
      throw new ArtifactStoreError(
        "IO_ERROR",
        `cannot securely read artifact: ${(error as Error).message}`,
        { cause: error },
      );
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
}
