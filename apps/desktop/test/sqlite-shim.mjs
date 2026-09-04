/**
 * A minimal better-sqlite3 shim backed by Node 22's built-in node:sqlite.
 *
 * Why this exists: better-sqlite3 is a native module and cannot be compiled in
 * sandboxed or container CI environments without a full toolchain (a known
 * constraint on this project). Without a shim, the IPC handler tests could
 * only ever run on a developer machine -- which is where tests stop being run.
 *
 * node:sqlite ships with Node 22 and exposes nearly the same synchronous
 * prepare/run/get/all surface, so the handful of methods the engine actually
 * uses can be adapted.
 *
 * TEST-ONLY. Production always uses real better-sqlite3, which is faster,
 * stable, and not behind an experimental flag. Plain JavaScript rather than
 * TypeScript because module resolution hooks run on a separate thread that
 * does not have the tsx loader applied.
 */

import { DatabaseSync } from "node:sqlite";

/**
 * node:sqlite rejects `undefined`, does not coerce Date, and wants Uint8Array
 * rather than Buffer for blobs. Normalizing here keeps the engine code
 * identical across both drivers.
 */
function normalize(params) {
  return params.map((p) => {
    if (p === undefined) return null;
    if (p instanceof Date) return p.toISOString();
    if (typeof p === "boolean") return p ? 1 : 0;
    if (Buffer.isBuffer(p)) return new Uint8Array(p);
    return p;
  });
}

class StatementShim {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
  }

  run(...params) {
    const result = this.db.prepare(this.sql).run(...normalize(params));
    return {
      changes: Number(result.changes ?? 0),
      lastInsertRowid: result.lastInsertRowid,
    };
  }

  get(...params) {
    return this.db.prepare(this.sql).get(...normalize(params));
  }

  all(...params) {
    return this.db.prepare(this.sql).all(...normalize(params));
  }
}

class DatabaseShim {
  constructor(path) {
    this.db = new DatabaseSync(path);
  }

  prepare(sql) {
    return new StatementShim(this.db, sql);
  }

  exec(sql) {
    this.db.exec(sql);
  }

  /**
   * better-sqlite3's transaction() returns a callable that wraps the function
   * in BEGIN/COMMIT and rolls back on throw. node:sqlite has no equivalent
   * helper, so the semantics are reproduced here — the rollback path matters,
   * since several handlers rely on it to avoid half-applied writes.
   */
  transaction(fn) {
    return (...args) => {
      this.db.exec("BEGIN");
      try {
        const result = fn(...args);
        this.db.exec("COMMIT");
        return result;
      } catch (error) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          // Rollback can fail if the transaction already aborted; the
          // original error is the one worth surfacing.
        }
        throw error;
      }
    };
  }

  pragma() {
    // The PRAGMAs the engine sets (foreign_keys, journal_mode, synchronous)
    // are either defaults or irrelevant for an ephemeral test database.
    return [];
  }

  close() {
    this.db.close();
  }
}

export default function Database(path) {
  return new DatabaseShim(path);
}
