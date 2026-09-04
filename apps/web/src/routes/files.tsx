import { useEffect, useRef, useState, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { AppShell } from "@/components/shell";
import { apiGet, apiPost } from "@/lib/api";
import { toast } from "@/lib/toast";
import * as I from "@/components/icons";
import "@/styles/files.css";

/**
 * Dual-pane file manager — this machine on the left, the server on the right.
 *
 * The remote pane works over the SSH connection of an *open* session, so file
 * access inherits whatever gated that session. That's why this screen asks you
 * to pick a connected host rather than offering every host you've saved: if it
 * connected on its own, someone blocked from a `prod` shell by break-glass
 * could read the same machine's files instead, and the gate would be decorative.
 */

interface Entry {
  name: string;
  path: string;
  type: "file" | "directory" | "symlink" | "other";
  size: number;
  modified: number;
  perms: string;
}

interface Transfer {
  id: string;
  direction: "up" | "down";
  name: string;
  target: string;
  transferred: number;
  total: number;
  state: "running" | "done" | "error" | "cancelled";
  message?: string;
}

function fmtSize(bytes: number, isDir: boolean): string {
  if (isDir) return "--";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

function fmtDate(ms: number): string {
  if (!ms) return "--";
  const d = new Date(ms);
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${months[d.getMonth()]} ${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function FilesRoute() {
  const [hostId, setHostId] = useState<string | null>(null);
  const [localPath, setLocalPath] = useState<string>("");
  const [remotePath, setRemotePath] = useState<string>(".");
  const [local, setLocal] = useState<{ path: string; parent: string; entries: Entry[] } | null>(null);
  const [remote, setRemote] = useState<{ path: string; entries: Entry[] } | null>(null);
  const [remoteError, setRemoteError] = useState<string>("");
  const [selLocal, setSelLocal] = useState<string | null>(null);
  const [selRemote, setSelRemote] = useState<string | null>(null);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [busy, setBusy] = useState(false);
  // Fault 18: pending create/rename/delete. `value` holds the typed name for
  // mkdir and rename, and is unused for delete.
  const [dlg, setDlg] = useState<
    | { kind: "mkdir" | "rename" | "delete"; side: "local" | "remote"; entry: Entry | null; value: string }
    | null
  >(null);

  // Keyboard cursor, separate from selection. Selection means "this is the
  // file Upload/Download will act on" and only ever holds a file; the cursor
  // is where the keyboard is, and can sit on a directory so you can walk into
  // one without touching the mouse.
  const [curLocal, setCurLocal] = useState<string | null>(null);
  const [curRemote, setCurRemote] = useState<string | null>(null);
  const localListRef = useRef<HTMLDivElement>(null);
  const remoteListRef = useRef<HTMLDivElement>(null);
  const localBuf = useRef({ q: "", at: 0 });
  const remoteBuf = useRef({ q: "", at: 0 });

  const hosts = useQuery({ queryKey: ["hosts"], queryFn: () => apiGet<any[]>("/api/hosts") });

  // Live transfer progress. Polling would leave a 2 GB copy sitting at 0%.
  useEffect(() => {
    const unsub = (window as any).skiff?.on?.("files:transfer", (t: Transfer) => {
      setTransfers((prev) => {
        const next = prev.filter((x) => x.id !== t.id);
        return [t, ...next].slice(0, 12);
      });
    });
    return () => unsub?.();
  }, []);

  const loadLocal = useCallback(async (path?: string) => {
    try {
      const res = await apiPost<any>("/api/files/local", path ? { path } : {});
      setLocal(res);
      setLocalPath(res.path);
    } catch (e: any) {
      toast.error("Couldn't open that folder", { description: e?.message });
    }
  }, []);

  const loadRemote = useCallback(async (id: string, path: string) => {
    setRemoteError("");
    try {
      const res = await apiPost<any>("/api/files/list", { hostId: id, path });
      setRemote(res);
      setRemotePath(res.path);
    } catch (e: any) {
      setRemote(null);
      setRemoteError(e?.message || "Couldn't read that directory");
    }
  }, []);

  // A cursor pointing at a row that no longer exists would leave the arrows
  // starting from nowhere after a navigate or refresh.
  useEffect(() => { setCurLocal(null); localBuf.current = { q: "", at: 0 }; }, [local?.path]);
  useEffect(() => { setCurRemote(null); remoteBuf.current = { q: "", at: 0 }; }, [remote?.path]);

  useEffect(() => { void loadLocal(); }, [loadLocal]);
  useEffect(() => { if (hostId) void loadRemote(hostId, "."); }, [hostId, loadRemote]);

  const openLocal = (e: Entry) => {
    if (e.type === "directory") { setSelLocal(null); void loadLocal(e.path); }
    else setSelLocal(e.path);
  };

  const openRemote = (e: Entry) => {
    if (e.type === "directory") { setSelRemote(null); void loadRemote(hostId!, e.path); }
    else setSelRemote(e.path);
  };

  /**
   * Type-ahead and arrow navigation for a file pane.
   *
   * A file list you can only reach with the mouse is slow in exactly the case
   * that matters — a directory with hundreds of entries. Typing jumps to the
   * first name with that prefix, the way every file manager does.
   *
   * The buffer resets after a pause, so "re" finds "réponse" while r, r, r
   * taken slowly cycles through everything starting with r.
   */
  const makeKeyHandler = (
    entries: Entry[],
    cursor: string | null,
    setCursor: (v: string | null) => void,
    setSel: (v: string | null) => void,
    open: (e: Entry) => void,
    buf: React.MutableRefObject<{ q: string; at: number }>,
    listRef: React.RefObject<HTMLDivElement>,
  ) => (ev: React.KeyboardEvent<HTMLDivElement>) => {
    if (!entries.length) return;
    if (ev.ctrlKey || ev.altKey || ev.metaKey) return;

    const at = entries.findIndex((e) => e.path === cursor);
    const idx = at === -1 ? 0 : at;

    const moveTo = (j: number) => {
      const next = entries[Math.max(0, Math.min(entries.length - 1, j))];
      if (!next) return;
      setCursor(next.path);
      // Keep the transfer buttons in step: a directory is not a transfer
      // target, so landing on one clears the selection rather than leaving a
      // stale file selected somewhere off screen.
      setSel(next.type === "file" ? next.path : null);
      const row = listRef.current?.querySelector(
        `[data-idx="${entries.indexOf(next)}"]`,
      );
      row?.scrollIntoView({ block: "nearest" });
    };

    if (ev.key === "ArrowDown") moveTo(idx + 1);
    else if (ev.key === "ArrowUp") moveTo(idx - 1);
    else if (ev.key === "Home") moveTo(0);
    else if (ev.key === "End") moveTo(entries.length - 1);
    else if (ev.key === "Enter") {
      const cur = entries[idx];
      if (cur) open(cur);
    } else if (ev.key.length === 1 && ev.key !== " ") {
      const now = Date.now();
      buf.current.q = now - buf.current.at > 700 ? ev.key : buf.current.q + ev.key;
      buf.current.at = now;
      const typed = buf.current.q.toLowerCase();
      // Pressing the same letter repeatedly means "show me the next one", not
      // "find a name starting rrr". Without this, the second press built a
      // prefix that matched nothing and the cursor simply stopped moving —
      // which looked like the search failing to wrap.
      const repeated = typed.length > 1 && /^(.)*$/.test(typed);
      const q = repeated ? typed[0]! : typed;
      // One character starts from the row after the cursor so repeats cycle,
      // wrapping past the end; a real prefix searches from the top so it stays
      // stable as you keep typing.
      const from = q.length === 1 ? idx + 1 : 0;
      for (let i = 0; i < entries.length; i++) {
        const j = (from + i) % entries.length;
        if (entries[j]!.name.toLowerCase().startsWith(q)) {
          moveTo(j);
          break;
        }
      }
    } else return;

    ev.preventDefault();
  };

  const upload = async () => {
    if (!hostId || !selLocal || !remote) return;
    setBusy(true);
    try {
      await apiPost("/api/files/upload", { hostId, localPath: selLocal, remoteDir: remote.path });
      await loadRemote(hostId, remote.path);
    } catch (e: any) {
      toast.error("Upload failed", { description: e?.message });
    } finally { setBusy(false); }
  };

  const download = async () => {
    if (!hostId || !selRemote || !local) return;
    setBusy(true);
    try {
      await apiPost("/api/files/download", { hostId, remotePath: selRemote, localDir: local.path });
      await loadLocal(local.path);
    } catch (e: any) {
      toast.error("Download failed", { description: e?.message });
    } finally { setBusy(false); }
  };

  // ── Fault 18: create, rename and delete ────────────────────────────────
  //
  // `files:mkdir`, `files:rename`, `files:delete` and their `files:local*`
  // twins were already declared in the IPC contract, allowed by the preload
  // and implemented in the main process — nothing in this screen ever called
  // them. These wire the existing engine calls to the existing rows.
  //
  // Actions operate on the *cursor* row, not the selection: `selLocal` /
  // `selRemote` are deliberately set to null for directories (they drive
  // upload/download, which only take files), so using them here would make
  // it impossible to rename or delete a folder.

  const sep = (p: string) => (p.includes("\\") && !p.startsWith("/") ? "\\" : "/");
  const dirOf = (p: string) => {
    const s = sep(p);
    const i = p.lastIndexOf(s);
    return i <= 0 ? p.slice(0, i + 1) || s : p.slice(0, i);
  };
  const joinPath = (dir: string, name: string) => {
    const s = sep(dir);
    return dir.endsWith(s) ? dir + name : dir + s + name;
  };

  const entryAt = (side: "local" | "remote", path: string | null): Entry | null => {
    if (!path) return null;
    const list = side === "local" ? local?.entries : remote?.entries;
    return (list ?? []).find((e) => e.path === path) ?? null;
  };

  const reload = async (side: "local" | "remote") => {
    if (side === "local") { if (local) await loadLocal(local.path); }
    else if (hostId && remote) await loadRemote(hostId, remote.path);
  };

  const runAction = async () => {
    if (!dlg) return;
    const { kind, side, entry } = dlg;
    const name = dlg.value.trim();

    if (kind !== "delete") {
      if (!name) { toast.error("A name is required"); return; }
      // A separator here would silently move the file somewhere else rather
      // than rename it, which is not what the dialog says it does.
      if (name.includes("/") || name.includes("\\")) {
        toast.error("A name cannot contain a path separator");
        return;
      }
    }

    setBusy(true);
    try {
      if (side === "local") {
        if (kind === "mkdir") {
          if (!local) return;
          await apiPost("/api/files/local/mkdir", { path: joinPath(local.path, name) });
        } else if (kind === "rename" && entry) {
          await apiPost("/api/files/local/rename", {
            from: entry.path,
            to: joinPath(dirOf(entry.path), name),
          });
        } else if (kind === "delete" && entry) {
          await apiPost("/api/files/local/delete", {
            path: entry.path,
            isDirectory: entry.type === "directory",
          });
        }
      } else {
        if (!hostId) return;
        if (kind === "mkdir") {
          if (!remote) return;
          await apiPost("/api/files/mkdir", { hostId, path: joinPath(remote.path, name) });
        } else if (kind === "rename" && entry) {
          await apiPost("/api/files/rename", {
            hostId,
            from: entry.path,
            to: joinPath(dirOf(entry.path), name),
          });
        } else if (kind === "delete" && entry) {
          await apiPost("/api/files/delete", {
            hostId,
            path: entry.path,
            isDirectory: entry.type === "directory",
          });
        }
      }

      // A deleted row must not stay selected or under the cursor: both are
      // matched by path, and that path no longer exists.
      if (kind === "delete" && entry) {
        if (side === "local") {
          if (selLocal === entry.path) setSelLocal(null);
          if (curLocal === entry.path) setCurLocal(null);
        } else {
          if (selRemote === entry.path) setSelRemote(null);
          if (curRemote === entry.path) setCurRemote(null);
        }
      }

      setDlg(null);
      await reload(side);
    } catch (e: any) {
      // The server's own reason is more useful than anything invented here —
      // "Permission denied" and "Directory not empty" are both ordinary
      // answers, and recursive delete is deliberately not offered.
      toast.error(
        kind === "mkdir" ? "Couldn't create that folder"
          : kind === "rename" ? "Couldn't rename that"
          : "Couldn't delete that",
        { description: e?.message },
      );
    } finally { setBusy(false); }
  };

  const active = transfers.filter((t) => t.state === "running");
  const connected = (hosts.data ?? []).filter((h: any) => h.id);

  return (
    <AppShell title="skiff — files" sidebar={{}} hideToolbar>
      <div className="fm">
        <div className="fm-panes">
          {/* ── Local ── */}
          <section className="fm-pane">
            <header className="fm-pane__head">
              <I.Server size={13} />
              <span className="fm-pane__title">This computer</span>
            </header>

            <div className="fm-bar">
              <button
                className="fm-nav"
                title="Up one folder"
                onClick={() => local && loadLocal(local.parent)}
                disabled={!local || local.path === local.parent}
              >
                <I.ChevronLeft size={13} style={{ transform: "rotate(90deg)" }} />
              </button>
              <button className="fm-nav" title="Refresh" onClick={() => loadLocal(localPath)}>
                <I.Refresh size={13} />
              </button>
              <button
                className="fm-nav"
                title="New folder"
                onClick={() => setDlg({ kind: "mkdir", side: "local", entry: null, value: "" })}
                disabled={!local}
              >
                <I.FolderPlus size={13} />
              </button>
              <button
                className="fm-nav"
                title="Rename"
                onClick={() => {
                  const en = entryAt("local", curLocal);
                  if (en) setDlg({ kind: "rename", side: "local", entry: en, value: en.name });
                }}
                disabled={!curLocal}
              >
                <I.Pencil size={13} />
              </button>
              <button
                className="fm-nav"
                title="Delete"
                onClick={() => {
                  const en = entryAt("local", curLocal);
                  if (en) setDlg({ kind: "delete", side: "local", entry: en, value: "" });
                }}
                disabled={!curLocal}
              >
                <I.Trash size={13} />
              </button>
              <input
                className="fm-path"
                value={localPath}
                onChange={(e) => setLocalPath(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void loadLocal(localPath); }}
                spellCheck={false}
              />
            </div>

            <div className="fm-cols">
              <span className="c-name">Name</span>
              <span className="c-size">Size</span>
              <span className="c-mod">Modified</span>
            </div>

            <div
              className="fm-list"
              ref={localListRef}
              tabIndex={0}
              onKeyDown={makeKeyHandler(
                local?.entries ?? [],
                curLocal,
                setCurLocal,
                setSelLocal,
                openLocal,
                localBuf,
                localListRef,
              )}
            >
              {(local?.entries ?? []).map((e, i) => (
                <div
                  key={e.path}
                  data-idx={i}
                  className={`fm-row${selLocal === e.path ? " is-selected" : ""}${curLocal === e.path ? " is-cursor" : ""}`}
                  onClick={() => {
                    setCurLocal(e.path);
                    setSelLocal(e.type === "file" ? e.path : null);
                  }}
                  onDoubleClick={() => openLocal(e)}
                >
                  <span className="c-name">
                    {e.type === "directory" ? <I.Folder size={13} /> : <I.Empty size={13} />}
                    {e.name}
                  </span>
                  <span className="c-size">{fmtSize(e.size, e.type === "directory")}</span>
                  <span className="c-mod">{fmtDate(e.modified)}</span>
                </div>
              ))}
              {local && local.entries.length === 0 && (
                <div className="fm-empty">This folder is empty.</div>
              )}
            </div>

            <footer className="fm-pane__foot">
              <span>{local?.entries.length ?? 0} items</span>
            </footer>
          </section>

          {/* ── Transfer arrows ── */}
          <div className="fm-actions">
            <button
              className="fm-move"
              title="Upload to server"
              disabled={!hostId || !selLocal || busy}
              onClick={upload}
            >
              <I.ArrowRight size={15} />
            </button>
            <button
              className="fm-move"
              title="Download to this computer"
              disabled={!hostId || !selRemote || busy}
              onClick={download}
            >
              <I.ArrowRight size={15} style={{ transform: "rotate(180deg)" }} />
            </button>
          </div>

          {/* ── Remote ── */}
          <section className="fm-pane">
            <header className="fm-pane__head">
              <span className={`fm-dot${hostId ? " is-live" : ""}`} />
              <select
                className="fm-hostpick"
                value={hostId ?? ""}
                onChange={(e) => {
                  setHostId(e.target.value || null);
                  // A native select keeps focus and has its own type-ahead, so
                  // a stray letter afterwards would silently switch hosts and
                  // reload the pane somewhere else.
                  e.target.blur();
                }}
              >
                <option value="">Choose a host…</option>
                {connected.map((h: any) => (
                  <option key={h.id} value={h.id}>{h.label || h.hostname}</option>
                ))}
              </select>
            </header>

            <div className="fm-bar">
              <button
                className="fm-nav"
                title="Up one folder"
                disabled={!remote || remote.path === "/"}
                onClick={() => remote && loadRemote(hostId!, `${remote.path.replace(/\/+$/, "")}/..`)}
              >
                <I.ChevronLeft size={13} style={{ transform: "rotate(90deg)" }} />
              </button>
              <button
                className="fm-nav"
                title="Refresh"
                disabled={!hostId}
                onClick={() => hostId && loadRemote(hostId, remotePath)}
              >
                <I.Refresh size={13} />
              </button>
              <button
                className="fm-nav"
                title="New folder"
                onClick={() => setDlg({ kind: "mkdir", side: "remote", entry: null, value: "" })}
                disabled={!hostId || !remote}
              >
                <I.FolderPlus size={13} />
              </button>
              <button
                className="fm-nav"
                title="Rename"
                onClick={() => {
                  const en = entryAt("remote", curRemote);
                  if (en) setDlg({ kind: "rename", side: "remote", entry: en, value: en.name });
                }}
                disabled={!hostId || !curRemote}
              >
                <I.Pencil size={13} />
              </button>
              <button
                className="fm-nav"
                title="Delete"
                onClick={() => {
                  const en = entryAt("remote", curRemote);
                  if (en) setDlg({ kind: "delete", side: "remote", entry: en, value: "" });
                }}
                disabled={!hostId || !curRemote}
              >
                <I.Trash size={13} />
              </button>
              <input
                className="fm-path"
                value={remotePath}
                disabled={!hostId}
                onChange={(e) => setRemotePath(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && hostId) void loadRemote(hostId, remotePath); }}
                spellCheck={false}
              />
            </div>

            <div className="fm-cols">
              <span className="c-name">Name</span>
              <span className="c-size">Size</span>
              <span className="c-mod">Modified</span>
              <span className="c-perms">Perms</span>
            </div>

            <div
              className="fm-list"
              ref={remoteListRef}
              tabIndex={0}
              onKeyDown={makeKeyHandler(
                remote?.entries ?? [],
                curRemote,
                setCurRemote,
                setSelRemote,
                openRemote,
                remoteBuf,
                remoteListRef,
              )}
            >
              {!hostId && (
                <div className="fm-empty">
                  Pick a host above to browse its files.
                </div>
              )}

              {/* The one message on this screen that has to be exact: file
                  access uses an existing session, so "not connected" is a
                  normal state, not a failure. */}
              {hostId && remoteError && (
                <div className="fm-notice">
                  <I.Info size={15} />
                  <div>
                    <strong>{remoteError}</strong>
                    <p>
                      Skiff browses files over the connection you already have, so
                      nothing is authenticated twice and any approval that gated
                      the session gates the files too.
                    </p>
                  </div>
                </div>
              )}

              {hostId && !remoteError && (remote?.entries ?? []).map((e, i) => (
                <div
                  key={e.path}
                  data-idx={i}
                  className={`fm-row${selRemote === e.path ? " is-selected" : ""}${curRemote === e.path ? " is-cursor" : ""}`}
                  onClick={() => {
                    setCurRemote(e.path);
                    setSelRemote(e.type === "file" ? e.path : null);
                  }}
                  onDoubleClick={() => openRemote(e)}
                >
                  <span className="c-name">
                    {e.type === "directory" ? <I.Folder size={13} /> : <I.Empty size={13} />}
                    {e.name}
                  </span>
                  <span className="c-size">{fmtSize(e.size, e.type === "directory")}</span>
                  <span className="c-mod">{fmtDate(e.modified)}</span>
                  <span className="c-perms">{e.perms}</span>
                </div>
              ))}
            </div>

            <footer className="fm-pane__foot">
              <span>{remote?.entries.length ?? 0} items</span>
            </footer>
          </section>
        </div>

        {/* ── Transfers ── */}
        {transfers.length > 0 && (
          <div className="fm-transfers">
            <div className="fm-transfers__head">
              <span className="fm-transfers__title">Transfers</span>
              {active.length > 0 && (
                <span className="fm-transfers__active">
                  <span className="dot" />
                  {active.length} active
                </span>
              )}
              <button className="fm-transfers__clear" onClick={() => setTransfers([])}>
                Clear finished
              </button>
            </div>

            {transfers.map((t) => {
              const pct = t.total > 0 ? Math.round((t.transferred / t.total) * 100) : 0;
              return (
                <div key={t.id} className={`fm-transfer is-${t.state}`}>
                  <span className="fm-transfer__dir">
                    <I.ArrowRight
                      size={11}
                      style={t.direction === "down" ? { transform: "rotate(180deg)" } : undefined}
                    />
                  </span>
                  <span className="fm-transfer__name">{t.name}</span>
                  <span className="fm-transfer__target">→ {t.target}</span>
                  <span className="fm-transfer__track">
                    <span
                      className="fm-transfer__fill"
                      style={{ width: `${t.state === "done" ? 100 : pct}%` }}
                    />
                  </span>
                  <span className="fm-transfer__state">
                    {t.state === "running" ? `${pct}%`
                      : t.state === "done" ? "done"
                      : t.state === "cancelled" ? "cancelled"
                      : t.message || "failed"}
                  </span>
                  {t.state === "running" && (
                    <button
                      className="fm-transfer__cancel"
                      title="Cancel"
                      onClick={() => apiPost("/api/files/cancel", { id: t.id })}
                    >
                      <I.Close size={11} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Fault 18. Reuses the shared .dialog markup already used by the
          add-host and delete-recording dialogs, including the overlay's
          target check — never a native confirm() (fault 45). */}
      {dlg && (
        <div
          className="dialog-overlay"
          onClick={(e) => { if (e.target === e.currentTarget) setDlg(null); }}
        >
          <div
            className="dialog"
            role="dialog"
            aria-label={
              dlg.kind === "mkdir" ? "New folder"
                : dlg.kind === "rename" ? "Rename"
                : "Delete"
            }
          >
            <div className="dialog__head">
              <h2>
                {dlg.kind === "mkdir" ? "New folder"
                  : dlg.kind === "rename" ? "Rename"
                  : dlg.entry?.type === "directory" ? "Delete this folder?" : "Delete this file?"}
              </h2>
            </div>

            <div className="dialog__body">
              {dlg.kind === "delete" ? (
                <>
                  <p style={{ margin: "0 0 10px", fontSize: 13, lineHeight: 1.55, color: "var(--fg-1)" }}>
                    {dlg.entry?.type === "directory"
                      ? "The folder must already be empty. Skiff does not delete folder contents recursively."
                      : "This cannot be undone."}
                    {dlg.side === "remote" ? " It is removed on the server." : " It is removed from this computer."}
                  </p>
                  <p style={{ margin: 0, fontSize: 12.5, color: "var(--fg-2)", fontFamily: "var(--font-mono)", overflowWrap: "anywhere" }}>
                    {dlg.entry?.path}
                  </p>
                </>
              ) : (
                <>
                  <label
                    htmlFor="fm-dlg-name"
                    style={{ display: "block", fontSize: 12.5, color: "var(--fg-2)", marginBottom: 6 }}
                  >
                    Name
                  </label>
                  <input
                    id="fm-dlg-name"
                    className="fm-path"
                    style={{ width: "100%" }}
                    autoFocus
                    value={dlg.value}
                    spellCheck={false}
                    onChange={(e) => setDlg({ ...dlg, value: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void runAction();
                      if (e.key === "Escape") setDlg(null);
                    }}
                  />
                  <p style={{ margin: "10px 0 0", fontSize: 12.5, color: "var(--fg-2)", fontFamily: "var(--font-mono)", overflowWrap: "anywhere" }}>
                    {dlg.kind === "mkdir"
                      ? (dlg.side === "local" ? local?.path : remote?.path)
                      : dlg.entry?.path}
                  </p>
                </>
              )}
            </div>

            <div className="dialog__foot">
              <button className="btn btn--secondary" onClick={() => setDlg(null)}>Cancel</button>
              <button
                className={dlg.kind === "delete" ? "btn btn--danger" : "btn btn--primary"}
                disabled={busy || (dlg.kind !== "delete" && !dlg.value.trim())}
                onClick={() => void runAction()}
              >
                {busy ? "Working…"
                  : dlg.kind === "mkdir" ? "Create folder"
                  : dlg.kind === "rename" ? "Rename"
                  : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}
