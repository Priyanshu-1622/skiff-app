/**
 * Snippet handlers.
 *
 * ── The guardrail check is the important part ─────────────────────────────
 * Running a snippet writes straight into a session, bypassing `terminal:write`
 * and therefore the guardrail that lives there. Without the check repeated
 * here, saving `rm -rf /` as a snippet would be a one-click way around the
 * confirmation — and worse, a *shared* one, since a snippet is a thing people
 * pass around.
 *
 * So a snippet is checked after its variables are filled in, not before. The
 * dangerous part is usually what someone typed into the blank.
 */

import { z } from "zod";
import {
  parseVariables,
  applyVariables,
  isFullyResolved,
  validateSnippet,
  checkCommand,
  generateId,
  writeAudit,
} from "@skiff/core";
import { ApiErrorCode } from "@skiff/shared";
import type { EngineContext } from "../engine.js";
import { fail, type Handlers } from "./contract.js";
import { requireVaultKey, currentUser } from "./auth.js";

const SnippetBody = z.object({
  name: z.string(),
  command: z.string(),
  tags: z.array(z.string()).max(12).optional(),
  category: z.string().max(60).nullable().optional(),
});

const RunBody = z.object({
  id: z.string().min(1),
  hostId: z.string().min(1),
  values: z.record(z.string()).optional(),
  /** Set once the user has seen and accepted a guardrail warning. */
  confirmed: z.boolean().optional(),
});

function toTags(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw !== "string" || !raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function shape(row: any) {
  return {
    id: row.id,
    name: row.name,
    command: row.command,
    tags: toTags(row.tags),
    category: row.category ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at ?? null,
    variables: parseVariables(row.command),
  };
}

export function registerSnippetHandlers(engine: EngineContext): Handlers {
  const db = engine.db.raw;

  const guardrailsOn = (): boolean => {
    try {
      const row = db
        .prepare("SELECT guardrails_enabled FROM vault_meta WHERE id = 1")
        .get() as { guardrails_enabled?: number } | undefined;
      return !!row?.guardrails_enabled;
    } catch {
      return false;
    }
  };

  return {
    "snippets:list": async () => {
      requireVaultKey(engine);
      const rows = db
        .prepare("SELECT * FROM snippets ORDER BY name COLLATE NOCASE")
        .all() as any[];
      return rows.map(shape);
    },

    "snippets:create": async (payload) => {
      const user = currentUser(engine);
      requireVaultKey(engine);
      const parsed = SnippetBody.safeParse(payload);
      if (!parsed.success) fail(ApiErrorCode.VALIDATION_FAILED, "Check the snippet");

      const problem = validateSnippet(parsed.data);
      if (problem) fail(ApiErrorCode.VALIDATION_FAILED, problem);

      const id = generateId();
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO snippets (id, name, command, tags, category, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        parsed.data.name.trim(),
        parsed.data.command.trim(),
        JSON.stringify(parsed.data.tags ?? []),
        parsed.data.category?.trim() || null,
        now,
        now,
      );

      writeAudit(db, {
        user: user ?? undefined,
        action: "snippet.create",
        resourceType: "snippet",
        resourceId: id,
        detail: { name: parsed.data.name.trim() },
      });
      return shape(db.prepare("SELECT * FROM snippets WHERE id = ?").get(id));
    },

    "snippets:update": async (payload) => {
      const user = currentUser(engine);
      requireVaultKey(engine);
      const parsed = SnippetBody.extend({ id: z.string().min(1) }).safeParse(payload);
      if (!parsed.success) fail(ApiErrorCode.VALIDATION_FAILED, "Check the snippet");

      const problem = validateSnippet(parsed.data);
      if (problem) fail(ApiErrorCode.VALIDATION_FAILED, problem);

      const existing = db.prepare("SELECT id FROM snippets WHERE id = ?").get(parsed.data.id);
      if (!existing) fail(ApiErrorCode.NOT_FOUND, "Snippet not found");

      db.prepare(
        `UPDATE snippets SET name = ?, command = ?, tags = ?, category = ?, updated_at = ?
         WHERE id = ?`,
      ).run(
        parsed.data.name.trim(),
        parsed.data.command.trim(),
        JSON.stringify(parsed.data.tags ?? []),
        parsed.data.category?.trim() || null,
        new Date().toISOString(),
        parsed.data.id,
      );

      writeAudit(db, {
        user: user ?? undefined,
        action: "snippet.update",
        resourceType: "snippet",
        resourceId: parsed.data.id,
      });
      return shape(db.prepare("SELECT * FROM snippets WHERE id = ?").get(parsed.data.id));
    },

    "snippets:delete": async (payload) => {
      const user = currentUser(engine);
      requireVaultKey(engine);
      const parsed = z.object({ id: z.string().min(1) }).safeParse(payload);
      if (!parsed.success) fail(ApiErrorCode.VALIDATION_FAILED, "Snippet id required");

      // Read first, so the audit entry can name what went. Deleting an id that
      // is already gone is a 404 now rather than a silent success.
      const doomed = db
        .prepare("SELECT name FROM snippets WHERE id = ?")
        .get(parsed.data.id) as { name?: string } | undefined;
      if (!doomed) fail(ApiErrorCode.NOT_FOUND, "Snippet not found");

      db.prepare("DELETE FROM snippets WHERE id = ?").run(parsed.data.id);
      writeAudit(db, {
        user: user ?? undefined,
        action: "snippet.delete",
        resourceType: "snippet",
        resourceId: parsed.data.id,
        // The name only. The command itself is not put in the audit log —
        // snippets routinely carry hostnames, paths and account names.
        detail: { name: doomed.name ?? null },
      });
      return { ok: true };
    },

    /**
     * Resolve a snippet and type it into an open session.
     *
     * It is *typed*, not executed — the command lands at the prompt followed by
     * a newline, exactly as if the person had typed it. That keeps it visible
     * in the scrollback and in the session recording, which is the whole point
     * for a tool that has to be able to show what happened.
     */
    "snippets:run": async (payload) => {
      const user = currentUser(engine);
      requireVaultKey(engine);
      const parsed = RunBody.safeParse(payload);
      if (!parsed.success) fail(ApiErrorCode.VALIDATION_FAILED, "Snippet and host required");

      const row = db.prepare("SELECT * FROM snippets WHERE id = ?").get(parsed.data.id) as any;
      if (!row) fail(ApiErrorCode.NOT_FOUND, "Snippet not found");

      const values = parsed.data.values ?? {};
      if (!isFullyResolved(row.command, values)) {
        fail(ApiErrorCode.VALIDATION_FAILED, "Fill in every variable first");
      }
      const command = applyVariables(row.command, values);

      // Checked on the resolved command, because the dangerous part is usually
      // what was typed into the blank.
      if (guardrailsOn() && !parsed.data.confirmed) {
        const hit = checkCommand(command);
        if (hit) {
          writeAudit(db, {
            user: user ?? undefined,
            action: "command.intercepted",
            resourceType: "host",
            resourceId: parsed.data.hostId,
            detail: { rule: hit.id, via: "snippet", snippetId: row.id },
          });
          return { blocked: true, hit, command };
        }
      }

      const session = engine.sessionManager
        .list()
        .find((s: any) => s.hostId === parsed.data.hostId);
      if (!session) {
        fail(
          ApiErrorCode.CONFLICT,
          "Open a session to this host first — the snippet is typed into it",
        );
      }

      engine.sessionManager.write(
        (session as any).id,
        Buffer.from(`${command}\r`, "utf8"),
      );

      db.prepare("UPDATE snippets SET last_used_at = ? WHERE id = ?").run(
        new Date().toISOString(),
        row.id,
      );

      writeAudit(db, {
        user: user ?? undefined,
        action: "snippet.run",
        resourceType: "host",
        resourceId: parsed.data.hostId,
        detail: { snippetId: row.id, name: row.name },
      });
      return { ok: true, command };
    },
  };
}
