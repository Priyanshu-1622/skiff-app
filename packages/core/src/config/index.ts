/**
 * Engine configuration.
 *
 * Deliberately smaller than the old apps/api config.ts. That file mixed two
 * unrelated concerns: things the SSH/vault engine needs (where data lives)
 * and things only an HTTP server needs (port, bind host, CORS origins,
 * cookie secret). The desktop app has no port and no cookies, so inheriting
 * that shape would force it to invent meaningless values.
 *
 * The split:
 *   - CoreConfig  (here)              — what the engine needs, everywhere
 *   - HTTP config (apps/api/config.ts) — port, host, cookies, CORS
 *
 * Hosts pass this in explicitly rather than the engine reading process.env
 * itself. Electron resolves dataDir from app.getPath('userData'); the server
 * resolves it from SKIFF_DATA_DIR. Neither has to know about the other.
 */

export interface CoreConfig {
  /** Absolute path to the data directory. Created on open if absent. */
  dataDir: string;
  /** Database file name within dataDir. Defaults to "skiff.sqlite". */
  dbFilename?: string;
  /** Where session recordings are written. Defaults to `${dataDir}/recordings`. */
  recordingsDir?: string;
  /** Idle session reap interval, ms. Defaults to 30 minutes. */
  idleTimeoutMs?: number;
}

export const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_DB_FILENAME = "skiff.sqlite";

/**
 * Fill in defaults. Kept as a plain function (not a zod schema) because the
 * engine should not force a validation dependency on every host that embeds
 * it — the API server still validates its own env with zod before calling this.
 */
export function resolveCoreConfig(config: CoreConfig): Required<CoreConfig> {
  if (!config.dataDir) {
    throw new Error("CoreConfig.dataDir is required");
  }
  return {
    dataDir: config.dataDir,
    dbFilename: config.dbFilename ?? DEFAULT_DB_FILENAME,
    recordingsDir: config.recordingsDir ?? `${config.dataDir}/recordings`,
    idleTimeoutMs: config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
  };
}
