/**
 * Tamper-evident audit log.
 *
 * Records who did what, when — and makes the record *provable* rather than
 * merely present. Every entry stores a SHA-256 hash over its own fields plus
 * the hash of the entry before it, so the log forms a chain:
 *
 *     entry₁.hash = H(fields₁ ‖ "")
 *     entry₂.hash = H(fields₂ ‖ entry₁.hash)
 *     entry₃.hash = H(fields₃ ‖ entry₂.hash)
 *
 * Change any historical row and its hash no longer matches its contents;
 * recompute that hash and every later link breaks instead. Delete a row and
 * the chain has a hole. There is no edit that leaves the chain intact, which
 * is the whole point: an attacker with write access to the database can still
 * destroy the log, but cannot quietly rewrite it.
 *
 * What this is not: proof against someone who truncates the log and starts a
 * fresh chain. Detecting that needs the head hash anchored somewhere outside
 * the database — periodic external attestation, which is enterprise territory.
 * The OSS version proves *internal* consistency, and says so honestly.
 *
 * Never stores secrets. `detail` is for non-sensitive context only (a host
 * label, a target username) — never passwords or credential contents.
 */

import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { SessionUser } from "../crypto/session-store.js";

export interface AuditEvent {
  user?: SessionUser;
  action: string;
  resourceType?: string;
  resourceId?: string;
  detail?: Record<string, unknown>;
  ip?: string;
}

export interface AuditRow {
  id: number;
  user_id: string | null;
  username: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  detail: string | null;
  ip: string | null;
  at: string;
  prev_hash: string | null;
  hash: string | null;
}

/**
 * The exact bytes that get hashed for one entry.
 *
 * Field order and separator are part of the format: changing either
 * invalidates every existing chain, so treat this function as frozen. The
 * separator is a unit-separator character precisely because it can't appear in
 * any of the values.
 */
function canonical(row: {
  id: number;
  user_id: string | null;
  username: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  detail: string | null;
  ip: string | null;
  at: string;
  prev_hash: string;
}): string {
  return [
    String(row.id),
    row.user_id ?? "",
    row.username ?? "",
    row.action,
    row.resource_type ?? "",
    row.resource_id ?? "",
    row.detail ?? "",
    row.ip ?? "",
    row.at,
    row.prev_hash,
  ].join("\u001f");
}

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Hash of the most recent entry, or "" when the log is empty. */
function headHash(db: Database.Database): string {
  const row = db
    .prepare("SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1")
    .get() as { hash: string | null } | undefined;
  return row?.hash ?? "";
}

/**
 * Append an event and link it to the chain.
 *
 * The insert and the hash update run in one transaction. Without that, a crash
 * between them would leave an unhashed row that verification would report as
 * tampering — a false alarm on the one feature that has to be trustworthy.
 */
export function writeAudit(db: Database.Database, event: AuditEvent): void {
  try {
    const at = new Date().toISOString();
    const detail = event.detail ? JSON.stringify(event.detail) : null;

    const append = db.transaction(() => {
      const prev = headHash(db);

      const info = db
        .prepare(
          `INSERT INTO audit_log
             (user_id, username, action, resource_type, resource_id, detail, ip, at, prev_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          event.user?.id ?? null,
          event.user?.username ?? null,
          event.action,
          event.resourceType ?? null,
          event.resourceId ?? null,
          detail,
          event.ip ?? null,
          at,
          prev,
        );

      // The id is part of what's hashed, so the hash can only be computed
      // after the row exists.
      const id = Number(info.lastInsertRowid);
      const hash = sha256(
        canonical({
          id,
          user_id: event.user?.id ?? null,
          username: event.user?.username ?? null,
          action: event.action,
          resource_type: event.resourceType ?? null,
          resource_id: event.resourceId ?? null,
          detail,
          ip: event.ip ?? null,
          at,
          prev_hash: prev,
        }),
      );

      db.prepare("UPDATE audit_log SET hash = ? WHERE id = ?").run(hash, id);
    });

    append();
  } catch {
    // Audit logging must never break the operation it's recording.
  }
}

export type IntegrityStatus = "verified" | "broken" | "empty";

export interface IntegrityReport {
  status: IntegrityStatus;
  /** Entries checked. */
  count: number;
  /** Hash of the newest entry — the value to anchor externally. */
  head: string | null;
  /** First entry that fails, if any. */
  brokenAt: number | null;
  /** Plain-language reason, suitable to show a user. */
  reason: string | null;
  /** Entries written before chaining existed, which can't be verified. */
  unchained: number;
  checkedAt: string;
}

/**
 * Recompute the chain and report whether it holds.
 *
 * Reads every entry in order, so cost grows with the log. That's acceptable
 * for a local vault, and verification is deliberate rather than continuous.
 */
export function verifyAuditChain(db: Database.Database): IntegrityReport {
  const checkedAt = new Date().toISOString();

  let rows: AuditRow[];
  try {
    rows = db
      .prepare(
        `SELECT id, user_id, username, action, resource_type, resource_id,
                detail, ip, at, prev_hash, hash
         FROM audit_log ORDER BY id ASC`,
      )
      .all() as AuditRow[];
  } catch {
    return {
      status: "empty", count: 0, head: null, brokenAt: null,
      reason: null, unchained: 0, checkedAt,
    };
  }

  if (rows.length === 0) {
    return {
      status: "empty", count: 0, head: null, brokenAt: null,
      reason: null, unchained: 0, checkedAt,
    };
  }

  // Entries written before this feature existed have no hash. They're reported
  // separately rather than counted as tampering — calling a pre-existing log
  // "broken" would be alarming and wrong.
  let unchained = 0;
  let prev = "";
  let started = false;

  for (const row of rows) {
    if (row.hash === null) {
      if (started) {
        return {
          status: "broken", count: rows.length, head: null, brokenAt: row.id,
          reason: `Entry ${row.id} has no hash, but later entries are chained. A row was likely inserted directly.`,
          unchained, checkedAt,
        };
      }
      unchained++;
      continue;
    }

    if (!started) {
      // First chained entry: its prev_hash anchors the chain and isn't checked
      // against anything earlier.
      started = true;
      prev = row.prev_hash ?? "";
    } else if ((row.prev_hash ?? "") !== prev) {
      return {
        status: "broken", count: rows.length, head: null, brokenAt: row.id,
        reason: `Entry ${row.id} doesn't link to the entry before it. An entry was removed or reordered.`,
        unchained, checkedAt,
      };
    }

    const expected = sha256(canonical({ ...row, prev_hash: row.prev_hash ?? "" }));
    if (expected !== row.hash) {
      return {
        status: "broken", count: rows.length, head: null, brokenAt: row.id,
        reason: `Entry ${row.id} doesn't match its own hash. Its contents were changed after it was written.`,
        unchained, checkedAt,
      };
    }

    prev = row.hash;
  }

  return {
    status: started ? "verified" : "empty",
    count: rows.length,
    head: started ? prev : null,
    brokenAt: null,
    reason: null,
    unchained,
    checkedAt,
  };
}
