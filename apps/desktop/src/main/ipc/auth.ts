/**
 * Vault lifecycle over IPC: status, setup, unlock, lock.
 *
 * The big difference from the server build is how the session is identified.
 * On the server, the session id travelled in a signed cookie, because many
 * browsers could talk to one API and each needed its own unlock state. That
 * whole mechanism is meaningless here: one process, one window, one human.
 *
 * So the desktop keeps a single module-level `currentSessionId`. There is no
 * cookie to forge, no CSRF surface, and no "cookie attributes didn't match on
 * clear" class of bug — which is exactly the bug that bit the v0.3 logout
 * button. Locking is now just dropping a variable and destroying the store
 * entry; it cannot half-succeed.
 */

import { z } from "zod";
import { timingSafeEqual } from "node:crypto";
import {
  SCHEMA_VERSION,
  computeVerifier,
  deriveVaultKey,
  generateId,
  generateKdfParams,
  generateSharedKey,
  provisionUser,
  writeAudit,
} from "@skiff/core";
import { ApiErrorCode } from "@skiff/shared";
import type { EngineContext } from "../engine.js";
import { fail, type Handlers } from "./contract.js";
import { tunnelManager } from "./tunnels.js";

const PasswordBody = z.object({ password: z.string().min(1).max(256) });
const SetupBody = z.object({
  password: z.string().min(8).max(256),
  mode: z.enum(["personal", "team"]).default("personal"),
  username: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9._-]+$/)
    .optional(),
});

/** The one unlocked session for this desktop process. */
let currentSessionId: string | null = null;

export function getSessionId(): string | null {
  return currentSessionId;
}

/**
 * Adopt a session created elsewhere (team login unseals the shared key and
 * creates the store entry itself, since it needs the user identity to hand to
 * SessionStore.create).
 */
export function setSession(sessionId: string): void {
  currentSessionId = sessionId;
}

/**
 * Resolve the vault key for the active session, or throw VAULT_LOCKED.
 * Every handler that touches encrypted data goes through this.
 */
export function requireVaultKey(engine: EngineContext): Buffer {
  if (!currentSessionId) fail(ApiErrorCode.VAULT_LOCKED, "Vault is locked");
  const key = engine.sessionStore.get(currentSessionId);
  if (!key) {
    // The store expired the session on its idle timer.
    currentSessionId = null;
    fail(ApiErrorCode.VAULT_LOCKED, "Vault is locked");
  }
  return key;
}

export function currentUser(engine: EngineContext) {
  if (!currentSessionId) return null;
  return engine.sessionStore.getEntry(currentSessionId)?.user ?? null;
}

export function clearSession(engine: EngineContext): void {
  if (currentSessionId) engine.sessionStore.destroy(currentSessionId);
  currentSessionId = null;
}

export function registerAuthHandlers(engine: EngineContext): Handlers {
  const db = engine.db.raw;

  return {
    "vault:status": async () => {
      const meta = db.prepare("SELECT * FROM vault_meta WHERE id = 1").get() as
        | {
            idle_timeout_minutes: number;
            mode?: string;
            recording_enabled?: number;
          }
        | undefined;
      const entry = currentSessionId
        ? engine.sessionStore.getEntry(currentSessionId)
        : null;
      // If the store expired it out from under us, reflect that.
      if (currentSessionId && !entry) currentSessionId = null;

      return {
        initialized: !!meta,
        unlocked: !!entry,
        mode: meta?.mode ?? "personal",
        idleTimeoutMinutes: meta?.idle_timeout_minutes ?? 15,
        recordingEnabled: !!meta?.recording_enabled,
        guardrailsEnabled: !!(meta as any)?.guardrails_enabled,
        trayEnabled: (meta as any)?.tray_enabled === undefined ? true : !!(meta as any).tray_enabled,
        user: entry?.user ?? null,
      };
    },

    "vault:setup": async (payload) => {
      const parsed = SetupBody.safeParse(payload);
      if (!parsed.success) {
        fail(ApiErrorCode.VALIDATION_FAILED, "Invalid setup payload");
      }
      const { password, mode, username } = parsed.data;

      const existing = db.prepare("SELECT id FROM vault_meta WHERE id = 1").get();
      if (existing) {
        fail(ApiErrorCode.CONFLICT, "Vault already initialized");
      }
      if (mode === "team" && !username) {
        fail(ApiErrorCode.VALIDATION_FAILED, "username is required for team mode");
      }

      const now = new Date().toISOString();

      if (mode === "team" && username) {
        // Team vaults have a shared key that every member's own password
        // unseals. provisionUser derives the member KEK and returns the
        // sealed material; it does not write any rows itself.
        const sharedKey = generateSharedKey();
        const provisioned = await provisionUser(password, sharedKey);

        db.prepare(
          `INSERT INTO vault_meta (id, schema_version, kdf_salt, kdf_iterations, kdf_memory_kib, kdf_parallelism, verifier, mode, recording_enabled, created_at)
           VALUES (1, ?, ?, ?, ?, ?, ?, 'team', 1, ?)`,
        ).run(
          SCHEMA_VERSION,
          provisioned.kdf.salt,
          provisioned.kdf.iterations,
          provisioned.kdf.memoryKib,
          provisioned.kdf.parallelism,
          provisioned.verifier,
          now,
        );

        const userId = generateId("usr");
        db.prepare(
          `INSERT INTO users (id, username, display_name, kdf_salt, kdf_iterations, kdf_memory_kib, kdf_parallelism, verifier, shared_key_blob, shared_key_nonce, is_admin, disabled, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?)`,
        ).run(
          userId,
          username,
          null,
          provisioned.kdf.salt,
          provisioned.kdf.iterations,
          provisioned.kdf.memoryKib,
          provisioned.kdf.parallelism,
          provisioned.verifier,
          provisioned.sharedKeyBlob,
          provisioned.sharedKeyNonce,
          now,
        );

        const sessionUser = { id: userId, username, isAdmin: true };
        currentSessionId = engine.sessionStore.create(sharedKey, sessionUser);
        // The session store holds its own copy; zero ours so the raw shared
        // key does not linger in this scope's memory.
        sharedKey.fill(0);
        writeAudit(db, {
          user: sessionUser,
          action: "vault.setup",
          detail: { mode: "team" },
        });
        return { ok: true, mode };
      }

      // Personal mode: the vault key is derived directly from the password.
      const params = generateKdfParams();
      const vaultKey = await deriveVaultKey(password, params);
      const verifier = computeVerifier(vaultKey);

      db.prepare(
        `INSERT INTO vault_meta (id, schema_version, kdf_salt, kdf_iterations, kdf_memory_kib, kdf_parallelism, verifier, mode, created_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, 'personal', ?)`,
      ).run(
        SCHEMA_VERSION,
        params.salt,
        params.iterations,
        params.memoryKib,
        params.parallelism,
        verifier,
        now,
      );

      currentSessionId = engine.sessionStore.create(vaultKey);
      writeAudit(db, { action: "vault.setup", detail: { mode: "personal" } });
      return { ok: true, mode };
    },

    "vault:unlock": async (payload) => {
      const parsed = PasswordBody.safeParse(payload);
      if (!parsed.success) {
        fail(ApiErrorCode.VALIDATION_FAILED, "Password required");
      }

      const meta = db.prepare("SELECT * FROM vault_meta WHERE id = 1").get() as
        | {
            kdf_salt: Buffer;
            kdf_iterations: number;
            kdf_memory_kib: number;
            kdf_parallelism: number;
            verifier: Buffer;
            mode?: string;
          }
        | undefined;
      if (!meta) {
        fail(ApiErrorCode.VAULT_NOT_INITIALIZED, "Run setup first");
      }
      // Team vaults unlock per-user through team:login, which establishes an
      // identity for audit attribution. Unlocking without one would produce
      // unattributable audit entries.
      if (meta.mode === "team") {
        fail(
          ApiErrorCode.WRONG_MODE,
          "This is a team vault - sign in with your username",
        );
      }

      const recentFails = db
        .prepare(
          "SELECT COUNT(*) as cnt FROM unlock_attempts WHERE succeeded = 0 AND attempted_at > datetime('now', '-5 minutes')",
        )
        .get() as { cnt: number };
      if (recentFails.cnt >= 5) {
        fail(
          ApiErrorCode.RATE_LIMITED,
          "Too many failed attempts. Try again later.",
        );
      }

      const vaultKey = await deriveVaultKey(parsed.data.password, {
        algorithm: "argon2id",
        salt: Buffer.from(meta.kdf_salt),
        iterations: meta.kdf_iterations,
        memoryKib: meta.kdf_memory_kib,
        parallelism: meta.kdf_parallelism,
      });

      const verifier = computeVerifier(vaultKey);
      // timingSafeEqual, not .equals(): Buffer.equals returns on the first
      // differing byte, so how long it takes leaks how much of the verifier
      // matched. Argon2 dominates the timing here so this is not practically
      // exploitable, but a password comparison in a security tool should not
      // be the place we rely on that argument.
      const a = Buffer.from(verifier);
      const b = Buffer.from(meta.verifier);
      const valid = a.length === b.length && timingSafeEqual(a, b);

      db.prepare(
        "INSERT INTO unlock_attempts (attempted_at, succeeded) VALUES (datetime('now'), ?)",
      ).run(valid ? 1 : 0);
      // Keep the table from growing forever.
      db.prepare(
        "DELETE FROM unlock_attempts WHERE attempted_at < datetime('now', '-1 day')",
      ).run();

      if (!valid) {
        vaultKey.fill(0);
        fail(ApiErrorCode.INVALID_PASSWORD, "Incorrect password");
      }

      // A successful unlock clears prior failures so a legitimate user is not
      // locked out by stale attempts (this is the PR #4 fix, preserved).
      db.prepare("DELETE FROM unlock_attempts WHERE succeeded = 0").run();

      currentSessionId = engine.sessionStore.create(vaultKey);
      writeAudit(db, { action: "vault.unlock" });
      return { ok: true };
    },

    "vault:lock": async () => {
      const user = currentUser(engine);
      // End live SSH sessions too. Leaving them running while the vault is
      // locked would keep decrypted credentials reachable in memory and let
      // an unattended machine stay connected to production.
      engine.sessionManager.shutdown();
      // Tunnels too, for the same reason and more sharply: a local forward to
      // a production database keeps working after the vault is locked, so
      // locking an unattended machine would leave port 5432 answering. The
      // lock has to mean the machine is closed, not just the UI.
      void tunnelManager.stopAll();
      clearSession(engine);
      writeAudit(db, { action: "vault.lock", user: user ?? undefined });
      return { ok: true };
    },
  };
}
