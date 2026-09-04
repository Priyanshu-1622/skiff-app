import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { AppShell } from "@/components/shell";
import { useTabs } from "@/lib/tabs";
import { useVault } from "@/lib/vault";
import { useTheme } from "@/lib/theme";
import { apiGet, apiPost, apiPut, apiDelete } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useFolderFilter } from "@/lib/folder-filter";
import * as I from "@/components/icons";

export function DashboardRoute() {
  const navigate = useNavigate();
  const { status, loading, fetchStatus, lock } = useVault();

  // Explicit logout. We call the lock endpoint, then do a HARD browser
  // redirect (window.location) rather than client-side routing. A full page
  // load discards all in-memory state, so there is no stale status left to
  // bounce us back to the dashboard — the fresh load sees the cleared session
  // and lands on the login/unlock screen for good.
  const handleLogout = async () => {
    const mode = status?.mode;
    try {
      await lock();
    } catch { /* redirect regardless */ }
    window.location.href = mode === "team" ? "/login" : "/unlock";
  };
  const { theme, toggle } = useTheme();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [view, setView] = useState<"grid" | "list">("grid");
  const [hoverHost, setHoverHost] = useState<string | null>(null);
  // Shared with the sidebar, which renders on every screen and needs the
  // same value; see lib/folder-filter.
  const activeFolder = useFolderFilter((s) => s.active);
  const setActiveFolder = useFolderFilter((s) => s.setActive);
  const [showAdd, setShowAdd] = useState(false);
  const openTab = useTabs((s) => s.open);
  const [editHost, setEditHost] = useState<any | null>(null);
  const [showAddFolder, setShowAddFolder] = useState(false);
  const [folderToDelete, setFolderToDelete] = useState<{ id: string; name: string } | null>(null);
  const [hostToDelete, setHostToDelete] = useState<any | null>(null);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);
  useEffect(() => {
    if (!loading && status && !status.unlocked) {
      navigate({ to: status.mode === "team" ? "/login" : "/unlock" });
    }
  }, [loading, status, navigate]);

  // Re-render every minute so timeAgo values stay fresh
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  // Focus the search bar when "/" is pressed
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (e.key === "/" && tag !== "INPUT" && tag !== "TEXTAREA") {
        e.preventDefault();
        const input = document.querySelector<HTMLInputElement>(".topbar__search input");
        input?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const hosts = useQuery({
    queryKey: ["hosts", activeFolder, search],
    queryFn: () => {
      const p = new URLSearchParams();
      if (activeFolder && activeFolder !== "__starred") p.set("folderId", activeFolder);
      if (activeFolder === "__starred") p.set("starred", "true");
      if (search) p.set("search", search);
      return apiGet<any[]>(`/api/hosts?${p}`);
    },
    enabled: !!status?.unlocked,
  });

  const folders = useQuery({
    queryKey: ["folders"],
    queryFn: () => apiGet<any[]>("/api/folders"),
    enabled: !!status?.unlocked,
  });

  const deleteHost = useMutation({
    mutationFn: (id: string) => apiDelete(`/api/hosts/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["hosts"] });
      setHostToDelete(null);
      toast.success("Host deleted");
    },
    onError: (error: any) => {
      toast.error("Couldn't delete that host", { description: error?.message });
      setHostToDelete(null);
    },
  });

  const createFolder = useMutation({
    mutationFn: (name: string) => apiPost("/api/folders", { name, parentId: null }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["folders"] });
      setShowAddFolder(false);
      toast.success("Folder created");
    },
    onError: (error: any) => {
      toast.error("Couldn't create the folder", { description: error?.message });
    },
  });

  const deleteFolder = useMutation({
    mutationFn: (id: string) => apiDelete(`/api/folders/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["folders"] });
      queryClient.invalidateQueries({ queryKey: ["hosts"] });
      setFolderToDelete(null);
      if (activeFolder && !["__starred", null].includes(activeFolder as any)) {
        setActiveFolder(null);
      }
      toast.success("Folder deleted");
    },
    onError: (error: any) => {
      toast.error("Couldn't delete the folder", { description: error?.message });
      setFolderToDelete(null);
    },
  });

  const toggleStar = useMutation({
    mutationFn: (host: any) => apiPut(`/api/hosts/${host.id}`, {
      label: host.label,
      hostname: host.hostname,
      port: host.port,
      username: host.username,
      folderId: host.folder_id,
      authMethod: host.auth_method,
      tags: toTags(host.tags),
      starred: !host.starred,
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["hosts"] }),
    onError: (error: any) => {
      toast.error("That didn't save", { description: error?.message });
      queryClient.invalidateQueries({ queryKey: ["hosts"] });
    },
  });

  const hostList = hosts.data ?? [];
  const folderList = folders.data ?? [];
  const sidebarFolders = folderList.map((f: any) => ({
    id: f.id, name: f.name,
    count: hostList.filter((h: any) => h.folder_id === f.id).length,
  }));

  if (loading) return (
    <div style={{ display: "grid", placeItems: "center", height: "100vh", background: "var(--bg-0)", color: "var(--fg-2)", fontFamily: "var(--font-mono)", fontSize: 13 }}>
      Connecting to Skiff…
    </div>
  );

  if (!status) return (
    <div style={{ display: "grid", placeItems: "center", height: "100vh", background: "var(--bg-0)", color: "var(--fg-1)", gap: 16, textAlign: "center" }}>
      <div>
        <div style={{ fontSize: 32, marginBottom: 12 }}>⚠</div>
        <div style={{ fontSize: 15, fontWeight: 600, color: "var(--fg-0)" }}>Couldn't load the vault</div>
        <div style={{ fontSize: 13, color: "var(--fg-2)", marginTop: 6 }}>Something went wrong reaching the local engine.</div>
        <button className="btn btn--primary" style={{ marginTop: 16 }} onClick={() => fetchStatus()}>Retry</button>
      </div>
    </div>
  );

  const connectToHost = (hostId: string) => {
    const host = (hosts.data ?? []).find((h: any) => h.id === hostId);
    openTab({ hostId, label: host?.label || host?.hostname || hostId });
    navigate({ to: "/terminal/$hostId", params: { hostId } });
  };

  return (
    <AppShell
      sessions={0}
      title="skiff"
      toolbar={{
        searchValue: search,
        onSearchChange: setSearch,
        actions: (
          <>
            <div className="viewtoggle" role="group" aria-label="View mode">
              <button
                type="button"
                className={view === "grid" ? "active" : ""}
                onClick={() => setView("grid")}
                title="Grid view"
                aria-pressed={view === "grid"}
              >
                <I.Server size={14} />
              </button>
              <button
                type="button"
                className={view === "list" ? "active" : ""}
                onClick={() => setView("list")}
                title="List view"
                aria-pressed={view === "list"}
              >
                <I.Tag size={14} />
              </button>
            </div>
            <button type="button" className="icon-btn" onClick={toggle} title="Toggle theme">
              {theme === "dark" ? <I.Sun size={14} /> : <I.Moon size={14} />}
            </button>
            <button type="button" className="btn btn--primary" onClick={() => setShowAdd(true)}>
              <I.Plus size={12} />
              Add host
            </button>
          </>
        ),
      }}
      sidebar={{
        totalHosts: (hosts.data ?? []).length,
        favoritesCount: (hosts.data ?? []).filter((h: any) => h.starred).length,
        folders: sidebarFolders,
        activeFolderId: activeFolder,
        onSelectFolder: setActiveFolder,
        onAddFolder: () => setShowAddFolder(true),
        onDeleteFolder: (id: string) => {
          const folder = folderList.find((f: any) => f.id === id);
          if (folder) setFolderToDelete({ id: folder.id, name: folder.name });
        },
        vault: status ? { unlocked: status.unlocked, idleMinutes: status.idleTimeoutMinutes } : undefined,
        onVaultClick: handleLogout,
        isTeamAdmin: status?.mode === "team" && !!status.user?.isAdmin,
        mode: status?.mode,
        username: status?.user?.username,
      }}
    >
      {/* Section head — label + count, above the host grid */}
      <div className="dash-head">
        <span className="dash-head__label">
          {activeFolder === "__starred" ? "Favorites"
            : activeFolder ? folderList.find((f: any) => f.id === activeFolder)?.name ?? "Folder"
            : "All hosts"}
        </span>
        <span className="dash-head__count">{hostList.length} hosts</span>
      </div>

      {/* Search empty state */}
      {hostList.length === 0 && search && !hosts.isLoading ? (
        <div className="dash-body">
          <div className="empty">
            <div className="empty__glyph" style={{ opacity: 0.5 }}>
              <I.Search size={28} />
            </div>
            <div className="empty__head">
              <h1 className="empty__h1">No matches</h1>
              <p className="empty__sub">
                Nothing matches <code style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--fg-0)", background: "var(--bg-2)", padding: "1px 6px", borderRadius: 3 }}>{search}</code> in {activeFolder === "__starred" ? "favorites" : activeFolder ? "this folder" : "your hosts"}.
              </p>
            </div>
            <div className="empty__actions">
              <button className="btn btn--secondary" onClick={() => setSearch("")}>
                Clear search
              </button>
            </div>
          </div>
        </div>
      ) : hostList.length === 0 && !hosts.isLoading ? (
        <div className="dash-body dash-empty-wrap">
          <div className="dash-empty">
            <div className="dash-empty__glyph">
              <div className="term-mini">
                <div className="term-mini__bar">
                  <span /><span /><span />
                </div>
                <div className="term-mini__body">
                  <span className="term-mini__prompt">$</span>
                  <span className="term-mini__cursor" />
                </div>
              </div>
            </div>
            <div className="dash-empty__head">
              <span className="dash-empty__title">No hosts yet</span>
              <span className="dash-empty__sub">
                Import your existing SSH config to bring every server in at once, or add one by hand.
              </span>
            </div>
            <div className="dash-empty__actions">
              <button
                className="dash-empty__import"
                onClick={() =>
                  // The hash goes through the router. Setting window.location
                  // .hash separately doesn't survive: navigate() rewrites the
                  // whole URL, so the hash is discarded before Settings mounts
                  // and it falls back to Security.
                  navigate({ to: "/settings", hash: "import" })
                }
              >
                <I.ArrowRight size={16} />
                Import from <code>~/.ssh/config</code>
              </button>
              <button className="dash-empty__manual" onClick={() => setShowAdd(true)}>
                Add a host manually
              </button>
            </div>
            <span className="dash-empty__note">Parsed locally · nothing leaves this device</span>
          </div>
        </div>
      ) : view === "grid" ? (
        <div className="dash-body">
          <div className="host-grid">
            {hostList.map((host: any) => {
              const hovered = hoverHost === host.id;
              return (
                <div
                  key={host.id}
                  className={`host-card${host.active ? " active" : ""}`}
                  onMouseEnter={() => setHoverHost(host.id)}
                  onMouseLeave={() => setHoverHost((h) => (h === host.id ? null : h))}
                >
                  <div className="host-card__top">
                    <span className={`hdot hdot--${healthOf(host)}`} />
                    <span className="host-card__name">{text(host.hostname, "(no hostname)")}</span>
                    {host.active ? (
                      <span className="host-card__session">
                        <span className="pulse" />
                        Session
                      </span>
                    ) : (
                      <span
                        className="star"
                        style={{ cursor: "pointer", color: host.starred ? "var(--status-connecting)" : "var(--fg-3)", display: "inline-flex" }}
                        onClick={(e) => { e.stopPropagation(); toggleStar.mutate(host); }}
                        title={host.starred ? "Remove from favorites" : "Add to favorites"}
                      >
                        <I.Star size={12} />
                      </span>
                    )}
                  </div>

                  <div className="host-card__conn">
                    {text(host.username)}@{text(host.hostname)}:{text(host.port, "22")}
                  </div>

                  <div className="host-card__tags">
                    {toTags(host.tags).map((t) => (
                      <span key={t} className={`pill${tagVariant(t)}`}>{t}</span>
                    ))}
                  </div>

                  <div className="host-card__divider" />

                  {hovered ? (
                    <div className="host-card__actions">
                      <button className="connect" onClick={() => connectToHost(host.id)}>
                        Connect
                      </button>
                      <button className="ghost" onClick={() => setEditHost(host)} title="Edit host">
                        <I.Settings size={13} />
                      </button>
                      <button className="ghost" onClick={() => setHostToDelete(host)} title="Delete host">
                        <I.Close size={13} />
                      </button>
                    </div>
                  ) : (
                    <div className="host-card__meta">
                      <span>{healthLabel(healthOf(host))}</span>
                      <span>{timeAgo(host.last_connected_at)}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="dash-body">
          <div className="host-list">
            <div className="host-list__head">
              <span>Host</span>
              <span>Connection</span>
              <span>Tags</span>
              <span style={{ textAlign: "right" }}>Last used</span>
            </div>
            {hostList.map((host: any) => (
              <div
                key={host.id}
                className={`host-list__row${host.active ? " active" : ""}`}
                onClick={() => connectToHost(host.id)}
                title="Click to connect"
              >
                <div className="cell-host">
                  <span className={`hdot hdot--${healthOf(host)}`} />
                  <span className="nm">{text(host.hostname, "(no hostname)")}</span>
                </div>
                <div className="cell-conn">
                  {text(host.username)}@{text(host.hostname)}:{text(host.port, "22")}
                </div>
                <div className="cell-tags">
                  {toTags(host.tags).map((t) => (
                    <span key={t} className={`pill${tagVariant(t)}`}>{t}</span>
                  ))}
                </div>
                <div className="cell-last">
                  {timeAgo(host.last_connected_at)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {showAdd && (
        <HostDialog
          mode="create"
          folderId={activeFolder && activeFolder !== "__starred" ? activeFolder : null}
          folders={folderList}
          allHosts={hostList}
          onClose={(saved) => {
            setShowAdd(false);
            if (saved) {
              queryClient.invalidateQueries({ queryKey: ["hosts"] });
              toast.success("Host added");
            }
          }}
        />
      )}

      {editHost && (
        <HostDialog
          mode="edit"
          host={editHost}
          folders={folderList}
          allHosts={hostList}
          onClose={(saved) => {
            setEditHost(null);
            if (saved) {
              queryClient.invalidateQueries({ queryKey: ["hosts"] });
              toast.success("Host updated");
            }
          }}
        />
      )}

      {showAddFolder && (
        <AddFolderDialog
          onClose={() => setShowAddFolder(false)}
          onSubmit={(name) => createFolder.mutate(name)}
          busy={createFolder.isPending}
        />
      )}

      {folderToDelete && (
        <DeleteFolderDialog
          folder={folderToDelete}
          onConfirm={() => deleteFolder.mutate(folderToDelete.id)}
          onCancel={() => setFolderToDelete(null)}
          busy={deleteFolder.isPending}
        />
      )}

      {hostToDelete && (
        <DeleteHostDialog
          host={hostToDelete}
          onConfirm={() => deleteHost.mutate(hostToDelete.id)}
          onCancel={() => setHostToDelete(null)}
          busy={deleteHost.isPending}
        />
      )}
    </AppShell>
  );
}

// Coerce whatever the transport handed us into a list of renderable tags.
//
// The backend normalizes `tags` to a string array, but this is the last line
// before render: a raw SQLite row (JSON string), a null column, or a stray
// non-string element must not be allowed to throw. A host row is user data,
// and no single row should be able to take the screen down.
function toTags(value: unknown): string[] {
  let raw: unknown = value;
  if (typeof raw === "string") {
    try { raw = JSON.parse(raw); }
    catch { return []; }
  }
  if (!Array.isArray(raw)) return [];
  return raw.filter((t): t is string => typeof t === "string" && t.length > 0);
}

// Map a tag name to a styled variant. "prod" is caution-amber because it
// gates production access; staging gets the accent hue. Everything else is
// neutral. This is what makes a "prod" tag readable from across the room.
function tagVariant(tag: string): string {
  const t = String(tag ?? "").toLowerCase();
  if (t === "prod" || t === "production") return " prod";
  if (t === "stage" || t === "staging") return " staging";
  return "";
}

// A host may be missing hostname/username/port entirely (a partial import, a
// row written by an older schema). Render a visible placeholder rather than
// the string "undefined".
function text(value: unknown, fallback = "—"): string {
  if (value === null || value === undefined || value === "") return fallback;
  return String(value);
}

// Derived health state, until live health checks exist (a Tier-2 feature with
// its own backend). We infer from recency: connected within the last hour reads
// as live, older as unknown. This is an honest placeholder — never shows
// "unreachable" from a guess, since we can't actually know that without probing.
function healthOf(host: any): "live" | "unknown" | "unreachable" {
  if (!host) return "unknown";
  if (host.active) return "live";
  const ts = parseTime(host.last_connected_at);
  if (ts === null) return "unknown";
  return Date.now() - ts < 60 * 60 * 1000 ? "live" : "unknown";
}

// Returns epoch ms, or null when the value is absent or unparseable. Keeping
// the "is this even a date?" question in one place is what stops an NaN from
// leaking into the health and timeAgo output.
function parseTime(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const ms = new Date(value as string | number).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function healthLabel(h: "live" | "unknown" | "unreachable"): string {
  return h === "live" ? "Connected" : h === "unreachable" ? "Unreachable" : "Unknown";
}

function timeAgo(iso: unknown): string {
  const ts = parseTime(iso);
  if (ts === null) return "never";
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function DeleteFolderDialog({
  folder,
  onConfirm,
  onCancel,
  busy,
}: {
  folder: { id: string; name: string };
  onConfirm: () => void;
  onCancel: () => void;
  busy: boolean;
}) {
  return (
    <div className="dialog-overlay" onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="dialog" style={{ width: 440 }}>
        <div className="dialog__header">
          <h2>Delete folder</h2>
          <button type="button" className="dialog__close" onClick={onCancel}><I.Close size={14} /></button>
        </div>
        <div className="dialog__body">
          <p style={{ margin: 0, lineHeight: 1.5 }}>
            Delete <strong>{folder.name}</strong>?
          </p>
          <p style={{ margin: "8px 0 0", fontSize: 13, color: "var(--fg-2)", lineHeight: 1.5 }}>
            Hosts inside this folder will be moved to "All hosts". This action cannot be undone.
          </p>
        </div>
        <div className="dialog__footer">
          <button type="button" className="btn btn--secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--danger"
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? "Deleting…" : "Delete folder"}
          </button>
        </div>
      </div>
    </div>
  );
}

function DeleteHostDialog({
  host,
  onConfirm,
  onCancel,
  busy,
}: {
  host: any;
  onConfirm: () => void;
  onCancel: () => void;
  busy: boolean;
}) {
  return (
    <div className="dialog-overlay" onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="dialog" style={{ width: 440 }}>
        <div className="dialog__header">
          <h2>Delete host</h2>
          <button type="button" className="dialog__close" onClick={onCancel}><I.Close size={14} /></button>
        </div>
        <div className="dialog__body">
          <p style={{ margin: 0, lineHeight: 1.5 }}>
            Delete <strong>{host.label}</strong>?
          </p>
          <p style={{ margin: "8px 0 0", fontSize: 13, color: "var(--fg-2)", lineHeight: 1.5, fontFamily: "var(--font-mono)" }}>
            {host.username}@{host.hostname}:{host.port}
          </p>
          <p style={{ margin: "10px 0 0", fontSize: 13, color: "var(--fg-2)", lineHeight: 1.5 }}>
            The credential will be deleted too. This action cannot be undone.
          </p>
        </div>
        <div className="dialog__footer">
          <button type="button" className="btn btn--secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--danger"
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? "Deleting…" : "Delete host"}
          </button>
        </div>
      </div>
    </div>
  );
}

function AddFolderDialog({ onClose, onSubmit, busy }: { onClose: () => void; onSubmit: (name: string) => void; busy: boolean }) {
  const [name, setName] = useState("");
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (name.trim()) onSubmit(name.trim());
  };
  return (
    <div className="dialog-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog" style={{ width: 380 }}>
        <div className="dialog__header">
          <h2>New folder</h2>
          <button type="button" className="dialog__close" onClick={onClose}><I.Close size={14} /></button>
        </div>
        <form onSubmit={handleSubmit} className="dialog__body">
          <div className="field">
            <label>Folder name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Production"
              autoFocus
              required
            />
          </div>
          <div className="dialog__footer">
            <button type="button" className="btn btn--secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn--primary" disabled={busy || !name.trim()}>
              {busy ? "Creating…" : "Create folder"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// Combined create+edit dialog with input validation
function HostDialog({
  mode,
  host: existing,
  folderId,
  folders,
  allHosts = [],
  onClose,
}: {
  mode: "create" | "edit";
  host?: any;
  folderId?: string | null;
  folders: any[];
  allHosts?: any[];
  onClose: (saved: boolean) => void;
}) {
  const [label, setLabel] = useState(existing?.label ?? "");
  const [hostname, setHostname] = useState(existing?.hostname ?? "");
  const [port, setPort] = useState(String(existing?.port ?? 22));
  const [username, setUsername] = useState(existing?.username ?? "");
  const [folderIdState, setFolderIdState] = useState<string | null>(existing?.folder_id ?? folderId ?? null);
  const [authMethod, setAuthMethod] = useState<"password" | "key" | "agent">(existing?.auth_method ?? "password");
  const [credValue, setCredValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [tags, setTags] = useState<string[]>(() => toTags(existing?.tags));
  const [tagDraft, setTagDraft] = useState("");
  const [jumpHostId, setJumpHostId] = useState<string | null>(existing?.jump_host_id ?? null);

  // Hostname validation: non-empty, reasonable chars
  const validate = () => {
    const errs: Record<string, string> = {};
    const hn = hostname.trim();
    if (!hn) errs.hostname = "Hostname is required";
    else if (!/^[a-zA-Z0-9._\-:]+$/.test(hn)) errs.hostname = "Hostname has invalid characters";
    else if (hn.length > 253) errs.hostname = "Hostname is too long";
    const portNum = parseInt(port);
    if (!portNum || portNum < 1 || portNum > 65535) errs.port = "Port must be 1-65535";
    const un = username.trim();
    if (!un) errs.username = "Username is required";
    else if (!/^[a-zA-Z0-9._\-]+$/.test(un)) errs.username = "Username has invalid characters";
    return errs;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const errs = validate();
    if (Object.keys(errs).length > 0) {
      setErrors(errs);
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      const payload: any = {
        label: label.trim() || hostname.trim(),
        hostname: hostname.trim(),
        port: parseInt(port),
        username: username.trim(),
        folderId: folderIdState,
        authMethod,
        tags,
        jumpHostId,
        starred: !!existing?.starred,
      };
      if (credValue) {
        // `authMethod` is the host's setting; the credential's own kind is
        // just password or key. Sending "agent" here would fail validation.
        payload.credential = {
          kind: authMethod === "password" ? "password" : "key",
          value: credValue,
        };
      }
      if (mode === "create") {
        await apiPost("/api/hosts", payload);
      } else {
        await apiPut(`/api/hosts/${existing.id}`, payload);
      }
      onClose(true);
    } catch (err: any) {
      setErrors({ form: err.message || "Failed to save" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="drawer-scrim" onClick={(e) => { if (e.target === e.currentTarget) onClose(false); }}>
      <aside className="drawer" role="dialog" aria-label={mode === "create" ? "Add host" : "Edit host"}>
        <header className="drawer__head">
          <div>
            <h2 className="drawer__title">{mode === "create" ? "Add host" : "Edit host"}</h2>
            {mode === "edit" && existing?.hostname && (
              <span className="drawer__sub">{existing.hostname}</span>
            )}
          </div>
          <button type="button" className="drawer__close" onClick={() => onClose(false)} aria-label="Close">
            <I.Close size={14} />
          </button>
        </header>

        <form onSubmit={handleSubmit} className="drawer__body">
          <div className="hf-group">Connection</div>

          <label className="hf-label">Label</label>
          <div className="hf-input">
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Production database" />
          </div>

          <div className="hf-split hf-split--host">
            <div>
              <label className="hf-label">Hostname / IP</label>
              <div className={`hf-input${errors.hostname ? " is-error" : ""}`}>
                <input
                  className="mono"
                  value={hostname}
                  onChange={(e) => { setHostname(e.target.value); if (errors.hostname) setErrors({ ...errors, hostname: "" }); }}
                  placeholder="db-prod-02.iad.internal"
                  required
                />
              </div>
            </div>
            <div>
              <label className="hf-label">Port</label>
              <div className={`hf-input${errors.port ? " is-error" : ""}`}>
                <input
                  className="mono"
                  value={port}
                  onChange={(e) => { setPort(e.target.value); if (errors.port) setErrors({ ...errors, port: "" }); }}
                  type="number"
                  min={1}
                  max={65535}
                />
              </div>
            </div>
          </div>
          {errors.hostname && <div className="hf-error">{errors.hostname}</div>}
          {errors.port && <div className="hf-error">{errors.port}</div>}

          <div className="hf-split">
            <div>
              <label className="hf-label">Username</label>
              <div className={`hf-input${errors.username ? " is-error" : ""}`}>
                <input
                  className="mono"
                  value={username}
                  onChange={(e) => { setUsername(e.target.value); if (errors.username) setErrors({ ...errors, username: "" }); }}
                  placeholder="postgres"
                  required
                />
              </div>
            </div>
            <div>
              <label className="hf-label">Folder</label>
              <div className="hf-input">
                <select value={folderIdState ?? ""} onChange={(e) => setFolderIdState(e.target.value || null)}>
                  <option value="">(none)</option>
                  {folders.map((f: any) => (
                    <option key={f.id} value={f.id}>{f.name}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>
          {errors.username && <div className="hf-error">{errors.username}</div>}

          <div className="hf-group">Authentication</div>

          <div className="hf-seg hf-seg--3" role="group" aria-label="Authentication method">
            <button type="button" className={authMethod === "password" ? "is-active" : ""} onClick={() => setAuthMethod("password")}>
              Password
            </button>
            <button type="button" className={authMethod === "key" ? "is-active" : ""} onClick={() => setAuthMethod("key")}>
              Private key
            </button>
            <button type="button" className={authMethod === "agent" ? "is-active" : ""} onClick={() => setAuthMethod("agent")}>
              SSH agent
            </button>
          </div>

          {authMethod === "agent" ? (
            <p className="hf-note">
              Skiff asks the running SSH agent to authenticate. No key is stored
              here, and none is ever read — the agent does the signing itself,
              which is the reason to use one.
            </p>
          ) : (
          <>
          <label className="hf-label">
            {authMethod === "password" ? "Password" : "Private key"}
            {mode === "edit" && <span className="hf-optional"> (leave blank to keep current)</span>}
          </label>
          {authMethod === "password" ? (
            <div className="hf-input">
              <input
                type="password"
                value={credValue}
                onChange={(e) => setCredValue(e.target.value)}
                placeholder={mode === "edit" ? "Unchanged" : "SSH password"}
                autoComplete="new-password"
              />
            </div>
          ) : (
            <textarea
              className="hf-textarea mono"
              value={credValue}
              onChange={(e) => setCredValue(e.target.value)}
              placeholder={mode === "edit" ? "Unchanged" : "-----BEGIN OPENSSH PRIVATE KEY-----"}
              rows={6}
            />
          )}

          </>
          )}

          <div className="hf-group">Jump host</div>

          <p className="hf-note">
            Reach this host through another one. Useful when the machine isn't
            reachable directly and only a bastion is.
          </p>

          <div className="hf-input">
            <select
              value={jumpHostId ?? ""}
              onChange={(e) => setJumpHostId(e.target.value || null)}
            >
              <option value="">Connect directly</option>
              {allHosts
                .filter((h: any) => h.id !== existing?.id)
                .map((h: any) => (
                  <option key={h.id} value={h.id}>{h.label || h.hostname}</option>
                ))}
            </select>
          </div>

          {jumpHostId && (
            <div className="hf-route">
              <span className="dot" />
              <code>you</code>
              <I.ArrowRight size={11} />
              <code>{allHosts.find((h: any) => h.id === jumpHostId)?.label ?? "bastion"}</code>
              <I.ArrowRight size={11} />
              <code>{hostname || "this host"}</code>
            </div>
          )}

          <div className="hf-group">Tags</div>

          <div className="hf-tags">
            {tags.map((t) => (
              <span key={t} className={`hf-tag${t.toLowerCase() === "prod" ? " is-prod" : ""}`}>
                {t}
                <button type="button" onClick={() => setTags(tags.filter((x) => x !== t))} aria-label={`Remove ${t}`}>
                  <I.Close size={9} />
                </button>
              </span>
            ))}
            <input
              className="hf-tag-input mono"
              value={tagDraft}
              onChange={(e) => setTagDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === ",") {
                  e.preventDefault();
                  const v = tagDraft.trim().toLowerCase();
                  if (v && !tags.includes(v)) setTags([...tags, v]);
                  setTagDraft("");
                } else if (e.key === "Backspace" && !tagDraft && tags.length) {
                  setTags(tags.slice(0, -1));
                }
              }}
              placeholder="Add tag…"
            />
          </div>

          {tags.includes("prod") && (
            <div className="hf-policy">
              <I.Shield size={13} />
              <span>
                The <code>prod</code> tag will require approval to connect once
                break-glass access lands in v0.4. Today it only marks the host.
              </span>
            </div>
          )}

          {errors.form && <div className="hf-error">{errors.form}</div>}
        </form>

        <footer className="drawer__foot">
          <button type="button" className="btn btn--secondary" onClick={() => onClose(false)}>Cancel</button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={handleSubmit}
            disabled={busy || !hostname || !username}
          >
            {busy ? "Saving…" : mode === "edit" ? "Save changes" : "Save host"}
          </button>
        </footer>
      </aside>
    </div>
  );
}
