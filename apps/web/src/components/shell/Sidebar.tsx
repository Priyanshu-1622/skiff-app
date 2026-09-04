import { useState } from "react";
import { useNavigate, useLocation } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import * as I from "@/components/icons";
import { apiGet } from "@/lib/api";
import { useFolderFilter } from "@/lib/folder-filter";
import { useVault } from "@/lib/vault";

/**
 * Sidebar — the primary navigation, rebuilt to the Instrument Panel design.
 *
 * Two structural changes from the v0.3 shell: the brand lives here rather than
 * in a global topbar (the design has no bar spanning the window), and the nav
 * lists the full product surface rather than only the screens that exist
 * today. Destinations whose screens aren't built yet render but are marked
 * `is-soon` — visible, dimmed, inert. Showing them keeps the design's shape
 * without navigating into a route that would 404.
 */

export interface SidebarFolder {
  id: string;
  name: string;
  count: number;
  children?: SidebarFolder[];
}

export interface SidebarProps {
  totalHosts?: number;
  favoritesCount?: number;
  folders?: SidebarFolder[];
  activeFolderId?: string | null;
  onSelectFolder?: (id: string | null) => void;
  onAddFolder?: () => void;
  onDeleteFolder?: (id: string) => void;
  vault?: { unlocked: boolean; idleMinutes: number };
  onVaultClick?: () => void;
  isTeamAdmin?: boolean;
  mode?: "personal" | "team";
  username?: string;
  /** Live counts for nav rows. Undefined means the gauge shows nothing. */
  counts?: { tunnels?: number; approvals?: number };
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

interface NavEntry {
  key: string;
  label: string;
  icon: React.ReactNode;
  to?: string;
  count?: number;
  /** Amber, per the design — used for pending approvals. */
  badge?: number;
  soon?: boolean;
}

export function Sidebar({
  totalHosts = 0,
  favoritesCount = 0,
  folders = [],
  activeFolderId = null,
  onSelectFolder = () => {},
  onAddFolder,
  onDeleteFolder,
  vault,
  onVaultClick,
  isTeamAdmin,
  mode,
  username,
  counts = {},
  collapsed = false,
  onToggleCollapse,
}: SidebarProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const path = location.pathname;

  // The sidebar is on every screen, so it sources its own data rather than
  // relying on each route to hand it over. Only the dashboard ever did, so
  // everywhere else the folder list was empty and the host count read 0 —
  // the folders looked like they had disappeared. Same query keys as the
  // dashboard, so react-query serves both from one cache entry.
  const { status: vaultStatus } = useVault();

  // Every one of these needs an unlocked vault, so none of them may run while
  // it is locked. StatusRail already had this right and said why: polling a
  // locked vault means a stream of rejections every few seconds, and an audit
  // log of nothing but refusals — noise in the one record that has to stay
  // readable. The counts below were added without those guards and reintroduced
  // exactly that, at a *faster* interval than the rail it was imitating.
  const unlocked = !!vaultStatus?.unlocked;
  const guarded = { retry: false, enabled: unlocked, throwOnError: false } as const;

  const hostsQ = useQuery({
    queryKey: ["hosts", null, ""],
    queryFn: () => apiGet<any[]>("/api/hosts?"),
    ...guarded,
  });
  const foldersQ = useQuery({
    queryKey: ["folders"],
    queryFn: () => apiGet<any[]>("/api/folders"),
    ...guarded,
  });

  // The nav rows have carried a tunnel count and an approvals badge all
  // along, fed from a `counts` prop that no route ever passed — so neither
  // ever appeared, on any screen. Both have their own endpoint, so the
  // sidebar reads them the same way it reads hosts and folders.
  //
  // Polled rather than invalidated: a tunnel can close without the renderer
  // doing anything — the session drops, the vault locks — and an approval can
  // be granted by someone else entirely. Nothing here would know to refetch.
  // Keys and interval match StatusRail exactly, so the rail and the sidebar
  // share one cache entry and one poll instead of hitting the same two
  // endpoints on two different schedules.
  const tunnelCountQ = useQuery({
    queryKey: ["tunnels-count"],
    queryFn: () => apiGet<{ count: number }>("/api/tunnels/count"),
    refetchInterval: 20_000,
    ...guarded,
  });
  const approvalCountQ = useQuery({
    queryKey: ["approvals-pending"],
    queryFn: () => apiGet<{ count: number }>("/api/approvals/pending"),
    refetchInterval: 20_000,
    ...guarded,
  });

  const filter = useFolderFilter();

  // Props still win where a route supplies them — the dashboard passes live
  // values it already has, and owns adding and deleting.
  const allHosts = hostsQ.data ?? [];
  const hostCount = totalHosts || allHosts.length;
  const favCount =
    favoritesCount || allHosts.filter((h: any) => h.starred).length;
  const folderList: SidebarFolder[] = folders.length
    ? folders
    : (foldersQ.data ?? []).map((f: any) => ({
        id: f.id,
        name: f.name,
        count: allHosts.filter((h: any) => h.folder_id === f.id).length,
      }));
  const activeId = activeFolderId ?? filter.active;

  // Who is signed in, sourced here rather than taken on trust from a prop.
  //
  // `isTeamAdmin`, `mode` and `username` are passed by exactly one route —
  // the dashboard — so everywhere else they fell back to their defaults: the
  // Admin row vanished and the chip read "Local vault" while signed in as a
  // team admin. Worse, the personal-to-team upgrade navigates straight to
  // /admin, a screen from which the row is invisible, so the way back to it
  // did not exist. The same fault as the folder list and the nav counts
  // before it: a value read on one side and supplied on the other only
  // sometimes. Props still win when given, so the dashboard is unchanged.
  const effectiveMode = mode ?? vaultStatus?.mode ?? "personal";
  const effectiveUsername = username ?? vaultStatus?.user?.username ?? undefined;
  const showAdmin =
    isTeamAdmin ??
    (vaultStatus?.mode === "team" && !!vaultStatus.user?.isAdmin);

  // Zero is not worth a badge; undefined renders nothing at all.
  const liveCounts = {
    tunnels: counts.tunnels ?? tunnelCountQ.data?.count ?? undefined,
    approvals: counts.approvals ?? approvalCountQ.data?.count ?? undefined,
  };

  // Choosing a folder from another screen has to go somewhere it can be
  // seen, so it selects the filter and heads for the host list.
  const selectFolder = (id: string | null) => {
    filter.setActive(id);
    onSelectFolder(id);
    if (path !== "/") void navigate({ to: "/" });
  };

  const entries: NavEntry[] = [
    { key: "hosts", label: "Hosts", icon: <I.Server size={15} />, to: "/", count: totalHosts || hostsQ.isSuccess ? hostCount : undefined },
    { key: "files", label: "Files", icon: <I.Folder size={15} />, to: "/files" },
    { key: "tunnels", label: "Tunnels", icon: <I.Globe size={15} />, to: "/tunnels", count: liveCounts.tunnels || undefined },
    { key: "snippets", label: "Snippets", icon: <I.Terminal size={15} />, to: "/snippets" },
    { key: "recordings", label: "Recordings", icon: <I.Film size={15} />, to: "/recordings" },
    { key: "audit", label: "Audit", icon: <I.Shield size={15} />, to: "/audit" },
    { key: "approvals", label: "Approvals", icon: <I.Check size={15} />, to: "/approvals", badge: liveCounts.approvals || undefined },
    { key: "settings", label: "Settings", icon: <I.Settings size={15} />, to: "/settings" },
  ];

  if (showAdmin) {
    entries.push({ key: "admin", label: "Admin", icon: <I.Users size={15} />, to: "/admin" });
  }

  const initials = (effectiveMode === "team" && effectiveUsername ? effectiveUsername : "vault")
    .slice(0, 2)
    .toLowerCase();
  const chipName = effectiveMode === "team" && effectiveUsername ? effectiveUsername : "Local vault";

  return (
    <aside className={`sidebar${collapsed ? " is-collapsed" : ""}`}>
      <div className="sidebar__brand">
        <span className="sidebar__mark"><I.Skiff size={15} /></span>
        <span className="sidebar__name">Skiff</span>
      </div>

      <nav className="sidebar__nav">
        {entries.map((e) => {
          const active = e.to === "/" ? path === "/" && !activeId : e.to ? path === e.to : false;
          return (
            <button
              key={e.key}
              type="button"
              className={`nav-item${active ? " is-active" : ""}${e.soon ? " is-soon" : ""}`}
              aria-current={active ? "true" : undefined}
              aria-disabled={e.soon || undefined}
              title={e.soon ? `${e.label} — not built yet` : e.label}
              onClick={() => {
                if (e.soon || !e.to) return;
                if (e.to === "/") selectFolder(null);
                navigate({ to: e.to });
              }}
            >
              <span className="nav-item__icon">{e.icon}</span>
              <span className="nav-item__label">{e.label}</span>
              {e.badge ? (
                <span className="nav-item__badge">{e.badge}</span>
              ) : e.count !== undefined ? (
                <span className="nav-item__count">{e.count}</span>
              ) : null}
            </button>
          );
        })}

        {favCount > 0 && (
          <button
            type="button"
            className={`nav-item${activeId === "__starred" ? " is-active" : ""}`}
            aria-current={activeId === "__starred" ? "true" : undefined}
            onClick={() => selectFolder("__starred")}
          >
            <span className="nav-item__icon"><I.Star size={15} /></span>
            <span className="nav-item__label">Favorites</span>
            <span className="nav-item__count">{favCount}</span>
          </button>
        )}
      </nav>

      <div className="sidebar__group">
        <span>Folders</span>
        {onAddFolder && (
          <button type="button" className="add" onClick={onAddFolder} title="New folder" aria-label="New folder">
            <I.Plus size={11} />
          </button>
        )}
      </div>

      <div className="sidebar__tree">
        {folderList.length > 0 ? (
          folderList.map((f) => (
            <FolderItem
              key={f.id}
              folder={f}
              depth={0}
              activeId={activeId}
              onSelect={selectFolder}
              onDelete={onDeleteFolder}
            />
          ))
        ) : (
          <div className="sidebar__folders-empty">No folders yet</div>
        )}
      </div>

      <div className="sidebar__foot">
        <div className="user-chip">
          <span className={`user-chip__avatar${vault && !vault.unlocked ? " is-locked" : ""}`}>{initials}</span>
          <span className="user-chip__meta">
            <span className="user-chip__name">{chipName}</span>
            <span className={`user-chip__state${vault?.unlocked ? " is-open" : ""}`}>
              {vault?.unlocked ? "unlocked" : "locked"}
            </span>
          </span>
          <span className="user-chip__actions">
            {vault?.unlocked && onVaultClick && (
              <button
                type="button"
                className="chip-btn"
                onClick={onVaultClick}
                title={effectiveMode === "team" ? "Log out" : "Lock vault"}
                aria-label={effectiveMode === "team" ? "Log out" : "Lock vault"}
              >
                <I.Lock size={13} />
              </button>
            )}
          </span>
        </div>

        {onToggleCollapse && (
          <button type="button" className="sidebar__collapse" onClick={onToggleCollapse}>
            <I.ChevronLeft size={12} />
            <span>Collapse</span>
          </button>
        )}
      </div>
    </aside>
  );
}

function FolderItem({
  folder,
  depth,
  activeId,
  onSelect,
  onDelete,
}: {
  folder: SidebarFolder;
  depth: number;
  activeId: string | null;
  onSelect: (id: string | null) => void;
  onDelete?: (id: string) => void;
}) {
  const [open, setOpen] = useState(depth === 0);
  const hasChildren = !!folder.children?.length;
  const active = activeId === folder.id;

  return (
    <>
      <div
        className={`tree-item${active ? " is-active" : ""}${depth > 0 ? " is-child" : ""}`}
        style={{ paddingLeft: 9 + depth * 14 }}
        aria-current={active ? "true" : undefined}
        onClick={() => onSelect(folder.id)}
      >
        <span
          className={`twist${hasChildren ? (open ? " open" : "") : " empty"}`}
          onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
        >
          <I.Chevron size={9} />
        </span>
        <span className="tree-item__label">{folder.name}</span>
        <span className="tree-item__count">{folder.count}</span>
        {onDelete && (
          <button
            type="button"
            className="tree-item__delete"
            onClick={(e) => { e.stopPropagation(); onDelete(folder.id); }}
            title="Delete folder"
            aria-label="Delete folder"
          >
            <I.Close size={10} />
          </button>
        )}
      </div>
      {open && hasChildren && folder.children!.map((child) => (
        <FolderItem
          key={child.id}
          folder={child}
          depth={depth + 1}
          activeId={activeId}
          onSelect={onSelect}
          onDelete={onDelete}
        />
      ))}
    </>
  );
}
