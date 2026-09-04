/**
 * SSH agent discovery.
 *
 * Its own file, not ipc.test.ts: that one builds a real engine and so needs
 * the better-sqlite3 shim, which is backed by node:sqlite and therefore Node
 * 22. These are pure and run anywhere.
 *
 * `probe` used to be synchronous, backed by `fs.existsSync` against the named
 * pipe. Tested only against mocks, it looked right; tested against a real,
 * running Windows agent for the first time, it reported no agent at all. A
 * live pipe with a server listening answers a stat with `EBUSY`, not
 * `ENOENT`, because it is not a stat-able file the way a regular one is —
 * `existsSync` swallows that and returns `false` regardless. `probe` is now
 * async, backed by an actual `net.connect` attempt, which is the only thing
 * that told the two cases apart correctly. Kept injectable so these tests
 * still run without a real pipe.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveAgentSocket, WINDOWS_AGENT_PIPE } from "../src/main/ipc/terminal.js";

test("agent: an explicit SSH_AUTH_SOCK wins on every platform", async () => {
  const never = async () => false;
  assert.equal(await resolveAgentSocket("linux", { SSH_AUTH_SOCK: "/tmp/a.sock" }, never), "/tmp/a.sock");
  assert.equal(await resolveAgentSocket("win32", { SSH_AUTH_SOCK: "//./pipe/custom" }, never), "//./pipe/custom");
});

test("agent: no socket and no pipe reports no agent, rather than a phantom one", async () => {
  assert.equal(await resolveAgentSocket("linux", {}, async () => false), null);
  // The original regression: this returned the pipe path unconditionally.
  assert.equal(await resolveAgentSocket("win32", {}, async () => false), null);
});

test("agent: the Windows pipe is used only when the probe actually connects", async () => {
  const seen: string[] = [];
  const probe = async (p: string) => { seen.push(p); return true; };
  assert.equal(await resolveAgentSocket("win32", {}, probe), WINDOWS_AGENT_PIPE);
  assert.deepEqual(seen, [WINDOWS_AGENT_PIPE]);
});

test("agent: a probe that rejects is treated as no agent", async () => {
  assert.equal(
    await resolveAgentSocket("win32", {}, () => Promise.reject(new Error("EPERM"))),
    null,
  );
});

test("agent: a probe that throws synchronously is treated as no agent", async () => {
  assert.equal(
    await resolveAgentSocket("win32", {}, () => { throw new Error("EPERM"); }),
    null,
  );
});
