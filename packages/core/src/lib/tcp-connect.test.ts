/**
 * TCP preflight tests.
 *
 * The timing assertion is the one that matters. The bug this module fixes was
 * not "the connection failed" — it was "the connection failed after ninety
 * seconds", so a test that only checks the rejection would pass against the
 * behaviour being removed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { connectTcp, describeTcpFailure } from "./tcp-connect.js";

test("resolves a usable socket for a reachable port", async () => {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  try {
    const socket = await connectTcp("127.0.0.1", port);
    assert.equal(socket.destroyed, false);
    socket.destroy();
  } finally {
    server.close();
  }
});

test("gives up within the deadline rather than the handshake budget", async () => {
  // 203.0.113.0/24 is TEST-NET-3: reserved for documentation, so it is
  // guaranteed not to route anywhere and packets are dropped, not refused.
  const started = Date.now();
  await assert.rejects(() => connectTcp("203.0.113.1", 22, 1_000));
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 5_000, `took ${elapsed}ms, expected under 5000ms`);
});

test("rejects a closed port", async () => {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  await new Promise<void>((r) => server.close(() => r()));
  await assert.rejects(() => connectTcp("127.0.0.1", port, 2_000));
});

test("distinguishes the failures that need different responses", () => {
  const refused = describeTcpFailure({ code: "ECONNREFUSED" }, "h", 22);
  const dns = describeTcpFailure({ code: "ENOTFOUND" }, "h", 22);
  const route = describeTcpFailure({ code: "EHOSTUNREACH" }, "h", 22);
  const dropped = describeTcpFailure({ code: "ETIMEDOUT" }, "h", 22);
  const all = [refused, dns, route, dropped];
  assert.equal(new Set(all).size, all.length, "each failure needs its own message");
  assert.match(refused, /nothing is listening/);
  assert.match(dns, /resolve/);
  assert.match(dropped, /asleep|powered off|firewall/);
});
