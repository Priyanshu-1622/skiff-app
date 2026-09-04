/**
 * Electron IPC wiring.
 *
 * This module is the ONLY place in the handler layer that touches Electron.
 * Everything else imports from contract.ts, which is Electron-free — that is
 * what lets the handlers be unit-tested in a plain Node process.
 */

import { ipcMain } from "electron";
import { INVOKE_CHANNELS } from "../../shared/ipc.js";
import { IpcError, toEnvelope, type Handlers } from "./contract.js";

export { fail, IpcError, type Handler, type Handlers } from "./contract.js";

/**
 * Register every handler and report any declared-but-unimplemented channels.
 *
 * With HTTP, a missing route is a 404 discovered when a user clicks something.
 * Here the gap is surfaced at startup instead.
 */
export function registerHandlers(handlers: Handlers): void {
  const registered = new Set<string>();

  for (const [channel, handler] of Object.entries(handlers)) {
    if (!handler) continue;
    ipcMain.handle(channel, async (_event, payload: unknown) => {
      try {
        const data = await handler(payload);
        return { ok: true as const, data };
      } catch (error) {
        // Log main-side so failures stay diagnosable even if the renderer
        // swallows them.
        if (!(error instanceof IpcError)) {
          console.error(`[ipc] ${channel} failed:`, error);
        }
        return toEnvelope(error);
      }
    });
    registered.add(channel);
  }

  const missing = INVOKE_CHANNELS.filter((c) => !registered.has(c));
  if (missing.length > 0) {
    console.warn(
      `[ipc] ${missing.length} declared channel(s) have no handler yet:\n  ` +
        missing.join("\n  "),
    );
  }
}
