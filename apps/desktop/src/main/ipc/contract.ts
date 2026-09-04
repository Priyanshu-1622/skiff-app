/**
 * Handler contract and error types — deliberately Electron-free.
 *
 * This is split out from registry.ts so that handler modules (auth, data,
 * terminal) never import Electron transitively. That keeps them testable in a
 * plain Node process: the smoke tests exercise the real vault, database and
 * host logic without needing a display server or an Electron binary.
 *
 * registry.ts holds the ipcMain wiring and imports from here, not the reverse.
 */

import { ApiErrorCode } from "@skiff/shared";
import type { InvokeChannel } from "../../shared/ipc.js";

export type Handler = (payload: unknown) => Promise<unknown> | unknown;
export type Handlers = Partial<Record<InvokeChannel, Handler>>;

/** Error carrying a machine-readable code, mirroring the REST error body. */
export class IpcError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "IpcError";
  }
}

/**
 * Throw a coded error. Return type is `never` so TypeScript narrows correctly
 * after a call — `if (!x) fail(...)` leaves x non-null below.
 */
export function fail(code: string, message: string): never {
  throw new IpcError(code, message);
}

/** Convert any thrown value into the ApiResult error envelope. */
export function toEnvelope(error: unknown) {
  if (error instanceof IpcError) {
    return {
      ok: false as const,
      error: { code: error.code, message: error.message },
    };
  }
  // Unexpected failures are reported as INTERNAL with the message preserved.
  // Stack traces are deliberately not sent to the renderer.
  const message = error instanceof Error ? error.message : String(error);
  return {
    ok: false as const,
    error: { code: ApiErrorCode.INTERNAL, message },
  };
}
