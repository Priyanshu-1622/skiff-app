/**
 * The engine context.
 *
 * In the server build, Fastify held these as decorated instance properties and
 * passed them to route plugins. There is no Fastify here, so this object plays
 * that role: it is constructed once at app start and handed to every IPC
 * handler.
 *
 * Note what is NOT here compared to the server: no cookie secret, no CORS
 * origins, no port, no trusted proxy list. A desktop app has exactly one user
 * sitting in front of it and no network listener, so those concepts don't
 * exist. That is the whole reason CoreConfig was split out of the old
 * apps/api config.
 */

import { join } from "node:path";
import {
  openDatabase,
  resolveCoreConfig,
  SessionManager,
  SessionStore,
  type SkiffDb,
  type CoreConfig,
} from "@skiff/core";

export interface EngineContext {
  db: SkiffDb;
  sessionStore: SessionStore;
  sessionManager: SessionManager;
  config: Required<CoreConfig>;
  /** Absolute path to the recordings directory. */
  recordingsDir: string;
}

export function createEngine(dataDir: string): EngineContext {
  const config = resolveCoreConfig({ dataDir });

  const db = openDatabase({
    dataDir: config.dataDir,
    filename: config.dbFilename,
  });

  // The session store is the in-memory unlock state. On the server this was
  // keyed by signed cookie so many browsers could hold separate sessions.
  // Here there is a single local user, so there is exactly one session and it
  // lives for as long as the process does (or until the vault is locked).
  // SessionStore's idle timeout is in MINUTES (it drives vault auto-lock).
  // SessionManager's idleGraceMs is in MILLISECONDS and is a different clock:
  // how long a detached SSH session survives with no client attached before
  // being reaped. Conflating the two would either lock the vault too eagerly
  // or leak SSH connections.
  // Load the user's saved auto-lock timeout rather than the built-in default.
  //
  // Without this, setting auto-lock to 5 minutes worked until the next
  // restart, then silently reverted to 15 — the setting still *displayed* as 5
  // because the UI reads it from the database, so the vault stayed unlocked
  // three times longer than the user believed. A security setting that quietly
  // stops applying is worse than one that isn't offered.
  let idleMinutes = Math.round(config.idleTimeoutMs / 60_000);
  try {
    const saved = db.raw
      .prepare("SELECT idle_timeout_minutes FROM vault_meta WHERE id = 1")
      .get() as { idle_timeout_minutes?: number } | undefined;
    const m = Number(saved?.idle_timeout_minutes);
    if (Number.isInteger(m) && m >= 1 && m <= 24 * 60) idleMinutes = m;
  } catch {
    // No vault yet on first run — the default is correct then.
  }

  const sessionStore = new SessionStore(idleMinutes);

  const sessionManager = new SessionManager({
    idleGraceMs: config.idleTimeoutMs,
  });

  return {
    db,
    sessionStore,
    sessionManager,
    config,
    recordingsDir: join(config.dataDir, "recordings"),
  };
}

export function destroyEngine(engine: EngineContext): void {
  // Order matters: end SSH sessions before closing the database, because
  // session teardown writes recording rows and a final audit entry. Closing
  // the db first would make those writes throw during shutdown.
  engine.sessionManager.shutdown();
  engine.sessionStore.close();
  engine.db.close();
}
