/**
 * Settings and SSH-config import over IPC.
 *
 * The desktop adds one capability the server could not have: `import:parse`
 * accepts an optional `path`, so the app can read `~/.ssh/config` off the
 * local disk itself instead of asking the user to paste its contents. That is
 * the first-run activation moment — "we found 23 hosts, import them?" rather
 * than "please paste your config".
 */

import { z } from "zod";
import { homedir } from "node:os";
import { join, isAbsolute } from "node:path";
import { readFile } from "node:fs/promises";
import {
  computeVerifier,
  decrypt,
  deriveVaultKey,
  encrypt,
  generateId,
  generateKdfParams,
  parseSSHConfig,
  writeAudit,
} from "@skiff/core";
import { ApiErrorCode } from "@skiff/shared";
import type { EngineContext } from "../engine.js";
import { fail, type Handlers } from "./contract.js";
import { currentUser, getSessionId, requireVaultKey, setSession } from "./auth.js";
// From device-key.js, not keychain.js: keychain.js imports Electron at the
// top level, and ESM would load that whole graph just to reach this one
// filesystem helper — which breaks the IPC tests under plain Node.
import { forgetDeviceKey } from "./device-key.js";

const ChangePasswordBody = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(256),
});

const ParseBody = z.object({
  configText: z.string().optional(),
  path: z.string().optional(),
});

const ImportBody = z.object({
  configText: z.string().optional(),
  path: z.string().optional(),
  selectedHosts: z.array(z.string()).optional(),
  folderId: z.string().nullable().default(null),
});

export function registerSettingsHandlers(engine: EngineContext): Handlers {
  const db = engine.db.raw;

  const auth = () => {
    requireVaultKey(engine);
    return currentUser(engine);
  };

  /**
   * Read an ssh config from disk, defaulting to ~/.ssh/config.
   *
   * Relative paths are rejected: the renderer should never be able to steer a
   * read at an arbitrary location by sending something like "../../secrets".
   * An explicit absolute path is a deliberate user choice (a file picker),
   * whereas a relative one is almost always an attempt to traverse.
   */
  const readConfigFile = async (path?: string): Promise<string> => {
    const target = path ?? join(homedir(), ".ssh", "config");
    if (!isAbsolute(target)) {
      fail(ApiErrorCode.VALIDATION_FAILED, "Config path must be absolute");
    }
    try {
      return await readFile(target, "utf-8");
    } catch (e: any) {
      if (e?.code === "ENOENT") {
        fail(ApiErrorCode.NOT_FOUND, `No SSH config found at ${target}`);
      }
      throw e;
    }
  };

  return {
    // ── Import ───────────────────────────────────────────────────────────
    "import:parse": async (payload) => {
      auth();
      const parsed = ParseBody.safeParse(payload ?? {});
      if (!parsed.success) fail(ApiErrorCode.VALIDATION_FAILED, "Invalid payload");

      const text =
        parsed.data.configText ?? (await readConfigFile(parsed.data.path));
      const hosts = parseSSHConfig(text);
      return { hosts, source: parsed.data.configText ? "text" : "file" };
    },

    "import:apply": async (payload) => {
      const user = auth();
      const parsed = ImportBody.safeParse(payload ?? {});
      if (!parsed.success) fail(ApiErrorCode.VALIDATION_FAILED, "Invalid payload");
      const body = parsed.data;

      const text = body.configText ?? (await readConfigFile(body.path));
      const all = parseSSHConfig(text);
      const selected = body.selectedHosts
        ? all.filter((h) => body.selectedHosts!.includes(h.alias))
        : all;

      const insertHost = db.prepare(
        `INSERT INTO hosts (id, folder_id, label, hostname, port, username, auth_method, credential_id, tags, starred, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', 0, ?)`,
      );

      const created: string[] = [];
      const now = new Date().toISOString();

      // One transaction: a partially-applied import would leave the user with
      // a half-populated host list and no clear way to retry cleanly.
      db.transaction(() => {
        for (const h of selected) {
          const id = generateId("hst");
          insertHost.run(
            id,
            body.folderId,
            h.alias,
            h.hostname ?? h.alias,
            h.port ?? 22,
            h.user ?? "root",
            // Imported entries carry no secret material — an IdentityFile
            // path is a reference, not a key. The user attaches credentials
            // afterwards, so everything starts as password auth.
            "password",
            null,
            now,
          );
          created.push(id);
        }
      })();

      writeAudit(db, {
        user: user ?? undefined,
        action: "import.apply",
        detail: { count: created.length },
      });
      return { created: created.length, ids: created };
    },

    // ── Settings ─────────────────────────────────────────────────────────
    "settings:changePassword": async (payload) => {
      const user = auth();
      const parsed = ChangePasswordBody.safeParse(payload);
      if (!parsed.success) {
        fail(ApiErrorCode.VALIDATION_FAILED, "Invalid password payload");
      }

      const meta = db.prepare("SELECT * FROM vault_meta WHERE id = 1").get() as any;
      if (!meta) fail(ApiErrorCode.VAULT_NOT_INITIALIZED, "No vault");

      // This re-encrypts every credential under a new key. In team mode that
      // would invalidate every other member's sealed copy of the shared key,
      // so team password changes go through admin reprovision instead.
      if (meta.mode === "team") {
        fail(
          ApiErrorCode.WRONG_MODE,
          "In team mode, ask an admin to reset your password",
        );
      }

      const currentKey = await deriveVaultKey(parsed.data.currentPassword, {
        algorithm: "argon2id",
        salt: Buffer.from(meta.kdf_salt),
        iterations: meta.kdf_iterations,
        memoryKib: meta.kdf_memory_kib,
        parallelism: meta.kdf_parallelism,
      });
      if (
        !Buffer.from(computeVerifier(currentKey)).equals(
          Buffer.from(meta.verifier),
        )
      ) {
        currentKey.fill(0);
        fail(ApiErrorCode.INVALID_PASSWORD, "Current password is wrong");
      }

      const newParams = generateKdfParams();
      const newKey = await deriveVaultKey(parsed.data.newPassword, newParams);
      const newVerifier = computeVerifier(newKey);

      const creds = db.prepare("SELECT * FROM credentials").all() as any[];
      const updateCred = db.prepare(
        "UPDATE credentials SET nonce = ?, encrypted_blob = ? WHERE id = ?",
      );

      // Re-encrypt and re-key atomically. A crash between the credential
      // rewrites and the vault_meta update would leave every credential
      // undecryptable — the transaction is what makes this safe to retry.
      db.transaction(() => {
        for (const cred of creds) {
          const plaintext = decrypt(
            Buffer.from(cred.encrypted_blob),
            Buffer.from(cred.nonce),
            currentKey,
          );
          const { nonce, ciphertext } = encrypt(plaintext, newKey);
          updateCred.run(nonce, ciphertext, cred.id);
        }
        db.prepare(
          `UPDATE vault_meta SET kdf_salt=?, kdf_iterations=?, kdf_memory_kib=?, kdf_parallelism=?, verifier=? WHERE id=1`,
        ).run(
          newParams.salt,
          newParams.iterations,
          newParams.memoryKib,
          newParams.parallelism,
          newVerifier,
        );
      })();

      currentKey.fill(0);
      engine.sessionStore.destroyAll();
      setSession(engine.sessionStore.create(newKey));

      // A new password means a new vault key, so any key stored for
      // password-free unlock now points at a vault that no longer exists.
      // Dropping it here means the user is asked for the new password once and
      // can re-enable, rather than hitting a confusing failure later.
      forgetDeviceKey(engine.config.dataDir);

      writeAudit(db, {
        user: user ?? undefined,
        action: "settings.changePassword",
      });
      return { ok: true };
    },

    "settings:backup": async () => {
      auth();
      const hosts = db.prepare("SELECT * FROM hosts").all();
      const folders = db.prepare("SELECT * FROM folders").all();
      const credentials = db.prepare("SELECT * FROM credentials").all() as any[];
      const knownHosts = db.prepare("SELECT * FROM known_hosts").all();
      const meta = db.prepare("SELECT * FROM vault_meta WHERE id = 1").get() as any;

      // Blobs are base64'd so the export is plain JSON. Note the backup stays
      // encrypted: credentials travel as ciphertext and the KDF params come
      // along, so a restore is unlocked with the ORIGINAL vault password.
      return {
        version: 1,
        exportedAt: new Date().toISOString(),
        vaultMeta: meta
          ? {
              ...meta,
              kdf_salt: Buffer.from(meta.kdf_salt).toString("base64"),
              verifier: Buffer.from(meta.verifier).toString("base64"),
            }
          : null,
        folders,
        hosts,
        credentials: credentials.map((c) => ({
          ...c,
          nonce: Buffer.from(c.nonce).toString("base64"),
          encrypted_blob: Buffer.from(c.encrypted_blob).toString("base64"),
        })),
        knownHosts,
      };
    },

    "settings:restore": async (payload) => {
      // Restoring over a live vault would mix credentials encrypted under two
      // different keys, leaving rows that can never be decrypted. Only an
      // uninitialized instance may be restored into.
      const existing = db.prepare("SELECT id FROM vault_meta WHERE id = 1").get();
      if (existing) {
        fail(
          ApiErrorCode.CONFLICT,
          "Restore is only possible on a fresh vault. Clear this vault first.",
        );
      }

      const backup = payload as any;
      if (!backup?.vaultMeta || backup.version !== 1) {
        fail(ApiErrorCode.VALIDATION_FAILED, "Unrecognized backup format");
      }

      const m = backup.vaultMeta;

      /**
       * Validate the KDF parameters before trusting them.
       *
       * These come from a file the user was handed, and they decide how hard
       * the master password is to crack. A crafted backup with
       * `kdf_iterations: 1` and `kdf_memory_kib: 8` restores a vault that
       * still asks for a password and still looks encrypted, but whose key
       * derivation is trivial to brute-force offline. Nothing in the UI would
       * show that anything was wrong.
       *
       * The floors below are the weakest settings this app would ever have
       * written itself, so a genuine Skiff backup always passes.
       */
      const MIN = { iterations: 2, memoryKib: 19 * 1024, parallelism: 1 };
      const kdfOk =
        Number.isInteger(m.kdf_iterations) && m.kdf_iterations >= MIN.iterations &&
        Number.isInteger(m.kdf_memory_kib) && m.kdf_memory_kib >= MIN.memoryKib &&
        Number.isInteger(m.kdf_parallelism) && m.kdf_parallelism >= MIN.parallelism &&
        // Absurdly large values are a denial of service on the next unlock:
        // argon2 would try to allocate the memory and hang or crash the app.
        m.kdf_iterations <= 100 && m.kdf_memory_kib <= 1024 * 1024 &&
        m.kdf_parallelism <= 16;

      if (!kdfOk) {
        fail(
          ApiErrorCode.VALIDATION_FAILED,
          "This backup's encryption settings are outside the accepted range. It may be corrupted or tampered with.",
        );
      }

      // The salt and verifier must be the right size, or the vault restores
      // into a state that can never be unlocked.
      let saltLen = 0;
      let verifierLen = 0;
      try {
        saltLen = Buffer.from(String(m.kdf_salt ?? ""), "base64").length;
        verifierLen = Buffer.from(String(m.verifier ?? ""), "base64").length;
      } catch {
        saltLen = 0;
      }
      if (saltLen < 16 || verifierLen < 16) {
        fail(ApiErrorCode.VALIDATION_FAILED, "This backup is missing or has a malformed key salt.");
      }

      if (m.mode !== undefined && m.mode !== "personal" && m.mode !== "team") {
        fail(ApiErrorCode.VALIDATION_FAILED, "Unrecognized vault mode in backup");
      }
      db.transaction(() => {
        db.prepare(
          `INSERT INTO vault_meta (id, schema_version, kdf_salt, kdf_iterations, kdf_memory_kib, kdf_parallelism, verifier, mode, recording_enabled, idle_timeout_minutes, created_at)
           VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          m.schema_version,
          Buffer.from(m.kdf_salt, "base64"),
          m.kdf_iterations,
          m.kdf_memory_kib,
          m.kdf_parallelism,
          Buffer.from(m.verifier, "base64"),
          m.mode ?? "personal",
          m.recording_enabled ?? 0,
          m.idle_timeout_minutes ?? 15,
          m.created_at ?? new Date().toISOString(),
        );

        for (const f of backup.folders ?? []) {
          db.prepare(
            "INSERT INTO folders (id, name, parent_id, created_at) VALUES (?, ?, ?, ?)",
          ).run(f.id, f.name, f.parent_id ?? null, f.created_at);
        }
        for (const c of backup.credentials ?? []) {
          db.prepare(
            "INSERT INTO credentials (id, kind, nonce, encrypted_blob, created_at) VALUES (?, ?, ?, ?, ?)",
          ).run(
            c.id,
            c.kind,
            Buffer.from(c.nonce, "base64"),
            Buffer.from(c.encrypted_blob, "base64"),
            c.created_at,
          );
        }
        for (const h of backup.hosts ?? []) {
          db.prepare(
            `INSERT INTO hosts (id, folder_id, label, hostname, port, username, auth_method, credential_id, tags, starred, last_connected_at, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            h.id,
            h.folder_id ?? null,
            h.label,
            h.hostname,
            h.port,
            h.username,
            h.auth_method,
            h.credential_id ?? null,
            h.tags ?? "[]",
            h.starred ?? 0,
            h.last_connected_at ?? null,
            h.created_at,
          );
        }
        for (const k of backup.knownHosts ?? []) {
          db.prepare(
            "INSERT INTO known_hosts (hostname, port, fingerprint, algorithm, first_seen_at) VALUES (?, ?, ?, ?, ?)",
          ).run(k.hostname, k.port, k.fingerprint, k.algorithm, k.first_seen_at);
        }
      })();

      writeAudit(db, {
        action: "settings.restore",
        detail: { hosts: (backup.hosts ?? []).length },
      });
      return { ok: true, mode: m.mode ?? "personal" };
    },

    "settings:upgradeTeam": async (payload) => {
      const user = auth();
      const parsed = z
        .object({
          adminUsername: z
            .string()
            .min(1)
            .max(64)
            .regex(/^[a-zA-Z0-9._-]+$/),
          currentPassword: z.string().min(1),
        })
        .safeParse(payload);
      if (!parsed.success) {
        fail(
          ApiErrorCode.VALIDATION_FAILED,
          "adminUsername and currentPassword required",
        );
      }

      const meta = db.prepare("SELECT * FROM vault_meta WHERE id = 1").get() as any;
      if (!meta) fail(ApiErrorCode.VAULT_NOT_INITIALIZED, "No vault");
      if (meta.mode === "team") {
        fail(ApiErrorCode.WRONG_MODE, "Already a team vault");
      }

      // Confirm the submitted password is actually the current master
      // password before using it to seal the shared key — matches the check
      // apps/api performs for the same endpoint, rather than trusting the
      // session alone for a change this destructive and irreversible.
      const currentKey = await deriveVaultKey(parsed.data.currentPassword, {
        algorithm: "argon2id",
        salt: Buffer.from(meta.kdf_salt),
        iterations: meta.kdf_iterations,
        memoryKib: meta.kdf_memory_kib,
        parallelism: meta.kdf_parallelism,
      });
      if (
        !Buffer.from(computeVerifier(currentKey)).equals(
          Buffer.from(meta.verifier),
        )
      ) {
        currentKey.fill(0);
        fail(ApiErrorCode.INVALID_PASSWORD, "Current password is wrong");
      }
      currentKey.fill(0);

      // The current personal vault key becomes the team's shared key: the
      // admin's password already unseals it, and no credential needs
      // re-encrypting. Turning recording on matches the team default set at
      // setup, so upgraded and freshly-created team vaults behave the same.
      const vaultKey = requireVaultKey(engine);
      const { provisionUser } = await import("@skiff/core");
      const provisioned = await provisionUser(
        parsed.data.currentPassword,
        vaultKey,
      );

      const userId = generateId("usr");
      db.transaction(() => {
        db.prepare(
          `INSERT INTO users (id, username, display_name, kdf_salt, kdf_iterations, kdf_memory_kib, kdf_parallelism, verifier, shared_key_blob, shared_key_nonce, is_admin, disabled, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?)`,
        ).run(
          userId,
          parsed.data.adminUsername,
          null,
          provisioned.kdf.salt,
          provisioned.kdf.iterations,
          provisioned.kdf.memoryKib,
          provisioned.kdf.parallelism,
          provisioned.verifier,
          provisioned.sharedKeyBlob,
          provisioned.sharedKeyNonce,
          new Date().toISOString(),
        );
        db.prepare(
          "UPDATE vault_meta SET mode = 'team', recording_enabled = 1 WHERE id = 1",
        ).run();
      })();

      // The session running this upgrade predates the admin identity it just
      // created, so it carries no user at all. Everything gated on "is this an
      // admin" then reads false: the Admin nav row stays hidden and every
      // team:* handler refuses — including the ones on /admin, which is where
      // the renderer navigates on success. The upgrade appeared to work and
      // left you on a screen you had no permission to use, with no way back.
      //
      // Adopting the identity in place is the fix. Not a fresh session: its id
      // is half the terminal manager's key, so reissuing it would orphan every
      // open shell.
      const sessionId = getSessionId();
      if (sessionId) {
        engine.sessionStore.attachUser(sessionId, {
          id: userId,
          username: parsed.data.adminUsername,
          isAdmin: true,
        });
      }

      writeAudit(db, {
        user: { id: userId, username: parsed.data.adminUsername, isAdmin: true },
        action: "vault.upgradeTeam",
        detail: { adminUsername: parsed.data.adminUsername },
      });
      return { ok: true, userId };
    },
  };
}
