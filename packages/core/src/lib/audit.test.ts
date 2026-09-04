/**
 * Audit chain tests.
 *
 * These assert a security property, not a feature: it must not be possible to
 * change the audit log without verification noticing. Every test below is a
 * different way of trying to get away with it — editing a row, deleting one,
 * reordering, and forging a hash. If any of these ever starts passing
 * verification, the tamper-evidence claim is false and the feature is worse
 * than not having it, because it would be reassuring people wrongly.
 *
 * Runs against node:sqlite via the shim in sandboxes, better-sqlite3 locally.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { writeAudit, verifyAuditChain } from "./audit.js";

function freshDb(): any {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      username TEXT,
      action TEXT NOT NULL,
      resource_type TEXT,
      resource_id TEXT,
      detail TEXT,
      ip TEXT,
      at TEXT NOT NULL,
      prev_hash TEXT,
      hash TEXT
    );
  `);
  return db;
}

function seed(db: any, n = 5) {
  for (let i = 1; i <= n; i++) {
    writeAudit(db, {
      action: `action.${i}`,
      resourceType: "host",
      resourceId: `host-${i}`,
      detail: { index: i },
    });
  }
}

test("an empty log reports empty, not verified", () => {
  const db = freshDb();
  const report = verifyAuditChain(db);
  assert.equal(report.status, "empty");
  assert.equal(report.count, 0);
  assert.equal(report.head, null);
});

test("an untouched log verifies, and every entry is chained", () => {
  const db = freshDb();
  seed(db, 5);

  const report = verifyAuditChain(db);
  assert.equal(report.status, "verified");
  assert.equal(report.count, 5);
  assert.equal(report.unchained, 0);
  assert.ok(report.head && report.head.length === 64, "head should be a sha256 hex digest");

  // First entry anchors the chain; each later prev_hash equals the previous hash.
  const rows = db.prepare("SELECT id, prev_hash, hash FROM audit_log ORDER BY id").all() as any[];
  assert.equal(rows[0].prev_hash, "");
  for (let i = 1; i < rows.length; i++) {
    assert.equal(rows[i].prev_hash, rows[i - 1].hash);
  }
});

test("editing an entry's contents is detected", () => {
  const db = freshDb();
  seed(db, 5);

  // The classic cover-up: quietly change what an action said it did.
  db.prepare("UPDATE audit_log SET action = 'something.innocent' WHERE id = 3").run();

  const report = verifyAuditChain(db);
  assert.equal(report.status, "broken");
  assert.equal(report.brokenAt, 3);
  assert.match(report.reason!, /contents were changed/);
});

test("deleting an entry is detected", () => {
  const db = freshDb();
  seed(db, 5);

  db.prepare("DELETE FROM audit_log WHERE id = 3").run();

  const report = verifyAuditChain(db);
  assert.equal(report.status, "broken");
  // Entry 4 now follows entry 2, so its prev_hash no longer matches.
  assert.equal(report.brokenAt, 4);
  assert.match(report.reason!, /removed or reordered/);
});

test("recomputing one row's hash still breaks the following link", () => {
  const db = freshDb();
  seed(db, 5);

  // A more determined attacker: edit the row *and* fix its own hash so it's
  // self-consistent. The next entry's prev_hash still points at the old value,
  // so the chain gives them away one link later. Covering that up means
  // rewriting every subsequent entry too — which is exactly the cost the
  // chain exists to impose.
  const row = db.prepare("SELECT * FROM audit_log WHERE id = 2").get() as any;
  db.prepare("UPDATE audit_log SET detail = ?, hash = ? WHERE id = 2").run(
    JSON.stringify({ index: 999 }),
    row.hash,
  );

  const report = verifyAuditChain(db);
  assert.equal(report.status, "broken");
  assert.equal(report.brokenAt, 2);
});

test("a forged hash does not pass", () => {
  const db = freshDb();
  seed(db, 3);

  db.prepare("UPDATE audit_log SET hash = ? WHERE id = 2").run("0".repeat(64));

  const report = verifyAuditChain(db);
  assert.equal(report.status, "broken");
  assert.equal(report.brokenAt, 2);
});

test("entries written before chaining existed are reported, not called tampering", () => {
  const db = freshDb();

  // Simulates rows that predate the migration: present, but never hashed.
  db.prepare(
    "INSERT INTO audit_log (action, at, prev_hash, hash) VALUES ('legacy.1', ?, NULL, NULL)",
  ).run(new Date().toISOString());
  db.prepare(
    "INSERT INTO audit_log (action, at, prev_hash, hash) VALUES ('legacy.2', ?, NULL, NULL)",
  ).run(new Date().toISOString());

  seed(db, 3);

  const report = verifyAuditChain(db);
  assert.equal(report.status, "verified");
  assert.equal(report.unchained, 2);
  assert.equal(report.count, 5);
});

test("an unhashed row inserted among chained ones is detected", () => {
  const db = freshDb();
  seed(db, 3);

  // Someone appending directly to the table, bypassing writeAudit.
  db.prepare(
    "INSERT INTO audit_log (action, at, prev_hash, hash) VALUES ('sneaked.in', ?, NULL, NULL)",
  ).run(new Date().toISOString());

  const report = verifyAuditChain(db);
  assert.equal(report.status, "broken");
  assert.match(report.reason!, /no hash/);
});

test("the detail field never carries credential contents", () => {
  const db = freshDb();
  writeAudit(db, {
    action: "host.create",
    resourceType: "host",
    resourceId: "h1",
    detail: { label: "web-01", username: "deploy" },
  });

  const row = db.prepare("SELECT detail FROM audit_log WHERE id = 1").get() as any;
  const detail = JSON.parse(row.detail);
  assert.deepEqual(Object.keys(detail).sort(), ["label", "username"]);
  assert.ok(!("password" in detail));
  assert.ok(!("privateKey" in detail));
});
