/**
 * The hosts table rebuild.
 *
 * SQLite can't alter a CHECK constraint, so adding 'agent' as an auth method
 * means recreating the table and copying every row. That is the one migration
 * in this project that can lose real data if it's wrong, so it gets tested
 * against a populated database rather than trusted.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

/** The pre-migration schema, as it shipped. */
function legacyDb(): any {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE folders (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE credentials (id TEXT PRIMARY KEY, kind TEXT NOT NULL);
    CREATE TABLE hosts (
      id TEXT PRIMARY KEY,
      folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
      label TEXT NOT NULL,
      hostname TEXT NOT NULL,
      port INTEGER NOT NULL DEFAULT 22,
      username TEXT NOT NULL,
      auth_method TEXT NOT NULL CHECK (auth_method IN ('password', 'key', 'key+passphrase')),
      credential_id TEXT REFERENCES credentials(id) ON DELETE SET NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      starred INTEGER NOT NULL DEFAULT 0 CHECK (starred IN (0, 1)),
      last_connected_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX idx_hosts_folder ON hosts(folder_id);
    CREATE INDEX idx_hosts_starred ON hosts(starred) WHERE starred = 1;
    CREATE INDEX idx_hosts_last_connected ON hosts(last_connected_at DESC);
  `);
  return db;
}

/** The migration, lifted verbatim from client.ts. */
function migrate(db: any): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'hosts'")
    .get() as { sql?: string } | undefined;
  const hostsSql = row?.sql ?? "";
  if (!hostsSql || hostsSql.includes("'agent'")) return;

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
          jump_host_id TEXT REFERENCES hosts(id) ON DELETE SET NULL,
          tags TEXT NOT NULL DEFAULT '[]',
          starred INTEGER NOT NULL DEFAULT 0 CHECK (starred IN (0, 1)),
          last_connected_at TEXT,
          created_at TEXT NOT NULL
        );
        INSERT INTO hosts_migrated
          (id, folder_id, label, hostname, port, username, auth_method,
           credential_id, tags, starred, last_connected_at, created_at)
        SELECT id, folder_id, label, hostname, port, username, auth_method,
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

function seed(db: any) {
  db.prepare("INSERT INTO folders (id, name) VALUES ('f1', 'Production')").run();
  db.prepare("INSERT INTO credentials (id, kind) VALUES ('c1', 'password')").run();
  const insert = db.prepare(
    `INSERT INTO hosts (id, folder_id, label, hostname, port, username, auth_method,
                        credential_id, tags, starred, last_connected_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insert.run("h1", "f1", "web-01", "web-01.iad.internal", 22, "deploy", "password", "c1",
    '["prod","web"]', 1, "2026-07-23T14:01:52Z", "2026-01-01T00:00:00Z");
  insert.run("h2", null, "build", "build-01.local", 2222, "ci", "key", null,
    "[]", 0, null, "2026-02-01T00:00:00Z");
}

test("every row survives the rebuild, byte for byte", () => {
  const db = legacyDb();
  seed(db);
  const before = db.prepare("SELECT * FROM hosts ORDER BY id").all();

  migrate(db);

  const after = db.prepare(
    `SELECT id, folder_id, label, hostname, port, username, auth_method,
            credential_id, tags, starred, last_connected_at, created_at
     FROM hosts ORDER BY id`,
  ).all();

  assert.deepEqual(after, before, "no field may change during the rebuild");
});

test("the new columns exist and default to null", () => {
  const db = legacyDb();
  seed(db);
  migrate(db);

  const row = db.prepare("SELECT jump_host_id FROM hosts WHERE id = 'h1'").get() as any;
  assert.equal(row.jump_host_id, null);
});

test("'agent' is accepted afterwards, and nonsense still isn't", () => {
  const db = legacyDb();
  seed(db);
  migrate(db);

  db.prepare(
    `INSERT INTO hosts (id, label, hostname, port, username, auth_method, tags, starred, created_at)
     VALUES ('h3', 'agent host', 'h.example', 22, 'me', 'agent', '[]', 0, '2026-03-01T00:00:00Z')`,
  ).run();
  assert.equal(
    (db.prepare("SELECT auth_method FROM hosts WHERE id = 'h3'").get() as any).auth_method,
    "agent",
  );

  assert.throws(() =>
    db.prepare(
      `INSERT INTO hosts (id, label, hostname, port, username, auth_method, tags, starred, created_at)
       VALUES ('h4', 'bad', 'h.example', 22, 'me', 'telepathy', '[]', 0, '2026-03-01T00:00:00Z')`,
    ).run(),
  );
});

test("the indexes come back", () => {
  const db = legacyDb();
  seed(db);
  migrate(db);

  const names = (db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'hosts'",
  ).all() as any[]).map((r) => r.name);

  for (const idx of ["idx_hosts_folder", "idx_hosts_starred", "idx_hosts_last_connected"]) {
    assert.ok(names.includes(idx), `${idx} should be recreated`);
  }
});

test("running it twice is a no-op", () => {
  const db = legacyDb();
  seed(db);
  migrate(db);
  const after1 = db.prepare("SELECT * FROM hosts ORDER BY id").all();
  migrate(db);
  const after2 = db.prepare("SELECT * FROM hosts ORDER BY id").all();
  assert.deepEqual(after2, after1);
});

test("deleting a bastion doesn't delete the hosts behind it", () => {
  const db = legacyDb();
  seed(db);
  migrate(db);
  db.pragma("foreign_keys = ON");

  db.prepare("UPDATE hosts SET jump_host_id = 'h2' WHERE id = 'h1'").run();
  db.prepare("DELETE FROM hosts WHERE id = 'h2'").run();

  const row = db.prepare("SELECT id, jump_host_id FROM hosts WHERE id = 'h1'").get() as any;
  assert.ok(row, "the host behind the bastion must still exist");
  assert.equal(row.jump_host_id, null, "its jump host should just be cleared");
});
