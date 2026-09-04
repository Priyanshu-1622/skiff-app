/**
 * File manager handlers — remote over SFTP, local over the real filesystem.
 *
 * The local side is why this feature only exists in the desktop app. A browser
 * cannot list a folder, write to a chosen path, or show a transfer of a 2 GB
 * archive between two machines. This is the largest single capability the web
 * version could never have had.
 *
 * ── Reusing the session ───────────────────────────────────────────────────
 * Remote operations run over the SSH connection of an *already open* session,
 * so browsing files inherits whatever gated that session — including a
 * break-glass approval. Opening a second connection would authenticate again,
 * appear twice in the server's auth log, and bypass the gate. If there's no
 * open session for the host, the handler says so rather than connecting
 * silently.
 */

import { z } from "zod";
import { homedir } from "node:os";
import { join, dirname, basename, isAbsolute } from "node:path";
import { readdir, stat, mkdir, rename as fsRename, unlink, rmdir } from "node:fs/promises";
import {
  listDirectory,
  makeDirectory,
  rename as sftpRename,
  remove as sftpRemove,
  download,
  upload,
  generateId,
  writeAudit,
} from "@skiff/core";
import { ApiErrorCode } from "@skiff/shared";
import type { EngineContext } from "../engine.js";
import { fail, type Handlers } from "./contract.js";
import { requireVaultKey, currentUser } from "./auth.js";

export interface TransferEvent {
  id: string;
  direction: "up" | "down";
  name: string;
  target: string;
  transferred: number;
  total: number;
  state: "running" | "done" | "error" | "cancelled";
  message?: string;
}

const RemotePath = z.object({ hostId: z.string().min(1), path: z.string().default(".") });
const LocalPath = z.object({ path: z.string().optional() });

/**
 * A filename that is safe to write into a chosen directory.
 *
 * The name comes from a remote server, which is not trusted. `basename()`
 * alone is not enough: it uses the *host* platform's separator rules, so a
 * remote file named `..\..\evil` passes through untouched on Linux and macOS,
 * and `path.join` on a client that later runs on Windows would treat those
 * backslashes as directories and escape the download folder.
 *
 * Both separators are stripped, then leading dots, so nothing can climb out of
 * the directory the user picked no matter what the server calls its files.
 */
function safeFileName(remotePath: string): string {
  const raw = remotePath.split(/[\\/]/).pop() ?? "";
  const cleaned = raw
    .replace(/[\\/]/g, "")
    .replace(/^\.+/, "")
    // Control characters in a filename are never legitimate and confuse
    // terminals and file managers alike.
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f]/g, "")
    .trim();
  return cleaned || "download";
}

export function registerFileHandlers(
  engine: EngineContext,
  emit: (event: TransferEvent) => void,
): Handlers {
  const db = engine.db.raw;
  const cancelled = new Map<string, { cancelled: boolean }>();

  /**
   * The SSH client for a host that currently has a live session.
   *
   * Deliberately does not connect. See the note at the top of the file.
   */
  const sshFor = (hostId: string) => {
    requireVaultKey(engine);
    const session = engine.sessionManager
      .list()
      .find((s: any) => s.hostId === hostId);
    if (!session) {
      fail(
        ApiErrorCode.CONFLICT,
        "Open a session to this host first — file access uses the connection you already have",
      );
    }
    return (session as any).ssh;
  };

  return {
    // ── Remote ────────────────────────────────────────────────────────────

    "files:list": async (payload) => {
      const parsed = RemotePath.safeParse(payload);
      if (!parsed.success) fail(ApiErrorCode.VALIDATION_FAILED, "Host and path required");
      try {
        return await listDirectory(sshFor(parsed.data.hostId), parsed.data.path);
      } catch (err: any) {
        // Permission denied is an ordinary answer here, not a crash, and the
        // message from the server is more useful than anything we'd invent.
        fail(ApiErrorCode.FORBIDDEN, err?.message || "Couldn't read that directory");
      }
    },

    "files:mkdir": async (payload) => {
      const parsed = RemotePath.safeParse(payload);
      if (!parsed.success) fail(ApiErrorCode.VALIDATION_FAILED, "Path required");
      const ssh = sshFor(parsed.data.hostId);
      try {
        await makeDirectory(ssh, parsed.data.path);
      } catch (err: any) {
        fail(ApiErrorCode.FORBIDDEN, err?.message || "Couldn't create that folder");
      }
      writeAudit(db, {
        user: currentUser(engine) ?? undefined,
        action: "files.mkdir",
        resourceType: "host",
        resourceId: parsed.data.hostId,
        detail: { path: parsed.data.path },
      });
      return { ok: true };
    },

    "files:rename": async (payload) => {
      const parsed = z
        .object({ hostId: z.string(), from: z.string(), to: z.string() })
        .safeParse(payload);
      if (!parsed.success) fail(ApiErrorCode.VALIDATION_FAILED, "Both paths required");
      const ssh = sshFor(parsed.data.hostId);
      try {
        await sftpRename(ssh, parsed.data.from, parsed.data.to);
      } catch (err: any) {
        fail(ApiErrorCode.FORBIDDEN, err?.message || "Couldn't rename that");
      }
      writeAudit(db, {
        user: currentUser(engine) ?? undefined,
        action: "files.rename",
        resourceType: "host",
        resourceId: parsed.data.hostId,
        detail: { from: parsed.data.from, to: parsed.data.to },
      });
      return { ok: true };
    },

    "files:delete": async (payload) => {
      const parsed = z
        .object({
          hostId: z.string(),
          path: z.string(),
          isDirectory: z.boolean().default(false),
        })
        .safeParse(payload);
      if (!parsed.success) fail(ApiErrorCode.VALIDATION_FAILED, "Path required");
      const ssh = sshFor(parsed.data.hostId);
      try {
        await sftpRemove(ssh, parsed.data.path, parsed.data.isDirectory);
      } catch (err: any) {
        // rmdir on a non-empty directory fails here, and that's correct:
        // recursive delete is not offered on purpose.
        fail(ApiErrorCode.FORBIDDEN, err?.message || "Couldn't delete that");
      }
      writeAudit(db, {
        user: currentUser(engine) ?? undefined,
        action: "files.delete",
        resourceType: "host",
        resourceId: parsed.data.hostId,
        detail: { path: parsed.data.path },
      });
      return { ok: true };
    },

    // ── Local ─────────────────────────────────────────────────────────────
    //
    // These need the same vault check as the remote ones. The remote handlers
    // get it via sshFor(); these had none, which meant a locked Skiff could
    // still browse, rename and delete files on this machine. Locking has to
    // mean locked, not "the SSH parts are locked".

    "files:localList": async (payload) => {
      requireVaultKey(engine);
      const parsed = LocalPath.safeParse(payload ?? {});
      const dir = parsed.success && parsed.data.path ? parsed.data.path : homedir();
      if (!isAbsolute(dir)) fail(ApiErrorCode.VALIDATION_FAILED, "Absolute path required");

      try {
        const names = await readdir(dir);
        const entries = await Promise.all(
          names.map(async (name) => {
            const full = join(dir, name);
            try {
              const s = await stat(full);
              return {
                name,
                path: full,
                type: s.isDirectory() ? "directory" : "file",
                size: s.size,
                modified: s.mtimeMs,
                perms: "",
              };
            } catch {
              // Broken symlinks and files we can't stat are skipped rather
              // than failing the whole listing.
              return null;
            }
          }),
        );

        const usable = entries.filter(Boolean) as any[];
        usable.sort((a, b) => {
          const ad = a.type === "directory" ? 0 : 1;
          const bd = b.type === "directory" ? 0 : 1;
          if (ad !== bd) return ad - bd;
          return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
        });

        return { path: dir, parent: dirname(dir), entries: usable };
      } catch (err: any) {
        fail(ApiErrorCode.FORBIDDEN, err?.message || "Couldn't read that folder");
      }
    },

    "files:localMkdir": async (payload) => {
      requireVaultKey(engine);
      const parsed = z.object({ path: z.string().min(1) }).safeParse(payload);
      if (!parsed.success) fail(ApiErrorCode.VALIDATION_FAILED, "Path required");
      await mkdir(parsed.data.path, { recursive: false });
      return { ok: true };
    },

    "files:localRename": async (payload) => {
      requireVaultKey(engine);
      const parsed = z.object({ from: z.string(), to: z.string() }).safeParse(payload);
      if (!parsed.success) fail(ApiErrorCode.VALIDATION_FAILED, "Both paths required");
      await fsRename(parsed.data.from, parsed.data.to);
      return { ok: true };
    },

    "files:localDelete": async (payload) => {
      requireVaultKey(engine);
      const parsed = z
        .object({ path: z.string(), isDirectory: z.boolean().default(false) })
        .safeParse(payload);
      if (!parsed.success) fail(ApiErrorCode.VALIDATION_FAILED, "Path required");
      if (parsed.data.isDirectory) await rmdir(parsed.data.path);
      else await unlink(parsed.data.path);
      return { ok: true };
    },

    // ── Transfers ─────────────────────────────────────────────────────────

    /**
     * Transfers report progress on a push channel and resolve when finished.
     *
     * Progress is emitted rather than polled because these are long: the
     * mockup's own example is a 2.4 GB archive, and a progress bar that only
     * moves when the UI asks is worse than none.
     */
    "files:download": async (payload) => {
      const parsed = z
        .object({ hostId: z.string(), remotePath: z.string(), localDir: z.string() })
        .safeParse(payload);
      if (!parsed.success) fail(ApiErrorCode.VALIDATION_FAILED, "Paths required");

      const ssh = sshFor(parsed.data.hostId);
      const name = safeFileName(parsed.data.remotePath);
      const localPath = join(parsed.data.localDir, name);
      const id = generateId();
      const signal = { cancelled: false };
      cancelled.set(id, signal);

      emit({ id, direction: "down", name, target: parsed.data.localDir, transferred: 0, total: 0, state: "running" });

      try {
        await download(ssh, parsed.data.remotePath, localPath, (p) =>
          emit({ id, direction: "down", name, target: parsed.data.localDir, ...p, state: "running" }),
          signal,
        );
        emit({ id, direction: "down", name, target: parsed.data.localDir, transferred: 1, total: 1, state: "done" });
        writeAudit(db, {
          user: currentUser(engine) ?? undefined,
          action: "files.download",
          resourceType: "host",
          resourceId: parsed.data.hostId,
          detail: { path: parsed.data.remotePath },
        });
        return { ok: true, localPath };
      } catch (err: any) {
        const state = signal.cancelled ? "cancelled" : "error";
        emit({ id, direction: "down", name, target: parsed.data.localDir, transferred: 0, total: 0, state, message: err?.message });
        fail(ApiErrorCode.INTERNAL, err?.message || "Download failed");
      } finally {
        cancelled.delete(id);
      }
    },

    "files:upload": async (payload) => {
      const parsed = z
        .object({ hostId: z.string(), localPath: z.string(), remoteDir: z.string() })
        .safeParse(payload);
      if (!parsed.success) fail(ApiErrorCode.VALIDATION_FAILED, "Paths required");

      const ssh = sshFor(parsed.data.hostId);
      const name = basename(parsed.data.localPath);
      const remotePath = `${parsed.data.remoteDir.replace(/\/+$/, "")}/${name}`;
      const id = generateId();
      const signal = { cancelled: false };
      cancelled.set(id, signal);

      emit({ id, direction: "up", name, target: parsed.data.remoteDir, transferred: 0, total: 0, state: "running" });

      try {
        await upload(ssh, parsed.data.localPath, remotePath, (p) =>
          emit({ id, direction: "up", name, target: parsed.data.remoteDir, ...p, state: "running" }),
          signal,
        );
        emit({ id, direction: "up", name, target: parsed.data.remoteDir, transferred: 1, total: 1, state: "done" });
        writeAudit(db, {
          user: currentUser(engine) ?? undefined,
          action: "files.upload",
          resourceType: "host",
          resourceId: parsed.data.hostId,
          detail: { path: remotePath },
        });
        return { ok: true, remotePath };
      } catch (err: any) {
        const state = signal.cancelled ? "cancelled" : "error";
        emit({ id, direction: "up", name, target: parsed.data.remoteDir, transferred: 0, total: 0, state, message: err?.message });
        fail(ApiErrorCode.INTERNAL, err?.message || "Upload failed");
      } finally {
        cancelled.delete(id);
      }
    },

    "files:cancel": async (payload) => {
      const parsed = z.object({ id: z.string() }).safeParse(payload);
      if (!parsed.success) fail(ApiErrorCode.VALIDATION_FAILED, "Transfer id required");
      const signal = cancelled.get(parsed.data.id);
      if (signal) signal.cancelled = true;
      return { ok: true };
    },
  };
}
