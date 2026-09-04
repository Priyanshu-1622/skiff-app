/**
 * Data handlers: hosts, folders, recordings, settings, team, health.
 *
 * These are straight ports of the corresponding Fastify routes. The bodies are
 * effectively unchanged — same SQL, same validation, same audit calls — with
 * three mechanical differences:
 *
 *   1. `req.body` / `req.params` become the single `payload` argument.
 *   2. `req.vaultKey` becomes `requireVaultKey(engine)`.
 *   3. `reply.code(404)` / `err(...)` become `fail(CODE, message)`.
 *
 * Keeping the logic identical is deliberate: this step is a transport swap,
 * not a rewrite. Behaviour changes here would be indistinguishable from
 * porting bugs.
 */

import { z } from "zod";
import { decrypt, encrypt, generateId, writeAudit, verifyAuditChain } from "@skiff/core";
import { ApiErrorCode } from "@skiff/shared";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { EngineContext } from "../engine.js";
import { fail, type Handlers } from "./contract.js";
import { requireVaultKey, currentUser } from "./auth.js";

const IdBody = z.object({ id: z.string().min(1) });

/** Filters for hosts:list, as they arrive from the dashboard query string. */
const HostListQuery = z.object({
  folderId: z.string().min(1).optional(),
  starred: z.string().optional(),
  search: z.string().min(1).optional(),
});

const FolderBody = z.object({
  name: z.string().min(1).max(120),
  parentId: z.string().nullable().optional(),
});

/**
 * Credential payload.
 *
 * The field is `value`, matching the Fastify API and what the renderer sends.
 * The IPC port had renamed it to `secret`, so validation rejected every host
 * that carried a credential — this is the same class of bug as the `tags`
 * regression: the logic moved across transports and a detail changed on the
 * way. Worth keeping the two contracts identical rather than merely similar.
 */
const CredentialBody = z.object({
  kind: z.enum(["password", "key", "key+passphrase"]),
  value: z.string().min(1),
  passphrase: z.string().optional(),
});

const HostBody = z.object({
  label: z.string().min(1).max(120),
  hostname: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().min(1).max(64),
  // The schema constrains this with a CHECK, so it must be supplied and must
  // be one of the three accepted values.
  authMethod: z.enum(["password", "key", "key+passphrase", "agent"]).default("password"),
  // A host reached through a bastion. Null means connect directly.
  jumpHostId: z.string().nullable().optional(),
  folderId: z.string().nullable().optional(),
  tags: z.array(z.string()).default([]),
  starred: z.boolean().default(false),
  credential: CredentialBody.optional(),
});

/**
 * Shape a raw `hosts` row into what the UI expects.
 *
 * `tags` is a TEXT column holding a JSON array and `starred` is an INTEGER, so
 * a raw row hands the renderer a string where it expects an array. The Fastify
 * build did this in `normalizeHost` (apps/api/src/routes/hosts.ts); the port to
 * IPC dropped it, which is exactly the class of porting bug this file's header
 * warns about. Without it `host.tags.map(...)` throws in the dashboard.
 *
 * A malformed blob degrades to `[]` rather than throwing — one bad row should
 * never take out the whole list.
 */
function normalizeHost(row: any) {
  let tags: unknown = row.tags;
  if (typeof tags === "string") {
    try { tags = JSON.parse(tags); }
    catch { tags = []; }
  }
  if (!Array.isArray(tags)) tags = [];

  return { ...row, tags, starred: !!row.starred };
}

export function registerDataHandlers(engine: EngineContext): Handlers {
  const db = engine.db.raw;

  /** Vault mode, read fresh — it can change via the personal→team upgrade. */
  const mode = (): string => {
    try {
      const row = db.prepare("SELECT mode FROM vault_meta WHERE id = 1").get() as
        | { mode?: string }
        | undefined;
      return row?.mode ?? "personal";
    } catch {
      return "personal";
    }
  };

  /** Guard used by every handler that touches vault data. */
  const auth = () => {
    requireVaultKey(engine);
    return currentUser(engine);
  };

  return {
    "health:check": async () => ({ ok: true, schema: 3 }),

    // ── Folders ──────────────────────────────────────────────────────────
    "folders:list": async () => {
      auth();
      return db.prepare("SELECT * FROM folders ORDER BY name").all();
    },

    "folders:create": async (payload) => {
      const user = auth();
      const parsed = FolderBody.safeParse(payload);
      if (!parsed.success) fail(ApiErrorCode.VALIDATION_FAILED, "Invalid folder");
      const id = generateId();
      db.prepare(
        "INSERT INTO folders (id, name, parent_id, created_at) VALUES (?, ?, ?, ?)",
      ).run(
        id,
        parsed.data.name,
        parsed.data.parentId ?? null,
        new Date().toISOString(),
      );
      writeAudit(db, {
        action: "folder.create",
        resourceType: "folder",
        resourceId: id,
        user: user ?? undefined,
      });
      return { id };
    },

    "folders:update": async (payload) => {
      const user = auth();
      const parsed = FolderBody.extend({ id: z.string() }).safeParse(payload);
      if (!parsed.success) fail(ApiErrorCode.VALIDATION_FAILED, "Invalid folder");
      const res = db
        .prepare("UPDATE folders SET name = ?, parent_id = ? WHERE id = ?")
        .run(parsed.data.name, parsed.data.parentId ?? null, parsed.data.id);
      if (res.changes === 0) fail(ApiErrorCode.NOT_FOUND, "Folder not found");
      writeAudit(db, {
        action: "folder.update",
        resourceType: "folder",
        resourceId: parsed.data.id,
        user: user ?? undefined,
      });
      return { ok: true };
    },

    "folders:delete": async (payload) => {
      const user = auth();
      const parsed = IdBody.safeParse(payload);
      if (!parsed.success) fail(ApiErrorCode.VALIDATION_FAILED, "id required");
      const res = db
        .prepare("DELETE FROM folders WHERE id = ?")
        .run(parsed.data.id);
      if (res.changes === 0) fail(ApiErrorCode.NOT_FOUND, "Folder not found");
      writeAudit(db, {
        action: "folder.delete",
        resourceType: "folder",
        resourceId: parsed.data.id,
        user: user ?? undefined,
      });
      return { ok: true };
    },

    // ── Hosts ────────────────────────────────────────────────────────────
    "hosts:list": async (payload) => {
      auth();
      // Mirrors GET /api/hosts — same filters, same ordering. The dashboard
      // sends these as query parameters; api-ipc folds them into the payload.
      // They used to be dropped at both ends, so selecting a folder listed
      // every host in the vault, and starred and search did nothing either.
      const q = HostListQuery.safeParse(payload ?? {});
      const { folderId, starred, search } = q.success ? q.data : {};

      let sql =
        `SELECT id, folder_id, label, hostname, port, username, auth_method,
                credential_id, jump_host_id, tags, starred, last_connected_at, created_at
           FROM hosts WHERE 1=1`;
      const params: unknown[] = [];

      if (folderId) { sql += " AND folder_id = ?"; params.push(folderId); }
      if (starred === "true") { sql += " AND starred = 1"; }
      if (search) {
        sql += " AND (label LIKE ? OR hostname LIKE ? OR username LIKE ?)";
        const term = `%${search}%`;
        params.push(term, term, term);
      }
      sql +=
        " ORDER BY starred DESC, (last_connected_at IS NULL), last_connected_at DESC, label ASC";

      return db.prepare(sql).all(...params).map(normalizeHost);
    },

    "hosts:get": async (payload) => {
      auth();
      const parsed = IdBody.safeParse(payload);
      if (!parsed.success) fail(ApiErrorCode.VALIDATION_FAILED, "id required");
      const host = db
        .prepare("SELECT * FROM hosts WHERE id = ?")
        .get(parsed.data.id);
      if (!host) fail(ApiErrorCode.NOT_FOUND, "Host not found");
      return normalizeHost(host);
    },

    "hosts:create": async (payload) => {
      const vaultKey = requireVaultKey(engine);
      const user = currentUser(engine);
      const parsed = HostBody.safeParse(payload);
      if (!parsed.success) fail(ApiErrorCode.VALIDATION_FAILED, "Invalid host");
      const body = parsed.data;

      let credentialId: string | null = null;
      if (body.credential) {
        credentialId = generateId();
        // Keys with a passphrase are stored as JSON so both travel in one
        // encrypted blob — terminal.ts reads that shape back out.
        const plaintext = body.credential.passphrase
          ? JSON.stringify({
              value: body.credential.value,
              passphrase: body.credential.passphrase,
            })
          : body.credential.value;
        const encrypted = encrypt(plaintext, vaultKey);
        db.prepare(
          "INSERT INTO credentials (id, kind, nonce, encrypted_blob, created_at) VALUES (?, ?, ?, ?, ?)",
        ).run(
          credentialId,
          body.credential.kind,
          encrypted.nonce,
          encrypted.ciphertext,
          new Date().toISOString(),
        );
      }

      const id = generateId();
      db.prepare(
        `INSERT INTO hosts (id, folder_id, label, hostname, port, username, auth_method, credential_id, jump_host_id, tags, starred, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        body.folderId ?? null,
        body.label,
        body.hostname,
        body.port,
        body.username,
        body.authMethod,
        credentialId,
        body.jumpHostId ?? null,
        JSON.stringify(body.tags),
        body.starred ? 1 : 0,
        new Date().toISOString(),
      );

      writeAudit(db, {
        action: "host.create",
        resourceType: "host",
        resourceId: id,
        detail: { label: body.label, hostname: body.hostname },
        user: user ?? undefined,
      });
      return { id };
    },

    "hosts:update": async (payload) => {
      const vaultKey = requireVaultKey(engine);
      const user = currentUser(engine);
      const parsed = HostBody.extend({ id: z.string() }).safeParse(payload);
      if (!parsed.success) fail(ApiErrorCode.VALIDATION_FAILED, "Invalid host");
      const body = parsed.data;

      const existing = db
        .prepare("SELECT * FROM hosts WHERE id = ?")
        .get(body.id) as any;
      if (!existing) fail(ApiErrorCode.NOT_FOUND, "Host not found");

      let credentialId = existing.credential_id as string | null;
      if (body.credential) {
        const newCredId = generateId();
        // Keys with a passphrase are stored as JSON so both travel in one
        // encrypted blob — terminal.ts reads that shape back out.
        const plaintext = body.credential.passphrase
          ? JSON.stringify({
              value: body.credential.value,
              passphrase: body.credential.passphrase,
            })
          : body.credential.value;
        const encrypted = encrypt(plaintext, vaultKey);
        db.prepare(
          "INSERT INTO credentials (id, kind, nonce, encrypted_blob, created_at) VALUES (?, ?, ?, ?, ?)",
        ).run(
          newCredId,
          body.credential.kind,
          encrypted.nonce,
          encrypted.ciphertext,
          new Date().toISOString(),
        );
        // The credential being replaced is discarded, not left behind.
        // Without this every password change kept the previous one encrypted
        // in the vault for good — so rotating a password because it leaked
        // left the leaked one exactly where it was. Matches the HTTP doorway.
        if (existing.credential_id) {
          db.prepare("DELETE FROM credentials WHERE id = ?").run(existing.credential_id);
        }
        credentialId = newCredId;
      }

      db.prepare(
        `UPDATE hosts SET label = ?, hostname = ?, port = ?, username = ?, auth_method = ?,
                          folder_id = ?, credential_id = ?, jump_host_id = ?, tags = ?, starred = ?
         WHERE id = ?`,
      ).run(
        body.label,
        body.hostname,
        body.port,
        body.username,
        body.authMethod,
        body.folderId ?? null,
        credentialId,
        // A host can't jump through itself; that would deadlock the connect.
        body.jumpHostId && body.jumpHostId !== body.id ? body.jumpHostId : null,
        JSON.stringify(body.tags),
        body.starred ? 1 : 0,
        body.id,
      );

      writeAudit(db, {
        action: "host.update",
        resourceType: "host",
        resourceId: body.id,
        user: user ?? undefined,
      });
      return { ok: true };
    },

    "hosts:delete": async (payload) => {
      const user = auth();
      const parsed = IdBody.safeParse(payload);
      if (!parsed.success) fail(ApiErrorCode.VALIDATION_FAILED, "id required");
      // Read before deleting. The audit row used to carry only the id, which
      // points at a record that no longer exists — so the log could say that
      // something was deleted but never what.
      const doomed = db
        .prepare("SELECT label, hostname, credential_id FROM hosts WHERE id = ?")
        .get(parsed.data.id) as
        | { label?: string; hostname?: string; credential_id?: string | null }
        | undefined;
      if (!doomed) fail(ApiErrorCode.NOT_FOUND, "Host not found");

      // The credential goes with the host.
      //
      // Deleting only the host left its encrypted password behind with nothing
      // referencing it — a secret the user believed they had removed, kept
      // indefinitely and invisible in every screen. The HTTP doorway has always
      // done this; the desktop port dropped it.
      //
      // One transaction, so a failure cannot delete the host and strand the
      // credential, which is the state this is meant to prevent.
      db.transaction(() => {
        db.prepare("DELETE FROM hosts WHERE id = ?").run(parsed.data.id);
        if (doomed.credential_id) {
          db.prepare("DELETE FROM credentials WHERE id = ?").run(doomed.credential_id);
        }
      })();
      writeAudit(db, {
        action: "host.delete",
        resourceType: "host",
        resourceId: parsed.data.id,
        user: user ?? undefined,
        detail: { label: doomed?.label ?? null, hostname: doomed?.hostname ?? null },
      });
      return { ok: true };
    },

    // ── Recordings ───────────────────────────────────────────────────────
    "recordings:list": async () => {
      const user = auth();
      // Access control matches the server: members see their own recordings,
      // admins see everything. In personal mode there are no users, so the
      // user filter is skipped entirely.
      const rows = (user && !user.isAdmin
        ? db
            .prepare(
              "SELECT * FROM session_recordings WHERE user_id = ? ORDER BY started_at DESC LIMIT 500",
            )
            .all(user.id)
        : db
            .prepare(
              "SELECT * FROM session_recordings ORDER BY started_at DESC LIMIT 500",
            )
            .all()) as any[];

      // Raw rows used to go straight out, so the UI — which reads startedAt,
      // durationMs and the rest — got undefined for every one of them and
      // rendered "Invalid Date". Same camelCase shape the HTTP route returns.
      return rows.map((r) => ({
        id: r.id,
        hostId: r.host_id,
        hostLabel: r.host_label,
        hostname: r.hostname,
        userId: r.user_id,
        username: r.username,
        startedAt: r.started_at,
        endedAt: r.ended_at,
        durationMs: r.duration_ms,
        bytes: r.bytes,
        status: r.status,
      }));
    },

    "recordings:cast": async (payload) => {
      const user = auth();
      const parsed = IdBody.safeParse(payload);
      if (!parsed.success) fail(ApiErrorCode.VALIDATION_FAILED, "id required");

      const rec = db
        .prepare("SELECT * FROM session_recordings WHERE id = ?")
        .get(parsed.data.id) as any;
      if (!rec) fail(ApiErrorCode.NOT_FOUND, "Recording not found");
      if (user && !user.isAdmin && rec.user_id !== user.id) {
        fail(ApiErrorCode.FORBIDDEN, "Not your recording");
      }

      // The id is validated against the database rather than used to build a
      // path directly, which is what keeps a crafted id from escaping the
      // recordings directory.
      const path = join(engine.recordingsDir, `${rec.id}.cast`);
      return await readFile(path, "utf-8");
    },

    "recordings:delete": async (payload) => {
      const user = auth();
      const parsed = IdBody.safeParse(payload);
      if (!parsed.success) fail(ApiErrorCode.VALIDATION_FAILED, "id required");

      const rec = db
        .prepare("SELECT * FROM session_recordings WHERE id = ?")
        .get(parsed.data.id) as any;
      if (!rec) fail(ApiErrorCode.NOT_FOUND, "Recording not found");
      if (user && !user.isAdmin && rec.user_id !== user.id) {
        fail(ApiErrorCode.FORBIDDEN, "Not your recording");
      }

      db.prepare("DELETE FROM session_recordings WHERE id = ?").run(rec.id);
      try {
        await unlink(join(engine.recordingsDir, `${rec.id}.cast`));
      } catch {
        // File already gone — the row is what matters.
      }
      writeAudit(db, {
        action: "recording.delete",
        resourceType: "recording",
        resourceId: rec.id,
        user: user ?? undefined,
        // Which session, not just which row id — the row is gone now.
        detail: { hostLabel: rec.host_label ?? null, startedAt: rec.started_at ?? null },
      });
      return { ok: true };
    },

    // ── Settings ─────────────────────────────────────────────────────────
    "settings:idleTimeout": async (payload) => {
      const user = auth();
      const parsed = z
        .object({ minutes: z.number().int().min(1).max(1440) })
        .safeParse(payload);
      if (!parsed.success) fail(ApiErrorCode.VALIDATION_FAILED, "Invalid timeout");
      db.prepare("UPDATE vault_meta SET idle_timeout_minutes = ? WHERE id = 1").run(
        parsed.data.minutes,
      );
      engine.sessionStore.setIdleTimeout(parsed.data.minutes);
      writeAudit(db, {
        action: "settings.idleTimeout",
        user: user ?? undefined,
        // The value, not just the fact. "Someone changed the idle timeout" is
        // not a useful record of a security setting — 1 minute and 1440 are
        // very different decisions. Matches settings.recording next door.
        detail: { minutes: parsed.data.minutes },
      });
      return { ok: true };
    },

    "settings:recording": async (payload) => {
      const user = auth();
      const parsed = z.object({ enabled: z.boolean() }).safeParse(payload);
      if (!parsed.success) fail(ApiErrorCode.VALIDATION_FAILED, "Invalid value");
      db.prepare("UPDATE vault_meta SET recording_enabled = ? WHERE id = 1").run(
        parsed.data.enabled ? 1 : 0,
      );
      writeAudit(db, {
        action: "settings.recording",
        detail: { enabled: parsed.data.enabled },
        user: user ?? undefined,
      });
      return { ok: true };
    },

    "settings:tray": async (payload) => {
      const user = auth();
      const parsed = z.object({ enabled: z.boolean() }).safeParse(payload);
      if (!parsed.success) fail(ApiErrorCode.VALIDATION_FAILED, "Invalid value");
      db.prepare("UPDATE vault_meta SET tray_enabled = ? WHERE id = 1").run(
        parsed.data.enabled ? 1 : 0,
      );
      writeAudit(db, {
        action: "settings.tray",
        detail: { enabled: parsed.data.enabled },
        user: user ?? undefined,
      });
      return { ok: true, restartRequired: true };
    },

    "settings:guardrails": async (payload) => {
      const user = auth();
      const parsed = z.object({ enabled: z.boolean() }).safeParse(payload);
      if (!parsed.success) fail(ApiErrorCode.VALIDATION_FAILED, "Invalid value");
      db.prepare("UPDATE vault_meta SET guardrails_enabled = ? WHERE id = 1").run(
        parsed.data.enabled ? 1 : 0,
      );
      writeAudit(db, {
        action: "settings.guardrails",
        detail: { enabled: parsed.data.enabled },
        user: user ?? undefined,
      });
      return { ok: true };
    },

    // ── Team ─────────────────────────────────────────────────────────────
    "team:me": async () => {
      auth();
      return currentUser(engine);
    },

    /**
     * The team roster.
     *
     * This selected a `role` column, which has never existed — the schema
     * stores `is_admin`. Every call threw, and the renderer treats a failed
     * query as an empty list, so the screen showed "0 members" over an empty
     * table with the admin sitting right there in the database.
     *
     * It also returned raw rows while `TeamMember` is camelCase, so even with
     * the column fixed the list would have rendered blank names and thrown on
     * `createdAt.slice()`. Mapped here, as `recordings:list` already is.
     */
    "team:usersList": async () => {
      const user = auth();
      if (!user || !user.isAdmin) {
        fail(ApiErrorCode.FORBIDDEN, "Admin only");
      }
      const rows = db
        .prepare(
          `SELECT id, username, display_name, is_admin, disabled, created_at
             FROM users ORDER BY username COLLATE NOCASE`,
        )
        .all() as Array<{
          id: string;
          username: string;
          display_name: string | null;
          is_admin: number;
          disabled: number;
          created_at: string;
        }>;
      return rows.map((r) => ({
        id: r.id,
        username: r.username,
        displayName: r.display_name,
        isAdmin: !!r.is_admin,
        disabled: !!r.disabled,
        createdAt: r.created_at,
      }));
    },

    "team:audit": async (payload) => {
      const user = auth();
      if (!user || !user.isAdmin) {
        fail(ApiErrorCode.FORBIDDEN, "Admin only");
      }
      // Math.max(NaN, 1) is NaN, and better-sqlite3 throws when a bind
      // parameter is NaN — so a payload of { limit: "abc" } crashed the
      // handler rather than being ignored.
      const raw = (payload ?? {}) as { limit?: unknown };
      const n = Number(raw.limit);
      const limit = Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), 1), 1000) : 200;
      return db
        .prepare("SELECT * FROM audit_log ORDER BY at DESC LIMIT ?")
        .all(limit);
    },

    /**
     * The audit log for this vault.
     *
     * Unlike team:audit this is readable in personal mode too. The log is the
     * record of what happened on *this* machine; a solo user has as much right
     * to inspect their own history as a team admin has to inspect a team's.
     * Team vaults still restrict it to admins, since there it describes other
     * people's actions.
     */
    "audit:list": async (payload) => {
      const user = auth();
      if (mode() === "team" && (!user || !user.isAdmin)) {
        fail(ApiErrorCode.FORBIDDEN, "Admin only");
      }
      const { limit = 200 } = (payload ?? {}) as { limit?: number };
      return db
        .prepare(
          `SELECT id, user_id, username, action, resource_type, resource_id,
                  detail, ip, at, prev_hash, hash
           FROM audit_log ORDER BY id DESC LIMIT ?`,
        )
        .all(Math.min(Math.max(limit, 1), 1000));
    },

    /** Recompute the hash chain and report whether the log is intact. */
    "audit:verify": async () => {
      const user = auth();
      if (mode() === "team" && (!user || !user.isAdmin)) {
        fail(ApiErrorCode.FORBIDDEN, "Admin only");
      }
      return verifyAuditChain(db);
    },

    /**
     * The whole log, for export.
     *
     * Separate from `audit:list` on purpose. That one is for the screen: newest
     * first and capped, because nobody scrolls 40,000 rows. An export with
     * either property is worthless — a log missing its oldest entries cannot be
     * checked against anything, and the hash chain only reads forwards. So this
     * returns every row in chain order, with `prev_hash` and `hash` intact so
     * the file can be re-verified outside Skiff by anyone who has it.
     *
     * The verification result travels with it, stating what was true at the
     * moment of export rather than leaving the reader to assume.
     */
    "audit:export": async () => {
      const user = auth();
      if (mode() === "team" && (!user || !user.isAdmin)) {
        fail(ApiErrorCode.FORBIDDEN, "Admin only");
      }
      const entries = db
        .prepare(
          `SELECT id, user_id, username, action, resource_type, resource_id,
                  detail, ip, at, prev_hash, hash
           FROM audit_log ORDER BY id ASC`,
        )
        .all();
      return {
        exportedAt: new Date().toISOString(),
        exportedBy: user?.username ?? null,
        integrity: verifyAuditChain(db),
        entries,
      };
    },
  };
}
