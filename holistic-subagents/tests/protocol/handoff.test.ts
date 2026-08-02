import { describe, expect, it } from "vitest";

import {
  HandoffValidationError,
  hashManifest,
  isArtifactRef,
  isHandoffManifest,
  isHandoffReadyClaim,
  manifestMatchesHash,
  parseManifest,
  serializeManifest,
  type ArtifactRef,
  type HandoffManifest,
} from "../../src/protocol/handoff.ts";

const ref: ArtifactRef = {
  id: "artifact-1",
  rootId: "root-1",
  mediaType: "application/json",
  size: 42,
  sha256: "ab".repeat(32),
};

function manifest(): HandoffManifest {
  return {
    protocolVersion: 1,
    cycleId: "cycle-1",
    summary: "Implemented and validated",
    commands: ["npm test"],
    files: [{ path: "src/a.ts", status: "added" }],
    commits: [{ id: "abc123" }],
    risks: [],
    artifacts: [ref],
  };
}

describe("structured handoff protocol", () => {
  it("accepts the versioned manifest, ArtifactRef and claim contracts", () => {
    expect(isHandoffManifest(manifest())).toBe(true);
    expect(isArtifactRef(ref)).toBe(true);
    expect(isHandoffReadyClaim({
      cycleId: "cycle-1",
      manifestId: "manifest-1",
      manifestHash: "cd".repeat(32),
    })).toBe(true);
  });

  it("rejects incompatible schemas and unknown remote fields", () => {
    expect(isHandoffManifest({ ...manifest(), protocolVersion: 2 })).toBe(false);
    expect(isHandoffManifest({ ...manifest(), uri: "https://example.test/manifest" })).toBe(false);
    expect(isArtifactRef({ ...ref, uri: "s3://bucket/file" })).toBe(false);
    expect(isHandoffReadyClaim({ cycleId: "cycle-1", manifestId: "manifest-1" })).toBe(false);
  });

  it("rejects traversal, malformed media metadata and hashes", () => {
    expect(isHandoffManifest({
      ...manifest(),
      files: [{ path: "../escape", status: "added" }],
    })).toBe(false);
    expect(isArtifactRef({ ...ref, id: "../escape" })).toBe(false);
    expect(isArtifactRef({ ...ref, mediaType: "application/json; charset=utf-8" })).toBe(false);
    expect(isArtifactRef({ ...ref, size: -1 })).toBe(false);
    expect(isArtifactRef({ ...ref, sha256: "invalid" })).toBe(false);
  });

  it("enforces manifest byte and artifact-count limits", () => {
    expect(isHandoffManifest(manifest(), { maxSerializedBytes: 10 })).toBe(false);
    expect(isHandoffManifest(manifest(), { maxArtifacts: 0 })).toBe(false);
  });

  it("serializes deterministically and validates the declared hash", () => {
    const value = manifest();
    const bytes = serializeManifest(value);
    expect(parseManifest(bytes)).toEqual(value);
    expect(manifestMatchesHash(value, hashManifest(value))).toBe(true);
    expect(manifestMatchesHash(value, "00".repeat(32))).toBe(false);
  });

  it("rejects invalid or incompatible JSON", () => {
    expect(() => parseManifest("{not-json")).toThrow(HandoffValidationError);
    expect(() => parseManifest('{"protocolVersion":2}')).toThrow(HandoffValidationError);
  });
});
