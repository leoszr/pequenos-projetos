import { createHmac, timingSafeEqual } from "node:crypto";

const DELIMITER = Buffer.from("<IDS|MSG>");
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export type WireObject = Record<string, unknown>;

export interface WireHeader extends WireObject {
  msg_id: string;
  username: string;
  session: string;
  date: string;
  msg_type: string;
  version: string;
}

export interface WireMessage {
  identities: Buffer[];
  header: WireHeader;
  parentHeader: WireObject;
  metadata: WireObject;
  content: WireObject;
  buffers: Buffer[];
  byteLength: number;
}

export interface OutgoingWireMessage {
  header: WireHeader;
  parentHeader?: WireObject;
  metadata?: WireObject;
  content?: WireObject;
  buffers?: readonly Uint8Array[];
}

export class WireProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WireProtocolError";
  }
}

function jsonFrame(value: WireObject): Buffer {
  return Buffer.from(encoder.encode(JSON.stringify(value)));
}

function signature(key: string, frames: readonly Buffer[]): Buffer {
  if (!key) return Buffer.alloc(0);
  const hmac = createHmac("sha256", key);
  for (const frame of frames) hmac.update(frame);
  return Buffer.from(hmac.digest("hex"), "ascii");
}

export function encodeWireMessage(key: string, message: OutgoingWireMessage): Buffer[] {
  const signed = [
    jsonFrame(message.header),
    jsonFrame(message.parentHeader ?? {}),
    jsonFrame(message.metadata ?? {}),
    jsonFrame(message.content ?? {}),
  ];
  return [
    DELIMITER,
    signature(key, signed),
    ...signed,
    ...(message.buffers ?? []).map((buffer) => Buffer.from(buffer)),
  ];
}

function parseObject(frame: Buffer, name: string): WireObject {
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(frame));
  } catch (error) {
    throw new WireProtocolError(`Invalid ${name} JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new WireProtocolError(`${name} must be a JSON object`);
  }
  return value as WireObject;
}

export function decodeWireMessage(
  frames: readonly Buffer[],
  key: string,
  maxMessageBytes: number,
): WireMessage {
  if (!Number.isSafeInteger(maxMessageBytes) || maxMessageBytes <= 0) {
    throw new RangeError("maxMessageBytes must be a positive safe integer");
  }
  if (frames.length > 64) throw new WireProtocolError("Jupyter message has too many frames");

  const byteLength = frames.reduce((total, frame) => total + frame.byteLength, 0);
  if (byteLength > maxMessageBytes) {
    throw new WireProtocolError(`Jupyter message exceeds ${maxMessageBytes} bytes`);
  }

  const delimiter = frames.findIndex((frame) => frame.equals(DELIMITER));
  if (delimiter < 0 || frames.length < delimiter + 6) {
    throw new WireProtocolError("Malformed Jupyter message framing");
  }

  const supplied = frames[delimiter + 1]!;
  const signed = frames.slice(delimiter + 2, delimiter + 6);
  const expected = signature(key, signed);
  if (supplied.byteLength !== expected.byteLength || !timingSafeEqual(supplied, expected)) {
    throw new WireProtocolError("Invalid Jupyter message signature");
  }

  const header = parseObject(signed[0]!, "header") as WireHeader;
  if (typeof header.msg_id !== "string" || typeof header.msg_type !== "string") {
    throw new WireProtocolError("Jupyter header is missing msg_id or msg_type");
  }

  return {
    identities: frames.slice(0, delimiter).map((frame) => Buffer.from(frame)),
    header,
    parentHeader: parseObject(signed[1]!, "parent_header"),
    metadata: parseObject(signed[2]!, "metadata"),
    content: parseObject(signed[3]!, "content"),
    buffers: frames.slice(delimiter + 6).map((frame) => Buffer.from(frame)),
    byteLength,
  };
}
