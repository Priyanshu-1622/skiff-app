/**
 * Headless smoke test for the IPC handler layer.
 *
 * Electron can't run in CI without a display, but the handlers themselves are
 * plain functions over the engine — the only Electron dependency is ipcMain,
 * which lives in registry.ts and is not imported here. So we can exercise the
 * real vault, database and host logic directly and prove the port works
 * before ever launching a window.
 *
 * This is the test that would have caught the signature mismatches found
 * during the port (provisionUser, decrypt arity, SessionUser.isAdmin) at the
 * cost of one command instead of a manual click-through.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEngine, destroyEngine } from "../src/main/engine.js";
import { registerAuthHandlers } from "../src/main/ipc/auth.js";
import { registerDataHandlers } from "../src/main/ipc/data.js";
import { registerTeamHandlers } from "../src/main/ipc/team.js";
import { registerSettingsHandlers } from "../src/main/ipc/settings.js";

function tempEngine() {
  const dir = mkdtempSync(join(tmpdir(), "skiff-ipc-"));
  const engine = createEngine(dir);
  return {
    engine,
    dir,
    cleanup: () => {
      destroyEngine(engine);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Unwrap a handler result, asserting success. */
async function call(handlers: any, channel: string, payload?: unknown) {
  const handler = handlers[channel];
  assert.ok(handler, `no handler registered for ${channel}`);
  return await handler(payload);
}

test("vault: starts uninitialized", async () => {
  const { engine, cleanup } = tempEngine();
  try {
    const auth = registerAuthHandlers(engine);
    const status = await call(auth, "vault:status");
    assert.equal(status.initialized, false);
    assert.equal(status.unlocked, false);
  } finally {
    cleanup();
  }
});

test("vault: setup then status reports initialized and unlocked", async () => {
  const { engine, cleanup } = tempEngine();
  try {
    const auth = registerAuthHandlers(engine);
    await call(auth, "vault:setup", {
      password: "correct-horse-battery",
      mode: "personal",
    });
    const status = await call(auth, "vault:status");
    assert.equal(status.initialized, true);
    assert.equal(status.unlocked, true);
    assert.equal(status.mode, "personal");
    // Personal vaults default recording off.
    assert.equal(status.recordingEnabled, false);
  } finally {
    cleanup();
  }
});

test("vault: lock then unlock with the right passphrase", async () => {
  const { engine, cleanup } = tempEngine();
  try {
    const auth = registerAuthHandlers(engine);
    await call(auth, "vault:setup", { password: "correct-horse-battery" });

    await call(auth, "vault:lock");
    let status = await call(auth, "vault:status");
    assert.equal(status.unlocked, false, "lock must actually lock");

    await call(auth, "vault:unlock", { password: "correct-horse-battery" });
    status = await call(auth, "vault:status");
    assert.equal(status.unlocked, true);
  } finally {
    cleanup();
  }
});

test("vault: wrong passphrase is rejected and leaves vault locked", async () => {
  const { engine, cleanup } = tempEngine();
  try {
    const auth = registerAuthHandlers(engine);
    await call(auth, "vault:setup", { password: "correct-horse-battery" });
    await call(auth, "vault:lock");

    await assert.rejects(
      () => call(auth, "vault:unlock", { password: "wrong-password" }),
      /incorrect password/i,
    );
    const status = await call(auth, "vault:status");
    assert.equal(status.unlocked, false);
  } finally {
    cleanup();
  }
});

test("data: handlers refuse to work while the vault is locked", async () => {
  const { engine, cleanup } = tempEngine();
  try {
    const auth = registerAuthHandlers(engine);
    const data = registerDataHandlers(engine);
    await call(auth, "vault:setup", { password: "correct-horse-battery" });
    await call(auth, "vault:lock");

    await assert.rejects(() => call(data, "hosts:list"), /locked/i);
    await assert.rejects(() => call(data, "folders:list"), /locked/i);
  } finally {
    cleanup();
  }
});

test("hosts: create, list, get, update, delete round-trip", async () => {
  const { engine, cleanup } = tempEngine();
  try {
    const auth = registerAuthHandlers(engine);
    const data = registerDataHandlers(engine);
    await call(auth, "vault:setup", { password: "correct-horse-battery" });

    const { id } = await call(data, "hosts:create", {
      label: "web-01",
      hostname: "web-01.iad.internal",
      port: 22,
      username: "deploy",
      credential: { kind: "password", secret: "s3cret" },
    });
    assert.ok(id);

    const list = await call(data, "hosts:list");
    assert.equal(list.length, 1);
    assert.equal(list[0].label, "web-01");

    const got = await call(data, "hosts:get", { id });
    assert.equal(got.hostname, "web-01.iad.internal");
    // The credential must be stored encrypted, never in the host row.
    assert.ok(got.credential_id, "credential should be linked");
    assert.equal((got as any).secret, undefined);

    await call(data, "hosts:update", {
      id,
      label: "web-01-renamed",
      hostname: "web-01.iad.internal",
      port: 2222,
      username: "deploy",
    });
    const updated = await call(data, "hosts:get", { id });
    assert.equal(updated.label, "web-01-renamed");
    assert.equal(updated.port, 2222);

    await call(data, "hosts:delete", { id });
    assert.equal((await call(data, "hosts:list")).length, 0);
  } finally {
    cleanup();
  }
});

test("hosts: credential secret is encrypted at rest", async () => {
  const { engine, cleanup } = tempEngine();
  try {
    const auth = registerAuthHandlers(engine);
    const data = registerDataHandlers(engine);
    await call(auth, "vault:setup", { password: "correct-horse-battery" });

    await call(data, "hosts:create", {
      label: "db",
      hostname: "db.internal",
      port: 22,
      username: "postgres",
      credential: { kind: "password", secret: "PLAINTEXT_MARKER" },
    });

    const row = engine.db.raw
      .prepare("SELECT encrypted_blob FROM credentials LIMIT 1")
      .get() as { encrypted_blob: Buffer };
    const asText = Buffer.from(row.encrypted_blob).toString("utf-8");
    assert.ok(
      !asText.includes("PLAINTEXT_MARKER"),
      "secret must not be recoverable from the stored blob",
    );
  } finally {
    cleanup();
  }
});

test("folders: create, update, delete", async () => {
  const { engine, cleanup } = tempEngine();
  try {
    const auth = registerAuthHandlers(engine);
    const data = registerDataHandlers(engine);
    await call(auth, "vault:setup", { password: "correct-horse-battery" });

    const { id } = await call(data, "folders:create", { name: "Production" });
    assert.equal((await call(data, "folders:list")).length, 1);

    await call(data, "folders:update", { id, name: "Prod" });
    const folders = await call(data, "folders:list");
    assert.equal(folders[0].name, "Prod");

    await call(data, "folders:delete", { id });
    assert.equal((await call(data, "folders:list")).length, 0);
  } finally {
    cleanup();
  }
});

test("settings: idle timeout persists and updates the session store", async () => {
  const { engine, cleanup } = tempEngine();
  try {
    const auth = registerAuthHandlers(engine);
    const data = registerDataHandlers(engine);
    await call(auth, "vault:setup", { password: "correct-horse-battery" });

    await call(data, "settings:idleTimeout", { minutes: 45 });
    const status = await call(auth, "vault:status");
    assert.equal(status.idleTimeoutMinutes, 45);
  } finally {
    cleanup();
  }
});

test("settings: recording toggle persists", async () => {
  const { engine, cleanup } = tempEngine();
  try {
    const auth = registerAuthHandlers(engine);
    const data = registerDataHandlers(engine);
    await call(auth, "vault:setup", { password: "correct-horse-battery" });

    await call(data, "settings:recording", { enabled: true });
    const status = await call(auth, "vault:status");
    assert.equal(status.recordingEnabled, true);
  } finally {
    cleanup();
  }
});

test("team mode: setup provisions an admin user", async () => {
  const { engine, cleanup } = tempEngine();
  try {
    const auth = registerAuthHandlers(engine);
    await call(auth, "vault:setup", {
      password: "correct-horse-battery",
      mode: "team",
      username: "priyanshu",
    });

    const status = await call(auth, "vault:status");
    assert.equal(status.mode, "team");
    // Team vaults default recording ON — the mode-aware default from v0.3.
    assert.equal(status.recordingEnabled, true);

    const user = engine.db.raw
      .prepare("SELECT username, is_admin FROM users")
      .get() as { username: string; is_admin: number };
    assert.equal(user.username, "priyanshu");
    assert.equal(user.is_admin, 1);
  } finally {
    cleanup();
  }
});

test("audit: vault and host actions are recorded", async () => {
  const { engine, cleanup } = tempEngine();
  try {
    const auth = registerAuthHandlers(engine);
    const data = registerDataHandlers(engine);
    await call(auth, "vault:setup", { password: "correct-horse-battery" });
    await call(data, "hosts:create", {
      label: "h",
      hostname: "h.internal",
      port: 22,
      username: "u",
    });

    const actions = (
      engine.db.raw.prepare("SELECT action FROM audit_log").all() as Array<{
        action: string;
      }>
    ).map((r) => r.action);

    assert.ok(actions.includes("vault.setup"));
    assert.ok(actions.includes("host.create"));
  } finally {
    cleanup();
  }
});

test("vault: repeated failures lock out, and success clears prior failures", async () => {
  const { engine, cleanup } = tempEngine();
  try {
    const auth = registerAuthHandlers(engine);
    await call(auth, "vault:setup", { password: "correct-horse-battery" });
    await call(auth, "vault:lock");

    // Four failures is under the threshold, so a correct password should
    // still work — and must clear the failed attempts behind it. This is the
    // regression guard for the lockout bug fixed in PR #4: without the
    // clearing DELETE, stale failures accumulate and eventually lock out a
    // user who has been typing the right password all along.
    for (let i = 0; i < 4; i++) {
      await assert.rejects(() =>
        call(auth, "vault:unlock", { password: "wrong" }),
      );
    }
    await call(auth, "vault:unlock", { password: "correct-horse-battery" });

    const remaining = engine.db.raw
      .prepare("SELECT COUNT(*) AS cnt FROM unlock_attempts WHERE succeeded = 0")
      .get() as { cnt: number };
    assert.equal(remaining.cnt, 0, "successful unlock must clear failures");
  } finally {
    cleanup();
  }
});

test("vault: team vaults refuse the personal unlock path", async () => {
  const { engine, cleanup } = tempEngine();
  try {
    const auth = registerAuthHandlers(engine);
    await call(auth, "vault:setup", {
      password: "correct-horse-battery",
      mode: "team",
      username: "priyanshu",
    });
    await call(auth, "vault:lock");

    // Unlocking a team vault without a username would create a session with
    // no identity, making every subsequent audit entry unattributable.
    await assert.rejects(
      () => call(auth, "vault:unlock", { password: "correct-horse-battery" }),
      /team vault/i,
    );
  } finally {
    cleanup();
  }
});

// ── Team handlers ────────────────────────────────────────────────────────

test("team: login with correct credentials establishes an identity", async () => {
  const { engine, cleanup } = tempEngine();
  try {
    const auth = registerAuthHandlers(engine);
    const team = registerTeamHandlers(engine);
    await call(auth, "vault:setup", {
      password: "correct-horse-battery",
      mode: "team",
      username: "priyanshu",
    });
    await call(auth, "vault:lock");

    const res = await call(team, "team:login", {
      username: "priyanshu",
      password: "correct-horse-battery",
    });
    assert.equal(res.user.username, "priyanshu");
    assert.equal(res.user.isAdmin, true);

    // The session must carry the identity, or audit entries are unattributable.
    const status = await call(auth, "vault:status");
    assert.equal(status.unlocked, true);
    assert.equal(status.user?.username, "priyanshu");
  } finally {
    cleanup();
  }
});

test("team: login rejects wrong password and unknown users alike", async () => {
  const { engine, cleanup } = tempEngine();
  try {
    const auth = registerAuthHandlers(engine);
    const team = registerTeamHandlers(engine);
    await call(auth, "vault:setup", {
      password: "correct-horse-battery",
      mode: "team",
      username: "priyanshu",
    });
    await call(auth, "vault:lock");

    await assert.rejects(
      () => call(team, "team:login", { username: "priyanshu", password: "wrong" }),
      /invalid credentials/i,
    );
    // Unknown usernames get the identical message, so the error doesn't
    // confirm which accounts exist.
    await assert.rejects(
      () => call(team, "team:login", { username: "nobody", password: "wrong" }),
      /invalid credentials/i,
    );
  } finally {
    cleanup();
  }
});

test("team: admin can create a member who can then log in", async () => {
  const { engine, cleanup } = tempEngine();
  try {
    const auth = registerAuthHandlers(engine);
    const team = registerTeamHandlers(engine);
    await call(auth, "vault:setup", {
      password: "admin-password-1",
      mode: "team",
      username: "admin",
    });

    await call(team, "team:userCreate", {
      username: "member",
      tempPassword: "member-temp-1",
      isAdmin: false,
    });

    // The new member's password unseals the SAME shared key, which is what
    // makes adding people cheap — no credential is ever re-encrypted.
    await call(auth, "vault:lock");
    const res = await call(team, "team:login", {
      username: "member",
      password: "member-temp-1",
    });
    assert.equal(res.user.isAdmin, false);
  } finally {
    cleanup();
  }
});

test("team: duplicate usernames are rejected", async () => {
  const { engine, cleanup } = tempEngine();
  try {
    const auth = registerAuthHandlers(engine);
    const team = registerTeamHandlers(engine);
    await call(auth, "vault:setup", {
      password: "admin-password-1",
      mode: "team",
      username: "admin",
    });
    await assert.rejects(
      () =>
        call(team, "team:userCreate", {
          username: "admin",
          tempPassword: "another-password",
        }),
      /already taken/i,
    );
  } finally {
    cleanup();
  }
});

test("team: the last active admin cannot be disabled", async () => {
  const { engine, cleanup } = tempEngine();
  try {
    const auth = registerAuthHandlers(engine);
    const team = registerTeamHandlers(engine);
    await call(auth, "vault:setup", {
      password: "admin-password-1",
      mode: "team",
      username: "admin",
    });
    const member = await call(team, "team:userCreate", {
      username: "member",
      tempPassword: "member-temp-1",
    });

    // Disabling a non-admin is fine.
    await call(team, "team:userSetDisabled", { id: member.id, disabled: true });

    // Disabling yourself, or the only admin, would lock the vault out of
    // administration entirely.
    const admin = engine.db.raw
      .prepare("SELECT id FROM users WHERE username = 'admin'")
      .get() as { id: string };
    await assert.rejects(
      () => call(team, "team:userSetDisabled", { id: admin.id, disabled: true }),
      /cannot disable yourself/i,
    );
  } finally {
    cleanup();
  }
});

test("team: reprovision resets a member's password", async () => {
  const { engine, cleanup } = tempEngine();
  try {
    const auth = registerAuthHandlers(engine);
    const team = registerTeamHandlers(engine);
    await call(auth, "vault:setup", {
      password: "admin-password-1",
      mode: "team",
      username: "admin",
    });
    const member = await call(team, "team:userCreate", {
      username: "member",
      tempPassword: "member-temp-1",
    });

    await call(team, "team:userReprovision", {
      id: member.id,
      tempPassword: "member-temp-2",
    });

    await call(auth, "vault:lock");
    // Old password no longer works; new one does.
    await assert.rejects(() =>
      call(team, "team:login", { username: "member", password: "member-temp-1" }),
    );
    const res = await call(team, "team:login", {
      username: "member",
      password: "member-temp-2",
    });
    assert.equal(res.user.username, "member");
  } finally {
    cleanup();
  }
});

// ── Import & settings ────────────────────────────────────────────────────

const SSH_CONFIG = `
# comment line
Host web-01
  HostName web-01.iad.internal
  User deploy
  Port 2222

Host *
  ServerAliveInterval 60

Host db-01
  HostName db-01.iad.internal
  User postgres
`;

test("import: parses ssh config text, skipping wildcard blocks", async () => {
  const { engine, cleanup } = tempEngine();
  try {
    const auth = registerAuthHandlers(engine);
    const settings = registerSettingsHandlers(engine);
    await call(auth, "vault:setup", { password: "correct-horse-battery" });

    const { hosts } = await call(settings, "import:parse", {
      configText: SSH_CONFIG,
    });
    assert.equal(hosts.length, 2, "the `Host *` block must not become a host");
    assert.equal(hosts[0].alias, "web-01");
    assert.equal(hosts[0].port, 2222);
    assert.equal(hosts[1].user, "postgres");
  } finally {
    cleanup();
  }
});

test("import: apply creates hosts, honouring the selection", async () => {
  const { engine, cleanup } = tempEngine();
  try {
    const auth = registerAuthHandlers(engine);
    const data = registerDataHandlers(engine);
    const settings = registerSettingsHandlers(engine);
    await call(auth, "vault:setup", { password: "correct-horse-battery" });

    const res = await call(settings, "import:apply", {
      configText: SSH_CONFIG,
      selectedHosts: ["web-01"],
    });
    assert.equal(res.created, 1);

    const hosts = await call(data, "hosts:list");
    assert.equal(hosts.length, 1);
    assert.equal(hosts[0].label, "web-01");
    assert.equal(hosts[0].port, 2222);
    // Imported entries carry no secret material.
    assert.equal(hosts[0].credential_id, null);
  } finally {
    cleanup();
  }
});

test("import: rejects a relative config path", async () => {
  const { engine, cleanup } = tempEngine();
  try {
    const auth = registerAuthHandlers(engine);
    const settings = registerSettingsHandlers(engine);
    await call(auth, "vault:setup", { password: "correct-horse-battery" });

    // A relative path is how a compromised renderer would try to traverse
    // out of the intended directory.
    await assert.rejects(
      () => call(settings, "import:parse", { path: "../../etc/passwd" }),
      /absolute/i,
    );
  } finally {
    cleanup();
  }
});

test("settings: password change re-encrypts credentials and keeps them readable", async () => {
  const { engine, cleanup } = tempEngine();
  try {
    const auth = registerAuthHandlers(engine);
    const data = registerDataHandlers(engine);
    const settings = registerSettingsHandlers(engine);
    await call(auth, "vault:setup", { password: "old-password-1" });

    await call(data, "hosts:create", {
      label: "web",
      hostname: "web.internal",
      port: 22,
      username: "deploy",
      credential: { kind: "password", secret: "the-ssh-secret" },
    });

    await call(settings, "settings:changePassword", {
      currentPassword: "old-password-1",
      newPassword: "new-password-2",
    });

    // The old password must stop working and the new one must unlock a vault
    // whose credentials are still decryptable — the whole point of doing the
    // re-encryption inside one transaction.
    await call(auth, "vault:lock");
    await assert.rejects(() =>
      call(auth, "vault:unlock", { password: "old-password-1" }),
    );
    await call(auth, "vault:unlock", { password: "new-password-2" });

    const hosts = await call(data, "hosts:list");
    assert.equal(hosts.length, 1);
  } finally {
    cleanup();
  }
});

test("settings: password change is refused in team mode", async () => {
  const { engine, cleanup } = tempEngine();
  try {
    const auth = registerAuthHandlers(engine);
    const settings = registerSettingsHandlers(engine);
    await call(auth, "vault:setup", {
      password: "admin-password-1",
      mode: "team",
      username: "admin",
    });

    await assert.rejects(
      () =>
        call(settings, "settings:changePassword", {
          currentPassword: "admin-password-1",
          newPassword: "new-password-2",
        }),
      /team mode/i,
    );
  } finally {
    cleanup();
  }
});

test("settings: backup exports encrypted credentials, never plaintext", async () => {
  const { engine, cleanup } = tempEngine();
  try {
    const auth = registerAuthHandlers(engine);
    const data = registerDataHandlers(engine);
    const settings = registerSettingsHandlers(engine);
    await call(auth, "vault:setup", { password: "correct-horse-battery" });
    await call(data, "hosts:create", {
      label: "web",
      hostname: "web.internal",
      port: 22,
      username: "deploy",
      credential: { kind: "password", secret: "PLAINTEXT_MARKER" },
    });

    const backup = await call(settings, "settings:backup");
    assert.equal(backup.version, 1);
    assert.equal(backup.hosts.length, 1);
    assert.ok(
      !JSON.stringify(backup).includes("PLAINTEXT_MARKER"),
      "a backup must never contain a decrypted secret",
    );
  } finally {
    cleanup();
  }
});

test("settings: restore is refused over an existing vault", async () => {
  const { engine, cleanup } = tempEngine();
  try {
    const auth = registerAuthHandlers(engine);
    const settings = registerSettingsHandlers(engine);
    await call(auth, "vault:setup", { password: "correct-horse-battery" });

    // Restoring into a live vault would mix credentials encrypted under two
    // different keys, producing rows that can never be decrypted.
    await assert.rejects(
      () => call(settings, "settings:restore", { version: 1, vaultMeta: {} }),
      /fresh vault/i,
    );
  } finally {
    cleanup();
  }
});
