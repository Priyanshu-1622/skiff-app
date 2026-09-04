/**
 * Team mode over IPC: login and user management.
 *
 * Team vaults work differently from personal ones. A personal vault derives
 * its key straight from the master password. A team vault has one shared key
 * that every member's own password unseals — so adding a member never
 * re-encrypts anything, and removing one never requires a re-key.
 *
 * This is also why team vaults refuse the personal `vault:unlock` path: a
 * session created there would carry no user identity, and every audit entry
 * written during it would be unattributable. Attribution is the point of team
 * mode, so the identity has to be established at unlock time.
 */

import { z } from "zod";
import {
  generateId,
  provisionUser,
  unlockSharedKey,
  writeAudit,
} from "@skiff/core";
import { ApiErrorCode } from "@skiff/shared";
import type { EngineContext } from "../engine.js";
import { fail, type Handlers } from "./contract.js";
import { setSession, currentUser, requireVaultKey } from "./auth.js";

const LoginBody = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
});

const CreateUserBody = z.object({
  username: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9._-]+$/),
  tempPassword: z.string().min(8).max(256),
  displayName: z.string().max(120).optional(),
  isAdmin: z.boolean().default(false),
});

const ReprovisionBody = z.object({
  id: z.string().min(1),
  tempPassword: z.string().min(8).max(256),
});

const SetDisabledBody = z.object({
  id: z.string().min(1),
  disabled: z.boolean(),
});

export function registerTeamHandlers(engine: EngineContext): Handlers {
  const db = engine.db.raw;

  const getMode = (): string => {
    const row = db.prepare("SELECT mode FROM vault_meta WHERE id = 1").get() as
      | { mode?: string }
      | undefined;
    return row?.mode ?? "personal";
  };

  /** Admin guard for user-management channels. */
  const requireAdmin = () => {
    requireVaultKey(engine);
    const user = currentUser(engine);
    if (!user || !user.isAdmin) {
      fail(ApiErrorCode.FORBIDDEN, "Administrator access required");
    }
    return user;
  };

  return {
    "team:login": async (payload) => {
      if (getMode() !== "team") {
        fail(ApiErrorCode.WRONG_MODE, "Not a team vault");
      }
      const parsed = LoginBody.safeParse(payload);
      if (!parsed.success) {
        fail(ApiErrorCode.VALIDATION_FAILED, "Username and password required");
      }
      const { username, password } = parsed.data;

      // Lockout is per-username rather than global, so one member fumbling
      // their password cannot lock the whole team out.
      const recentFails = db
        .prepare(
          "SELECT COUNT(*) as cnt FROM login_attempts WHERE username = ? AND succeeded = 0 AND attempted_at > datetime('now','-5 minutes')",
        )
        .get(username) as { cnt: number };
      if (recentFails.cnt >= 5) {
        fail(ApiErrorCode.RATE_LIMITED, "Too many attempts. Try later.");
      }

      const logAttempt = (succeeded: boolean) => {
        db.prepare(
          "INSERT INTO login_attempts (username, attempted_at, succeeded) VALUES (?, datetime('now'), ?)",
        ).run(username, succeeded ? 1 : 0);
        db.prepare(
          "DELETE FROM login_attempts WHERE attempted_at < datetime('now','-1 day')",
        ).run();
      };

      const user = db
        .prepare("SELECT * FROM users WHERE username = ?")
        .get(username) as any;

      // Unknown and disabled users get the same generic message as a wrong
      // password, so the response doesn't confirm which usernames exist.
      if (!user || user.disabled) {
        logAttempt(false);
        fail(ApiErrorCode.INVALID_PASSWORD, "Invalid credentials");
      }

      const sharedKey = await unlockSharedKey(
        password,
        {
          algorithm: "argon2id",
          salt: Buffer.from(user.kdf_salt),
          iterations: user.kdf_iterations,
          memoryKib: user.kdf_memory_kib,
          parallelism: user.kdf_parallelism,
        },
        Buffer.from(user.verifier),
        Buffer.from(user.shared_key_blob),
        Buffer.from(user.shared_key_nonce),
      );

      if (!sharedKey) {
        logAttempt(false);
        fail(ApiErrorCode.INVALID_PASSWORD, "Invalid credentials");
      }

      logAttempt(true);
      // A success resets this user's lockout counter — same fix as PR #4 on
      // the personal path, so stale failures can't accumulate into a lockout.
      db.prepare(
        "DELETE FROM login_attempts WHERE username = ? AND succeeded = 0",
      ).run(username);

      const sessionUser = {
        id: user.id,
        username: user.username,
        isAdmin: user.is_admin === 1,
      };
      setSession(engine.sessionStore.create(sharedKey, sessionUser));
      // The store holds its own copy; zero ours rather than leaving the raw
      // shared key reachable in this scope.
      sharedKey.fill(0);

      writeAudit(db, { user: sessionUser, action: "login" });
      return {
        user: {
          id: user.id,
          username: user.username,
          displayName: user.display_name,
          isAdmin: sessionUser.isAdmin,
        },
      };
    },

    "team:userCreate": async (payload) => {
      const admin = requireAdmin();
      const parsed = CreateUserBody.safeParse(payload);
      if (!parsed.success) {
        fail(ApiErrorCode.VALIDATION_FAILED, "Invalid user payload");
      }
      const body = parsed.data;

      const exists = db
        .prepare("SELECT id FROM users WHERE username = ?")
        .get(body.username);
      if (exists) fail(ApiErrorCode.CONFLICT, "Username already taken");

      // The admin's session key IS the shared key, so provisioning seals the
      // same shared key under the new member's temporary password.
      const vaultKey = requireVaultKey(engine);
      const provisioned = await provisionUser(body.tempPassword, vaultKey);
      const id = generateId("usr");

      try {
        db.prepare(
          `INSERT INTO users (id, username, display_name, kdf_salt, kdf_iterations, kdf_memory_kib, kdf_parallelism, verifier, shared_key_blob, shared_key_nonce, is_admin, disabled, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
        ).run(
          id,
          body.username,
          body.displayName ?? null,
          provisioned.kdf.salt,
          provisioned.kdf.iterations,
          provisioned.kdf.memoryKib,
          provisioned.kdf.parallelism,
          provisioned.verifier,
          provisioned.sharedKeyBlob,
          provisioned.sharedKeyNonce,
          body.isAdmin ? 1 : 0,
          new Date().toISOString(),
        );
      } catch (e: any) {
        if (String(e?.message).includes("UNIQUE")) {
          fail(ApiErrorCode.CONFLICT, "Username already taken");
        }
        throw e;
      }

      writeAudit(db, {
        user: admin,
        action: "user.create",
        resourceType: "user",
        resourceId: id,
        detail: { username: body.username, isAdmin: body.isAdmin },
      });
      return { id, username: body.username };
    },

    "team:userReprovision": async (payload) => {
      const admin = requireAdmin();
      const parsed = ReprovisionBody.safeParse(payload);
      if (!parsed.success) {
        fail(ApiErrorCode.VALIDATION_FAILED, "Invalid reprovision payload");
      }

      const user = db
        .prepare("SELECT * FROM users WHERE id = ?")
        .get(parsed.data.id) as any;
      if (!user) fail(ApiErrorCode.NOT_FOUND, "User not found");

      // Re-seal the shared key under a new temporary password. This is the
      // password-reset path: the member's old password stops working, but no
      // stored data has to be re-encrypted.
      const vaultKey = requireVaultKey(engine);
      const provisioned = await provisionUser(parsed.data.tempPassword, vaultKey);

      db.prepare(
        `UPDATE users SET kdf_salt = ?, kdf_iterations = ?, kdf_memory_kib = ?, kdf_parallelism = ?,
                          verifier = ?, shared_key_blob = ?, shared_key_nonce = ?
         WHERE id = ?`,
      ).run(
        provisioned.kdf.salt,
        provisioned.kdf.iterations,
        provisioned.kdf.memoryKib,
        provisioned.kdf.parallelism,
        provisioned.verifier,
        provisioned.sharedKeyBlob,
        provisioned.sharedKeyNonce,
        parsed.data.id,
      );

      // Any failed attempts from before the reset are meaningless now.
      db.prepare("DELETE FROM login_attempts WHERE username = ?").run(
        user.username,
      );

      writeAudit(db, {
        user: admin,
        action: "user.reprovision",
        resourceType: "user",
        resourceId: parsed.data.id,
        detail: { username: user.username },
      });
      return { ok: true };
    },

    "team:userSetDisabled": async (payload) => {
      const admin = requireAdmin();
      const parsed = SetDisabledBody.safeParse(payload);
      if (!parsed.success) {
        fail(ApiErrorCode.VALIDATION_FAILED, "Invalid payload");
      }

      const user = db
        .prepare("SELECT * FROM users WHERE id = ?")
        .get(parsed.data.id) as any;
      if (!user) fail(ApiErrorCode.NOT_FOUND, "User not found");

      // Disabling yourself would lock you out of your own admin session with
      // no way back in if you are the only admin.
      if (user.id === admin.id && parsed.data.disabled) {
        fail(ApiErrorCode.VALIDATION_FAILED, "You cannot disable yourself");
      }

      // Never leave the vault with no way to administer it.
      if (parsed.data.disabled && user.is_admin === 1) {
        const otherAdmins = db
          .prepare(
            "SELECT COUNT(*) as cnt FROM users WHERE is_admin = 1 AND disabled = 0 AND id != ?",
          )
          .get(user.id) as { cnt: number };
        if (otherAdmins.cnt === 0) {
          fail(
            ApiErrorCode.VALIDATION_FAILED,
            "Cannot disable the last active administrator",
          );
        }
      }

      db.prepare("UPDATE users SET disabled = ? WHERE id = ?").run(
        parsed.data.disabled ? 1 : 0,
        parsed.data.id,
      );

      writeAudit(db, {
        user: admin,
        action: parsed.data.disabled ? "user.disable" : "user.enable",
        resourceType: "user",
        resourceId: parsed.data.id,
        detail: { username: user.username },
      });
      return { ok: true };
    },
  };
}
