/**
 * Unlock without retyping the password, backed by the OS.
 *
 * ── What is stored ─────────────────────────────────────────────────────────
 * The derived vault key, wrapped by Electron's `safeStorage`. Not the
 * password. The password is very likely reused somewhere else in the user's
 * life; the vault key is worthless outside this vault, so if the wrapped blob
 * ever leaks it costs the user exactly one application. Storing the password
 * would turn a Skiff compromise into a compromise of everything else they use
 * that password for.
 *
 * `safeStorage` delegates to the platform: DPAPI on Windows (bound to the
 * signed-in Windows account), Keychain on macOS, libsecret on Linux. On Linux
 * without a keyring daemon it reports unavailable, and we refuse rather than
 * silently falling back to something weaker.
 *
 * ── Where it is stored, and why not the database ───────────────────────────
 * A separate file in the data directory, deliberately *not* a table. Backups
 * export the database; if the wrapped key lived there, restoring a backup onto
 * the same machine would silently grant password-free access to whoever
 * restored it. Keeping it device-local means a backup is only ever as
 * sensitive as the password that protects it.
 *
 * ── The trade-off, stated plainly ──────────────────────────────────────────
 * Enabling this means anyone who can use your signed-in OS account can open
 * your vault. That is a real reduction in security and the UI says so. It is
 * the same bargain every password manager offers for the same reason: a vault
 * people lock because unlocking is quick beats a vault they leave open because
 * typing is tedious.
 *
 * On macOS a Touch ID prompt is required before the key is unwrapped, so
 * possession of the account isn't sufficient. Windows and Linux have no
 * equivalent exposed to Electron, so there the protection is the OS account
 * boundary alone — and the copy on those platforms doesn't claim otherwise.
 */

import { safeStorage, systemPreferences } from "electron";
import { timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { computeVerifier, writeAudit } from "@skiff/core";
import { ApiErrorCode } from "@skiff/shared";
import type { EngineContext } from "../engine.js";
import { fail, type Handlers } from "./contract.js";
import { deviceKeyPath, forgetDeviceKey } from "./device-key.js";
import { requireVaultKey, setSession, currentUser } from "./auth.js";

function blobPath(engine: EngineContext): string {
  return deviceKeyPath(engine.config.dataDir);
}

function isMac(): boolean {
  return process.platform === "darwin";
}

/** Touch ID where it exists; elsewhere the OS account boundary is the control. */
async function requireBiometric(reason: string): Promise<void> {
  if (!isMac()) return;
  try {
    if (!systemPreferences.canPromptTouchID()) return;
    await systemPreferences.promptTouchID(reason);
  } catch {
    fail(ApiErrorCode.FORBIDDEN, "Touch ID was not confirmed");
  }
}

export function registerKeychainHandlers(engine: EngineContext): Handlers {
  const db = engine.db.raw;

  const vaultMode = (): string => {
    try {
      const row = db.prepare("SELECT mode FROM vault_meta WHERE id = 1").get() as
        | { mode?: string }
        | undefined;
      return row?.mode ?? "personal";
    } catch {
      return "personal";
    }
  };

  const available = (): boolean => {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  };

  const enabled = (): boolean => existsSync(blobPath(engine));

  /** Remove the stored key. Used on disable, password change, and tamper. */
  const forget = (): void => {
    try {
      if (existsSync(blobPath(engine))) unlinkSync(blobPath(engine));
    } catch {
      /* best effort — a stale blob fails verification anyway */
    }
  };

  return {
    "keychain:status": async () => ({
      available: available(),
      enabled: enabled(),
      // Lets the UI say "Touch ID" only where that's true, rather than
      // promising a prompt the platform can't show.
      biometric: isMac() && (() => {
        try { return systemPreferences.canPromptTouchID(); } catch { return false; }
      })(),
      platform: process.platform,
    }),

    /**
     * Store the current vault key. Requires an unlocked vault — we wrap the key
     * already in memory rather than asking for the password again, so the
     * password never travels for this purpose.
     */
    "keychain:enable": async () => {
      if (!available()) {
        fail(
          ApiErrorCode.FORBIDDEN,
          process.platform === "linux"
            ? "No system keyring available. Install libsecret or a keyring daemon."
            : "This device can't store secrets securely.",
        );
      }
      if (vaultMode() === "team") {
        // A team vault must know *who* unlocked it; a device key has no
        // identity, so audit entries would be unattributable.
        fail(ApiErrorCode.WRONG_MODE, "Team vaults unlock with a username");
      }

      const key = requireVaultKey(engine);
      await requireBiometric("enable password-free unlock for Skiff");

      const wrapped = safeStorage.encryptString(key.toString("base64"));
      writeFileSync(blobPath(engine), wrapped, { mode: 0o600 });

      writeAudit(db, {
        action: "keychain.enable",
        user: currentUser(engine) ?? undefined,
      });
      return { ok: true };
    },

    "keychain:disable": async () => {
      forget();
      writeAudit(db, {
        action: "keychain.disable",
        user: currentUser(engine) ?? undefined,
      });
      return { ok: true };
    },

    /**
     * Unlock using the stored key.
     *
     * The key is still checked against the vault's verifier before a session
     * is created. That isn't ceremony: if the password was changed elsewhere,
     * or the blob was tampered with, this is what catches it — and a stale
     * blob is deleted rather than left to fail confusingly forever.
     */
    "vault:unlockWithDevice": async () => {
      if (!enabled()) {
        fail(ApiErrorCode.FORBIDDEN, "Password-free unlock isn't set up on this device");
      }
      if (!available()) {
        fail(ApiErrorCode.FORBIDDEN, "This device can't unwrap the stored key");
      }
      if (vaultMode() === "team") {
        fail(ApiErrorCode.WRONG_MODE, "This is a team vault - sign in with your username");
      }

      const meta = db.prepare("SELECT verifier FROM vault_meta WHERE id = 1").get() as
        | { verifier: Buffer }
        | undefined;
      if (!meta) fail(ApiErrorCode.VAULT_NOT_INITIALIZED, "Run setup first");

      await requireBiometric("unlock Skiff");

      let key: Buffer;
      try {
        const wrapped = readFileSync(blobPath(engine));
        key = Buffer.from(safeStorage.decryptString(wrapped), "base64");
      } catch {
        forget();
        fail(ApiErrorCode.FORBIDDEN, "Stored key couldn't be read. Use your password.");
      }

      // Constant-time, for the same reason as the password path.
      const computed = computeVerifier(key);
      const stored = Buffer.from(meta.verifier);
      const valid =
        computed.length === stored.length && timingSafeEqual(computed, stored);
      if (!valid) {
        // Almost always means the password was changed after this was set up.
        key.fill(0);
        forget();
        fail(
          ApiErrorCode.INVALID_PASSWORD,
          "The stored key no longer matches this vault. Use your password.",
        );
      }

      setSession(engine.sessionStore.create(key));
      writeAudit(db, { action: "vault.unlock", detail: { via: "device" } });
      return { ok: true };
    },
  };
}

/**
 * Delete any stored key.
 *
 * Called after a password change, which re-derives the vault key and leaves
 * the stored one pointing at a vault that no longer exists. Exported so
 * settings can invalidate it without importing the whole handler module.
 */
// forgetDeviceKey lives in ./device-key.js so callers that only need to
// delete the blob (settings.ts, on password change) do not pull Electron in
// through this module. Re-exported so existing importers of keychain.js keep
// working.
export { forgetDeviceKey };
