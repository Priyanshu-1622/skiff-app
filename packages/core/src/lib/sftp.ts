/**
 * SFTP over an already-open SSH connection.
 *
 * Every function here takes the `ssh2` client from a live managed session
 * rather than dialling out on its own. That is the important design choice:
 * opening a second connection would mean decrypting the credential again,
 * authenticating again, and appearing twice in the server's auth log — three
 * things a governance tool should not do casually. Reusing the session also
 * means file access inherits whatever gated that session, including a
 * break-glass approval.
 *
 * The consequence, stated plainly: browsing files requires an open session for
 * that host. The UI says so rather than silently connecting behind the user.
 *
 * ── Paths ─────────────────────────────────────────────────────────────────
 * Remote paths are POSIX and absolute. They are never joined with local paths
 * — a Windows client browsing a Linux server is the normal case here, and
 * `path.join` on Windows would produce backslashes the server rejects.
 */

import type { Client as SSH2Client } from "ssh2";
import { createWriteStream, createReadStream } from "node:fs";
import { stat as fsStat } from "node:fs/promises";

export interface RemoteEntry {
  name: string;
  /** Absolute POSIX path. */
  path: string;
  type: "file" | "directory" | "symlink" | "other";
  size: number;
  /** Unix mtime in milliseconds. */
  modified: number;
  /** Rendered like `drwxr-xr-x`, as the design shows. */
  perms: string;
}

/** POSIX join that never emits a backslash, whatever the client OS. */
export function remoteJoin(base: string, name: string): string {
  if (name === "..") {
    const trimmed = base.replace(/\/+$/, "");
    const cut = trimmed.lastIndexOf("/");
    return cut <= 0 ? "/" : trimmed.slice(0, cut);
  }
  return `${base.replace(/\/+$/, "")}/${name}`;
}

/** Render a mode integer the way `ls -l` does. */
export function formatMode(mode: number): string {
  const type =
    (mode & 0o170000) === 0o040000 ? "d"
    : (mode & 0o170000) === 0o120000 ? "l"
    : "-";
  const bit = (m: number, ch: string) => ((mode & m) ? ch : "-");
  return (
    type +
    bit(0o400, "r") + bit(0o200, "w") + bit(0o100, "x") +
    bit(0o040, "r") + bit(0o020, "w") + bit(0o010, "x") +
    bit(0o004, "r") + bit(0o002, "w") + bit(0o001, "x")
  );
}

function entryType(mode: number): RemoteEntry["type"] {
  const t = mode & 0o170000;
  if (t === 0o040000) return "directory";
  if (t === 0o100000) return "file";
  if (t === 0o120000) return "symlink";
  return "other";
}

/** Promisified `client.sftp()`. */
function openSftp(ssh: SSH2Client): Promise<any> {
  return new Promise((resolve, reject) => {
    ssh.sftp((err: Error | undefined, sftp: any) => {
      if (err) reject(err);
      else resolve(sftp);
    });
  });
}

/**
 * Run one operation against a fresh SFTP channel and close it.
 *
 * A channel per operation rather than a long-lived one: listings are quick,
 * and a channel held open across an idle UI is a resource leak that only shows
 * up on servers with low `MaxSessions`. Transfers get their own channel that
 * lives as long as the transfer.
 */
async function withSftp<T>(ssh: SSH2Client, fn: (sftp: any) => Promise<T>): Promise<T> {
  const sftp = await openSftp(ssh);
  try {
    return await fn(sftp);
  } finally {
    try { sftp.end(); } catch { /* channel already gone */ }
  }
}

export async function listDirectory(
  ssh: SSH2Client,
  dir: string,
): Promise<{ path: string; entries: RemoteEntry[] }> {
  return withSftp(ssh, async (sftp) => {
    const resolved: string = await new Promise((resolve, reject) => {
      sftp.realpath(dir || ".", (err: any, p: string) => (err ? reject(err) : resolve(p)));
    });

    const raw: any[] = await new Promise((resolve, reject) => {
      sftp.readdir(resolved, (err: any, list: any[]) => (err ? reject(err) : resolve(list)));
    });

    const entries: RemoteEntry[] = raw.map((item) => {
      const mode = item.attrs?.mode ?? 0;
      return {
        name: item.filename,
        path: remoteJoin(resolved, item.filename),
        type: entryType(mode),
        size: item.attrs?.size ?? 0,
        modified: (item.attrs?.mtime ?? 0) * 1000,
        perms: formatMode(mode),
      };
    });

    // Directories first, then case-insensitive by name — the order every file
    // manager uses, and the one people can scan without thinking.
    entries.sort((a, b) => {
      const ad = a.type === "directory" ? 0 : 1;
      const bd = b.type === "directory" ? 0 : 1;
      if (ad !== bd) return ad - bd;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });

    return { path: resolved, entries };
  });
}

export async function makeDirectory(ssh: SSH2Client, path: string): Promise<void> {
  return withSftp(ssh, (sftp) =>
    new Promise((resolve, reject) => {
      sftp.mkdir(path, (err: any) => (err ? reject(err) : resolve()));
    }),
  );
}

export async function rename(ssh: SSH2Client, from: string, to: string): Promise<void> {
  return withSftp(ssh, (sftp) =>
    new Promise((resolve, reject) => {
      sftp.rename(from, to, (err: any) => (err ? reject(err) : resolve()));
    }),
  );
}

/**
 * Delete a file or an empty directory.
 *
 * Recursive delete is deliberately absent. A file manager that can wipe a tree
 * on a production server with one mis-click is the kind of feature that
 * belongs behind the same thinking as the command guardrails, not shipped
 * quietly alongside a listing view.
 */
export async function remove(
  ssh: SSH2Client,
  path: string,
  isDirectory: boolean,
): Promise<void> {
  return withSftp(ssh, (sftp) =>
    new Promise((resolve, reject) => {
      const done = (err: any) => (err ? reject(err) : resolve());
      if (isDirectory) sftp.rmdir(path, done);
      else sftp.unlink(path, done);
    }),
  );
}

export interface TransferProgress {
  transferred: number;
  total: number;
}

/**
 * Download a remote file to a local path.
 *
 * Streamed rather than buffered: `app.log` in the mockup is 128 MB and a
 * backup archive is 2.4 GB. Reading either into memory would take the app down.
 */
export async function download(
  ssh: SSH2Client,
  remotePath: string,
  localPath: string,
  onProgress?: (p: TransferProgress) => void,
  signal?: { cancelled: boolean },
): Promise<void> {
  const sftp = await openSftp(ssh);
  try {
    const total: number = await new Promise((resolve) => {
      sftp.stat(remotePath, (err: any, attrs: any) =>
        resolve(err ? 0 : (attrs?.size ?? 0)),
      );
    });

    await new Promise<void>((resolve, reject) => {
      const read = sftp.createReadStream(remotePath);
      const write = createWriteStream(localPath);
      let transferred = 0;

      const fail = (err: Error) => {
        try { read.destroy(); } catch { /* already gone */ }
        try { write.destroy(); } catch { /* already gone */ }
        reject(err);
      };

      // A stream's data event is typed as string | Buffer because encoding can
      // change it. These are binary and always Buffer, but `.length` differs
      // between the two — characters versus bytes — so the byte count is taken
      // explicitly rather than trusting whichever arrives.
      read.on("data", (chunk: string | Buffer) => {
        transferred += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
        if (signal?.cancelled) {
          fail(new Error("Transfer cancelled"));
          return;
        }
        onProgress?.({ transferred, total });
      });
      read.on("error", fail);
      write.on("error", fail);
      write.on("finish", () => resolve());
      read.pipe(write);
    });
  } finally {
    try { sftp.end(); } catch { /* channel already gone */ }
  }
}

/** Upload a local file to a remote path. Streamed, for the same reason. */
export async function upload(
  ssh: SSH2Client,
  localPath: string,
  remotePath: string,
  onProgress?: (p: TransferProgress) => void,
  signal?: { cancelled: boolean },
): Promise<void> {
  const { size: total } = await fsStat(localPath);
  const sftp = await openSftp(ssh);
  try {
    await new Promise<void>((resolve, reject) => {
      const read = createReadStream(localPath);
      const write = sftp.createWriteStream(remotePath);
      let transferred = 0;

      const fail = (err: Error) => {
        try { read.destroy(); } catch { /* already gone */ }
        try { write.destroy(); } catch { /* already gone */ }
        reject(err);
      };

      // A stream's data event is typed as string | Buffer because encoding can
      // change it. These are binary and always Buffer, but `.length` differs
      // between the two — characters versus bytes — so the byte count is taken
      // explicitly rather than trusting whichever arrives.
      read.on("data", (chunk: string | Buffer) => {
        transferred += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
        if (signal?.cancelled) {
          fail(new Error("Transfer cancelled"));
          return;
        }
        onProgress?.({ transferred, total });
      });
      read.on("error", fail);
      write.on("error", fail);
      write.on("close", () => resolve());
      read.pipe(write);
    });
  } finally {
    try { sftp.end(); } catch { /* channel already gone */ }
  }
}
