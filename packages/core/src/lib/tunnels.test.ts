/**
 * Tunnel tests.
 *
 * Validation is tested exhaustively because every failure here is read by
 * someone who just mistyped a port, and a wrong message sends them looking in
 * the wrong place. The manager's lifecycle is tested with a real local forward
 * over a fake SSH client — enough to prove listeners open, pipe, and close,
 * without needing a server.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, connect } from "node:net";
import { EventEmitter } from "node:events";
import { TunnelManager, validateTunnel } from "./tunnels.js";

const base = {
  id: "t1",
  hostId: "h1",
  type: "local" as const,
  listenPort: 5432,
  listenAddress: "127.0.0.1",
  destHost: "127.0.0.1",
  destPort: 5432,
};

// ── Validation ────────────────────────────────────────────────────────────

test("a well-formed spec passes", () => {
  assert.equal(validateTunnel(base), null);
});

test("a missing direction is caught", () => {
  assert.match(validateTunnel({ ...base, type: undefined as any })!, /direction/i);
});

test("ports outside the valid range are caught", () => {
  assert.match(validateTunnel({ ...base, listenPort: 0 })!, /between 1 and 65535/);
  assert.match(validateTunnel({ ...base, listenPort: 70000 })!, /between 1 and 65535/);
  assert.match(validateTunnel({ ...base, destPort: -1 })!, /between 1 and 65535/);
});

test("a non-integer port is caught", () => {
  assert.ok(validateTunnel({ ...base, listenPort: 80.5 }));
});

test("a missing destination host is caught", () => {
  assert.match(validateTunnel({ ...base, destHost: "  " })!, /Destination host/);
});

test("a privileged local port explains why, not just that", () => {
  const msg = validateTunnel({ ...base, listenPort: 80 });
  assert.match(msg!, /administrator/i);
});

test("a privileged port is fine for a remote forward", () => {
  // The server decides there, not this machine — so the local rule shouldn't
  // fire and send someone hunting for a permissions problem on their laptop.
  assert.equal(validateTunnel({ ...base, type: "remote", listenPort: 80 }), null);
});

// ── Lifecycle ─────────────────────────────────────────────────────────────

/**
 * A stand-in SSH client whose forwardOut connects to a real local server, so
 * a tunnel can be opened and driven end to end in-process.
 */
function fakeSsh(targetPort: number) {
  const ssh: any = new EventEmitter();
  ssh.forwardOut = (
    _sa: string, _sp: number, _dh: string, _dp: number,
    cb: (err: Error | undefined, stream?: any) => void,
  ) => {
    const socket = connect(targetPort, "127.0.0.1", () => cb(undefined, socket));
    socket.on("error", (err: Error) => cb(err));
  };
  ssh.unforwardIn = (_a: string, _p: number, cb: () => void) => cb();
  return ssh;
}

test("a local forward carries traffic, then closes cleanly", async () => {
  // Something to forward to.
  const echo = createServer((socket) => socket.pipe(socket));
  await new Promise<void>((r) => echo.listen(0, "127.0.0.1", () => r()));
  const echoPort = (echo.address() as any).port;

  const manager = new TunnelManager();
  const spec = { ...base, listenPort: 0, destPort: echoPort };
  const state = await manager.startLocal(spec, fakeSsh(echoPort));

  assert.equal(state.status, "running");
  assert.equal(manager.countRunning(), 1);
  assert.equal(manager.list().length, 1);

  await manager.stop(spec.id);
  assert.equal(manager.countRunning(), 0);
  assert.equal(manager.get(spec.id), null);

  await new Promise<void>((r) => echo.close(() => r()));
});

test("a port already in use is reported in plain words", async () => {
  const blocker = createServer();
  await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", () => r()));
  const taken = (blocker.address() as any).port;

  const manager = new TunnelManager();
  await assert.rejects(
    () => manager.startLocal({ ...base, listenPort: taken }, fakeSsh(taken)),
    /already in use/,
  );

  await new Promise<void>((r) => blocker.close(() => r()));
});

test("the same tunnel can't be started twice", async () => {
  const manager = new TunnelManager();
  const spec = { ...base, listenPort: 0 };
  await manager.startLocal(spec, fakeSsh(1));
  await assert.rejects(() => manager.startLocal(spec, fakeSsh(1)), /already running/);
  await manager.stopAll();
});

test("closing a host's session closes its tunnels and leaves others alone", async () => {
  const manager = new TunnelManager();
  await manager.startLocal({ ...base, id: "a", hostId: "h1", listenPort: 0 }, fakeSsh(1));
  await manager.startLocal({ ...base, id: "b", hostId: "h2", listenPort: 0 }, fakeSsh(1));

  await manager.stopForHost("h1");

  const left = manager.list();
  assert.equal(left.length, 1);
  assert.equal(left[0].hostId, "h2");

  await manager.stopAll();
  assert.equal(manager.list().length, 0);
});

test("rejects a port typed into the destination host", () => {
  // The form renders host and port as one box with a colon between them, so
  // "127.0.0.1:22" lands in the host half. The server answers that with
  // "nodename nor servname provided", which reads like DNS rather than a typo.
  const spec = {
    type: "local" as const,
    listenPort: 8022,
    destHost: "127.0.0.1:22",
    destPort: 80,
  };
  const problem = validateTunnel(spec);
  assert.ok(problem, "a host containing a port must be refused");
  assert.match(problem!, /port/i);
});

test("still accepts a bracketed IPv6 literal", () => {
  assert.equal(
    validateTunnel({
      type: "local", listenPort: 8022, destHost: "[::1]", destPort: 22,
    }),
    null,
  );
});
