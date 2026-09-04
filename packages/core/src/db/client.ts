import Database from "better-sqlite3";
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { SCHEMA_SQL } from "./schema.js";

export const SCHEMA_VERSION = 3;

export interface DbConfig {
  /** Absolute path to the data directory. Created if it doesn't exist. */
  dataDir: string;
  /** Database file name within dataDir. */
  filename?: string;
}

export interface SkiffDb {
  /** The underlying better-sqlite3 instance. */
  raw: Database.Database;
  /** Close the database (used on graceful shutdown). */
  close: () => void;
}

/**
 * Open or create the Skiff database, applying the schema on first boot.
 */
export function openDatabase(config: DbConfig): SkiffDb {
  const filename = config.filename ?? "skiff.sqlite";

  if (!existsSync(config.dataDir)) {
    mkdirSync(config.dataDir, { recursive: true });
  }

  const dbPath = join(config.dataDir, filename);
  const db = new Database(dbPath);

  // PRAGMAs that aren't in the schema file because they apply per
  // connection, not per database.
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");

  // Apply the schema. This is idempotent because every CREATE in
  // the schema uses IF NOT EXISTS. The SQL is inlined (see schema.ts)
  // rather than read from disk so this works inside an Electron asar
  // bundle, where there is no readable schema.sql on the filesystem.
  db.exec(SCHEMA_SQL);

  // Additive column migrations. ALTER TABLE ADD COLUMN isn't idempotent,
  // so we check the existing columns first. Safe to run on every boot.
  runColumnMigrations(db);

  // Reconcile recordings left mid-write by a crash or hard stop. On a clean
  // shutdown these are marked 'complete'; anything still 'recording' at boot
  // had no graceful finalize, so flag it 'interrupted' (the .cast file is
  // still playable up to the last flushed event).
  try {
    db.prepare(
      "UPDATE session_recordings SET status = 'interrupted' WHERE status = 'recording'"
    ).run();
  } catch { /* table may not exist on a very old db; schema.exec above creates it */ }

  return {
    raw: db,
    close: () => db.close(),
  };
}

/**
 * Add columns that can't live in schema.sql because ADD COLUMN errors if
 * the column already exists. Each migration checks before applying.
 */
export function runColumnMigrations(db: Database.Database): void {
  const hasColumn = (table: string, column: string): boolean => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return cols.some((c) => c.name === column);
  };

  // v2: vault mode — 'personal' (default, unchanged) or 'team'
  if (!hasColumn("vault_meta", "mode")) {
    db.exec(
      "ALTER TABLE vault_meta ADD COLUMN mode TEXT NOT NULL DEFAULT 'personal'"
    );
  }

  // v3: session recording toggle. Default off (0); existing team vaults are
  // flipped on below so team admins get recording without extra setup.
  if (!hasColumn("vault_meta", "recording_enabled")) {
    db.exec(
      "ALTER TABLE vault_meta ADD COLUMN recording_enabled INTEGER NOT NULL DEFAULT 0"
    );
    // Existing team vaults get recording on by default; personal stays off.
    db.exec(
      "UPDATE vault_meta SET recording_enabled = 1 WHERE mode = 'team'"
    );
  }

  // v4: tamper-evident audit chain. Existing rows keep NULL hashes — they were
  // written before chaining existed and are reported as "unchained" rather
  // than backfilled. Backfilling would compute hashes over rows nobody can
  // vouch for, which would make an unverifiable log *look* verified. An empty
  // hash is honest; a fabricated one is not.
  if (!hasColumn("audit_log", "hash")) {
    db.exec("ALTER TABLE audit_log ADD COLUMN prev_hash TEXT");
    db.exec("ALTER TABLE audit_log ADD COLUMN hash TEXT");
  }

  // v5: break-glass approvals. Off by default — enabling it is a deliberate
  // act, and switching it on silently would lock people out of their own
  // hosts on first launch after an update.
  if (!hasColumn("vault_meta", "approval_policy")) {
    db.exec("ALTER TABLE vault_meta ADD COLUMN approval_policy TEXT");
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS access_requests (
      id TEXT PRIMARY KEY,
      host_id TEXT NOT NULL,
      host_label TEXT,
      requester_id TEXT,
      requester_name TEXT,
      reason TEXT,
      status TEXT NOT NULL CHECK (status IN ('pending','approved','denied','expired')),
      approver_id TEXT,
      approver_name TEXT,
      created_at TEXT NOT NULL,
      decided_at TEXT,
      expires_at TEXT NOT NULL,
      grant_expires_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_access_requests_status
      ON access_requests(status, host_id);
  `);

  // v6: dangerous-command guardrails. Off by default for the same reason as
  // approvals — a confirmation prompt appearing unannounced after an update
  // would be alarming, and people would learn to dismiss it before they
  // learned what it was for.
  if (!hasColumn("vault_meta", "guardrails_enabled")) {
    db.exec(
      "ALTER TABLE vault_meta ADD COLUMN guardrails_enabled INTEGER NOT NULL DEFAULT 0",
    );
  }

  // v7: update checks. On by default — the alternative is a security tool that
  // silently stops looking for its own security fixes. It can be switched off,
  // which is what an air-gapped install needs.
  if (!hasColumn("vault_meta", "updates_enabled")) {
    db.exec(
      "ALTER TABLE vault_meta ADD COLUMN updates_enabled INTEGER NOT NULL DEFAULT 1",
    );
  }

  // v10: SSH agent auth and jump hosts.
  //
  // `auth_method` has a CHECK constraint, and SQLite can't alter one — the
  // table has to be rebuilt. That's the riskiest migration in this file, so it
  // is written the way SQLite documents it: foreign keys off, everything in
  // one transaction, indexes recreated afterwards. If anything throws, the
  // transaction rolls back and the old table is still there untouched.
  //
  // Guarded on the constraint text rather than a version number, so running it
  // twice is a no-op.
  const hostsSql = (
    db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'hosts'")
      .get() as { sql?: string } | undefined
  )?.sql ?? "";

  if (hostsSql && !hostsSql.includes("'agent'")) {
    const hadForeignKeys = db.pragma("foreign_keys", { simple: true });
    db.pragma("foreign_keys = OFF");
    try {
      db.transaction(() => {
        db.exec(`
          CREATE TABLE hosts_migrated (
            id TEXT PRIMARY KEY,
            folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
            label TEXT NOT NULL,
            hostname TEXT NOT NULL,
            port INTEGER NOT NULL DEFAULT 22,
            username TEXT NOT NULL,
            auth_method TEXT NOT NULL
              CHECK (auth_method IN ('password', 'key', 'key+passphrase', 'agent')),
            credential_id TEXT REFERENCES credentials(id) ON DELETE SET NULL,
            -- ProxyJump: reach this host through another one. SET NULL rather
            -- than CASCADE, because deleting a bastion should not silently
            -- delete every host behind it.
            jump_host_id TEXT REFERENCES hosts(id) ON DELETE SET NULL,
            tags TEXT NOT NULL DEFAULT '[]',
            starred INTEGER NOT NULL DEFAULT 0 CHECK (starred IN (0, 1)),
            last_connected_at TEXT,
            created_at TEXT NOT NULL
          );

          INSERT INTO hosts_migrated
            (id, folder_id, label, hostname, port, username, auth_method,
             credential_id, tags, starred, last_connected_at, created_at)
          SELECT
             id, folder_id, label, hostname, port, username, auth_method,
             credential_id, tags, starred, last_connected_at, created_at
          FROM hosts;

          DROP TABLE hosts;
          ALTER TABLE hosts_migrated RENAME TO hosts;

          CREATE INDEX IF NOT EXISTS idx_hosts_folder ON hosts(folder_id);
          CREATE INDEX IF NOT EXISTS idx_hosts_starred ON hosts(starred) WHERE starred = 1;
          CREATE INDEX IF NOT EXISTS idx_hosts_last_connected ON hosts(last_connected_at DESC);
        `);
      })();
    } finally {
      if (hadForeignKeys) db.pragma("foreign_keys = ON");
    }
  }

  // v9: keep running in the tray when the window is closed. On by default
  // because sessions surviving a closed window is the point of the tray; the
  // toggle exists for people who'd rather the app quit outright.
  if (!hasColumn("vault_meta", "tray_enabled")) {
    db.exec(
      "ALTER TABLE vault_meta ADD COLUMN tray_enabled INTEGER NOT NULL DEFAULT 1",
    );
  }

  // v8: saved commands.
  db.exec(`
    CREATE TABLE IF NOT EXISTS snippets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      command TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      category TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_used_at TEXT
    );
  `);
}
