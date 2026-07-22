import { describe, it } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { listenServer } from "../../src/server.js";

describe("listenServer", () => {
  it("returns ok when the port is free", async () => {
    const server = http.createServer();
    const result = await listenServer(server, 0, "127.0.0.1");
    assert.ok(result.ok);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("returns err with code EADDRINUSE when the port is already taken", async () => {
    // Occupy an ephemeral port with a raw TCP server.
    const occupier = net.createServer();
    await new Promise<void>((resolve) => occupier.listen(0, "127.0.0.1", resolve));
    const { port } = occupier.address() as AddressInfo;

    try {
      const server = http.createServer();
      const result = await listenServer(server, port, "127.0.0.1");
      assert.ok(!result.ok);
      assert.equal(result.error.code, "EADDRINUSE");
    } finally {
      await new Promise<void>((resolve) => occupier.close(() => resolve()));
    }
  });
});
