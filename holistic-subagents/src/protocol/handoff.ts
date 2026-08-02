import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Structured handoff protocol for child Agent Sessions.
 *
 * This module is standalone: it must not import from the domain/service
 * layers so the parent can validate handoff payloads without pulling runtime
 * state. It owns the JSON schema of `HandoffManifest`, `ArtifactRef` and the
 * `HANDOFF_READY` claim, plus canonical serialization and SHA-256 hashing.
 */

export const HANDOFF_PROTOCOL_VERSION = 1 as const;
export type HandoffProtocolVersion = typeof HANDOFF_PROTOCOL_VERSION;

/** Lowercase hex SHA-256 digest, 64 chars. */
export const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
/**
 * Opaque identifiers (cycle, root, artifact, run): 1-128 chars, no path
 * separators, no leading dot, no ".." escapes, ASCII.
 */
export const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** Media type without parameters, e.g. `application/json`. */
export const MEDIA_TYPE_PATTERN = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/;

export const FILE_STATUSES = ["added", "modified", "deleted", "renamed", "untracked"] as const;
export type FileStatus = (typeof FILE_STATUSES)[number];

/**
 * Reference to one artifact. The id is opaque and resolvable only inside the
 * registered root named by `rootId`. Remote URIs are outside the protocol:
 * strict key checking rejects any `url`/`uri`/`path`-style field.
 */
export interface ArtifactRef {
  id: string;
  rootId: string;
  mediaType: string;
  size: number;
  sha256: string;
}

export interface HandoffFile {
  /** Worktree-relative path; no leading slash, no ".." segments. */
  path: string;
  status: FileStatus;
}

export interface HandoffCommit {
  id: string;
  summary?: string;
}

export interface HandoffManifest {
  protocolVersion: 1;
  cycleId: string;
  summary: string;
  commands: string[];
  files: HandoffFile[];
  commits: HandoffCommit[];
  risks: string[];
  artifacts: ArtifactRef[];
}

/** Payload of a HOLISTIC_HANDOFF_READY claim: only identity and integrity. */
export interface HandoffReadyClaim {
  cycleId: string;
  manifestId: string;
  manifestHash: string;
}

export interface ManifestValidationOptions {
  /** Reject manifests whose canonical serialized form exceeds this size. */
  maxSerializedBytes?: number;
  /** Reject manifests referencing more than this many artifacts. */
  maxArtifacts?: number;
}

export class HandoffValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HandoffValidationError";
  }
}

const MANIFEST_KEYS = [
  "protocolVersion",
  "cycleId",
  "summary",
  "commands",
  "files",
  "commits",
  "risks",
  "artifacts",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(record);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === "string" && OPAQUE_ID_PATTERN.test(value);
}

function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && SHA256_HEX_PATTERN.test(value);
}

function isMediaType(value: unknown): value is string {
  return typeof value === "string" && MEDIA_TYPE_PATTERN.test(value);
}

function isSafeSize(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) return false;
  if (value.startsWith("/") || value.includes("\\") || value.includes("\0")) return false;
  const segments = value.split("/");
  return !segments.includes("..") && !segments.includes(".");
}

export function isArtifactRef(value: unknown): value is ArtifactRef {
  if (!isRecord(value) || !hasExactKeys(value, ["id", "rootId", "mediaType", "size", "sha256"])) {
    return false;
  }
  const { id, rootId, mediaType, size, sha256 } = value;
  return (
    isOpaqueId(id)
    && isOpaqueId(rootId)
    && isMediaType(mediaType)
    && isSafeSize(size)
    && isSha256Hex(sha256)
  );
}

export function assertArtifactRef(value: unknown): asserts value is ArtifactRef {
  if (!isArtifactRef(value)) {
    throw new HandoffValidationError(
      "invalid ArtifactRef: expected exactly { id, rootId, mediaType, size, sha256 } "
      + "with opaque ids, parameterless media type, non-negative safe integer size "
      + "and lowercase hex SHA-256; remote URIs are not part of the protocol",
    );
  }
}

function isHandoffFile(value: unknown): value is HandoffFile {
  if (!isRecord(value) || !hasExactKeys(value, ["path", "status"])) return false;
  const { path, status } = value;
  return (
    isRelativePath(path)
    && typeof status === "string"
    && (FILE_STATUSES as readonly string[]).includes(status)
  );
}

function isHandoffCommit(value: unknown): value is HandoffCommit {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.length < 1 || keys.length > 2 || keys.some((key) => key !== "id" && key !== "summary")) {
    return false;
  }
  const { id, summary } = value;
  if (typeof id !== "string" || id.length === 0 || id.length > 128) return false;
  return summary === undefined || typeof summary === "string";
}

export function isHandoffManifest(
  value: unknown,
  options: ManifestValidationOptions = {},
): value is HandoffManifest {
  if (!isRecord(value) || !hasExactKeys(value, MANIFEST_KEYS)) return false;
  const { protocolVersion, cycleId, summary, commands, files, commits, risks, artifacts } = value;
  if (protocolVersion !== HANDOFF_PROTOCOL_VERSION) return false;
  if (!isOpaqueId(cycleId)) return false;
  if (typeof summary !== "string" || summary.trim().length === 0 || summary.length > 100_000) {
    return false;
  }
  if (!Array.isArray(commands) || !commands.every((command) => typeof command === "string")) {
    return false;
  }
  if (!Array.isArray(files) || !files.every(isHandoffFile)) return false;
  if (!Array.isArray(commits) || !commits.every(isHandoffCommit)) return false;
  if (!Array.isArray(risks) || !risks.every((risk) => typeof risk === "string")) return false;
  if (!Array.isArray(artifacts) || !artifacts.every(isArtifactRef)) return false;
  if (options.maxArtifacts !== undefined && artifacts.length > options.maxArtifacts) return false;
  if (options.maxSerializedBytes !== undefined) {
    if (serializeManifest(value as unknown as HandoffManifest).byteLength > options.maxSerializedBytes) {
      return false;
    }
  }
  return true;
}

export function assertHandoffManifest(
  value: unknown,
  options: ManifestValidationOptions = {},
): asserts value is HandoffManifest {
  if (!isHandoffManifest(value, options)) {
    throw new HandoffValidationError(
      "invalid HandoffManifest: expected protocolVersion 1, opaque cycleId, non-empty "
      + "summary, string commands/risks, relative-path files, commit ids and valid "
      + "ArtifactRef entries; unknown fields (including URIs) are rejected",
    );
  }
}

export function isHandoffReadyClaim(value: unknown): value is HandoffReadyClaim {
  if (!isRecord(value) || !hasExactKeys(value, ["cycleId", "manifestId", "manifestHash"])) {
    return false;
  }
  const { cycleId, manifestId, manifestHash } = value;
  return isOpaqueId(cycleId) && isOpaqueId(manifestId) && isSha256Hex(manifestHash);
}

export function assertHandoffReadyClaim(value: unknown): asserts value is HandoffReadyClaim {
  if (!isHandoffReadyClaim(value)) {
    throw new HandoffValidationError(
      "invalid HANDOFF_READY claim: expected exactly { cycleId, manifestId, manifestHash } "
      + "with opaque ids and a lowercase hex SHA-256 manifest hash",
    );
  }
}

/** Canonical UTF-8 JSON bytes with fixed key order; same manifest always yields the same bytes. */
export function serializeManifest(manifest: HandoffManifest): Uint8Array {
  const canonical = {
    protocolVersion: HANDOFF_PROTOCOL_VERSION,
    cycleId: manifest.cycleId,
    summary: manifest.summary,
    commands: [...manifest.commands],
    files: manifest.files.map((file) => ({ path: file.path, status: file.status })),
    commits: manifest.commits.map((commit) =>
      commit.summary === undefined ? { id: commit.id } : { id: commit.id, summary: commit.summary },
    ),
    risks: [...manifest.risks],
    artifacts: manifest.artifacts.map((ref) => ({
      id: ref.id,
      rootId: ref.rootId,
      mediaType: ref.mediaType,
      size: ref.size,
      sha256: ref.sha256,
    })),
  };
  return new TextEncoder().encode(JSON.stringify(canonical));
}

export function sha256HexOf(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function hashManifest(manifest: HandoffManifest): string {
  return sha256HexOf(serializeManifest(manifest));
}

/** Timing-safe comparison against a declared hash (the only accepted integrity check). */
export function manifestMatchesHash(manifest: HandoffManifest, declaredHash: string): boolean {
  if (!SHA256_HEX_PATTERN.test(declaredHash)) return false;
  const computed = Buffer.from(hashManifest(manifest), "hex");
  const declared = Buffer.from(declaredHash, "hex");
  return computed.length === declared.length && timingSafeEqual(computed, declared);
}

export function parseManifest(
  json: string | Uint8Array,
  options: ManifestValidationOptions = {},
): HandoffManifest {
  const text = typeof json === "string" ? json : new TextDecoder().decode(json);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new HandoffValidationError(`manifest is not valid JSON: ${(error as Error).message}`);
  }
  assertHandoffManifest(parsed, options);
  return parsed;
}
