/**
 * The device-unlock blob's location, and removing it.
 *
 * Split out of keychain.ts for one reason: this half needs no Electron.
 *
 * keychain.ts imports `safeStorage` and `systemPreferences` from "electron" at
 * the top level, which is correct there — wrapping and unwrapping the key is
 * exactly what those APIs are for. But settings.ts only needs to *delete* the
 * blob when the vault password changes, and ESM loads a module's whole graph
 * eagerly: importing one Electron-free function from keychain.ts still pulled
 * Electron into settings.ts, and from there into the IPC tests, which run
 * under plain Node where `electron` resolves to a path string rather than the
 * API. The tests died on `does not provide an export named 'safeStorage'`
 * before running a single case.
 *
 * The rule the IPC layer is meant to follow is that handlers stay
 * Electron-free and talk to the engine through contract.ts. This keeps that
 * true rather than working around it at the test boundary.
 */

import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/**
 * A file in the data directory, deliberately not a database table — backups
 * export the database, and a wrapped key inside one would grant password-free
 * access to anyone restoring that backup onto the same machine.
 */
export const DEVICE_KEY_FILE = "device-unlock.bin";

/** Full path to the device-unlock blob for a given data directory. */
export function deviceKeyPath(dataDir: string): string {
  return join(dataDir, DEVICE_KEY_FILE);
}

/**
 * Remove the stored device key. Best effort by design: this runs on password
 * change, where the key it wraps is already useless. Failing loudly would
 * block the password change over a file that no longer decrypts anything.
 */
export function forgetDeviceKey(dataDir: string): void {
  try {
    const p = deviceKeyPath(dataDir);
    if (existsSync(p)) unlinkSync(p);
  } catch {
    /* best effort */
  }
}
