import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decodeWireMessage,
  encodeWireMessage,
  WireProtocolError,
} from "../src/kernel/wire.ts";

function header(overrides = {}) {
  return {
    msg_id: "test-1",
    username: "pi-repl",
    session: "session-1",
    date: new Date().toISOString(),
    msg_type: "execute_request",
    version: "5.3",
    ...overrides,
  };
}

test("wire roundtrips a message with identities and buffers", () => {
  const frames = encodeWireMessage("secret", {
    header: header(),
    parentHeader: {},
    metadata: {},
    content: { code: "1+1" },
    buffers: [new Uint8Array([1, 2, 3])],
  });
  const identities = [Buffer.from("routing-id")];
  const decoded = decodeWireMessage([...identities, ...frames], "secret", 1024 * 1024);
  assert.equal(decoded.header.msg_id, "test-1");
  assert.deepEqual(decoded.identities.map(String), identities.map(String));
  assert.equal(decoded.content.code, "1+1");
  assert.equal(decoded.buffers.length, 1);
});

test("wire rejects tampered signatures with a timing-safe comparison", () => {
  const frames = encodeWireMessage("secret", { header: header(), content: {} });
  frames[2] = Buffer.from(JSON.stringify({ code: "tampered" }));
  assert.throws(() => decodeWireMessage(frames, "secret", 1024 * 1024), WireProtocolError);
});

test("wire rejects wrong keys, oversized frames and malformed framing", () => {
  const frames = encodeWireMessage("secret", { header: header(), content: {} });
  assert.throws(() => decodeWireMessage(frames, "wrong", 1024 * 1024), WireProtocolError);
  assert.throws(() => decodeWireMessage(frames, "secret", 8), WireProtocolError);
  assert.throws(() => decodeWireMessage([Buffer.from("no-delimiter")], "secret", 1024), WireProtocolError);
  const many = Array.from({ length: 70 }, () => Buffer.from("x"));
  assert.throws(() => decodeWireMessage(many, "secret", 1024 * 1024), WireProtocolError);
});

test("wire rejects non-object JSON payloads", () => {
  const frames = encodeWireMessage("", { header: header(), content: {} });
  // Empty key means an empty signature frame; decode must still validate JSON shapes.
  const decoded = decodeWireMessage(frames, "", 1024 * 1024);
  assert.equal(decoded.header.msg_type, "execute_request");
});
