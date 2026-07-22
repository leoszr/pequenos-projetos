import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  HerdrClient,
  HerdrProtocolError,
} from "../../src/herdr/client.ts";

let server: Server | undefined;
let directory: string | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
  server = undefined;
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

async function fakeHerdr(
  handler: (request: any, socket: Socket) => void,
): Promise<string> {
  directory = await mkdtemp(join(tmpdir(), "holistic-herdr-"));
  const path = join(directory, "socket");
  server = createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const index = buffer.indexOf("\n");
        if (index < 0) break;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        handler(JSON.parse(line), socket);
      }
    });
  });
  await new Promise<void>((resolve) => server!.listen(path, resolve));
  return path;
}

function respond(socket: Socket, id: string, result: unknown): void {
  socket.write(`${JSON.stringify({ id, result })}\n`);
}

describe("HerdrClient", () => {
  it("handshakes and parses fragmented responses", async () => {
    const path = await fakeHerdr((request, socket) => {
      const result = request.method === "session.snapshot"
        ? { snapshot: { protocol: 17, version: "test", panes: [] } }
        : { value: 42 };
      const line = `${JSON.stringify({ id: request.id, result })}\n`;
      socket.write(line.slice(0, 5));
      socket.write(line.slice(5));
    });
    const client = new HerdrClient(path);
    expect((await client.connect()).protocol).toBe(17);
    await expect(client.request("test.echo")).resolves.toEqual({ value: 42 });
    client.close();
  });

  it("rejects an incompatible protocol", async () => {
    const path = await fakeHerdr((request, socket) => {
      respond(socket, request.id, { snapshot: { protocol: 16 } });
    });
    const client = new HerdrClient(path);
    await expect(client.connect()).rejects.toBeInstanceOf(HerdrProtocolError);
    client.close();
  });

  it("delivers subscribed events", async () => {
    const path = await fakeHerdr((request, socket) => {
      if (request.method === "session.snapshot") {
        respond(socket, request.id, { snapshot: { protocol: 17 } });
      } else {
        respond(socket, request.id, { subscribed: true });
        socket.write(`${JSON.stringify({ event: "pane.agent_status_changed", data: { pane_id: "p1" } })}\n`);
      }
    });
    const client = new HerdrClient(path);
    const event = new Promise<string>((resolve) => {
      void client.subscribe([{ type: "pane.agent_status_changed" }], (value) => {
        resolve(value.event);
      });
    });
    await expect(event).resolves.toBe("pane.agent_status_changed");
    client.close();
  });

  it("supports timeout and abort", async () => {
    const path = await fakeHerdr((request, socket) => {
      if (request.method === "session.snapshot") {
        respond(socket, request.id, { snapshot: { protocol: 17 } });
      }
    });
    const client = new HerdrClient(path, { requestTimeoutMs: 20 });
    await client.connect();
    await expect(client.request("never")).rejects.toThrow("timed out");

    const controller = new AbortController();
    const pending = client.request("never", {}, { signal: controller.signal, timeoutMs: 1_000 });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    client.close();
  });

  it("rejects malformed NDJSON without crashing the process", async () => {
    const path = await fakeHerdr((_request, socket) => socket.write("not-json\n"));
    const client = new HerdrClient(path);
    await expect(client.request("broken")).rejects.toBeInstanceOf(HerdrProtocolError);
    client.close();
  });
});
