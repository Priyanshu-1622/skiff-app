import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { apiGet } from "@/lib/api";
import { useVault } from "@/lib/vault";
import * as I from "@/components/icons";

/**
 * Command Palette (Ctrl/Cmd-K) — the signature interaction.
 *
 * Rebuilt 1:1 from the Instrument Panel design: a floating overlay with
 * grouped, fuzzy-matched results and keyboard-first navigation. When empty it
 * shows recents + quick actions; while typing it filters hosts, actions, and
 * snippets. Machine values (hostnames) are monospace; matched characters are
 * highlighted.
 *
 * Wired to real data: hosts come from the vault, actions dispatch real
 * navigation/commands. Snippets are a placeholder group until the Snippets
 * feature lands, so the palette's shape matches the design now and gains a
 * live feed later.
 */

interface PaletteProps {
  open: boolean;
  onClose: () => void;
  onConnect?: (hostId: string) => void;
}

type Row = {
  key: string;
  icon: keyof typeof ICONS;
  label: string;
  mono?: boolean;
  sub?: string;
  hint?: string;
  run: () => void;
};

const ICONS = {
  host: I.Server,
  bolt: I.Bolt,
  lock: I.Lock,
  shield: I.Shield,
  clock: I.Clock,
  snip: I.Terminal,
  settings: I.Settings,
  tunnel: I.Globe,
} as const;

/** Subsequence fuzzy match. Returns matched indices, or null if no match. */
function fuzzy(query: string, text: string): number[] | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const idx: number[] = [];
  let ti = 0;
  for (let qi = 0; qi < q.length; qi++) {
    ti = t.indexOf(q[qi]!, ti);
    if (ti === -1) return null;
    idx.push(ti++);
  }
  return idx;
}

function Highlight({ label, matched }: { label: string; matched: number[] | null }) {
  if (!matched || matched.length === 0) return <>{label}</>;
  const set = new Set(matched);
  return (
    <>
      {label.split("").map((ch, i) =>
        set.has(i) ? <span key={i} className="hl">{ch}</span> : <span key={i}>{ch}</span>,
      )}
    </>
  );
}

/** "2m ago" / "3h ago" / "yesterday" — short enough for the row's right edge. */
function relTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? "yesterday" : `${d}d ago`;
}

export function CommandPalette({ open, onClose, onConnect }: PaletteProps) {
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  // Nearly everything the palette offers needs the vault open. Listing those
  // while it is locked is worse than listing nothing: the row looks available,
  // and the failure only arrives after the choice has been made.
  const vault = useVault((v) => v.status);
  const unlocked = !!vault?.unlocked;

  const hostsQ = useQuery({
    queryKey: ["hosts"],
    queryFn: () => apiGet<any[]>("/api/hosts"),
    // Not merely `open`: opening the palette on a locked vault used to fire a
    // request that could only be refused.
    enabled: open && unlocked,
    retry: false,
    throwOnError: false,
  });

  // Reset on open.
  useEffect(() => {
    if (open) {
      setQuery("");
      setSel(0);
      setTimeout(() => inputRef.current?.focus(), 20);
    }
  }, [open]);

  const groups = useMemo(() => {
    // Locked: one row, and it is the only one that can succeed. Team vaults
    // sign in by username on their own screen.
    if (!unlocked) {
      return [{
        label: "Vault locked",
        rows: [{
          key: "a:unlock",
          icon: "lock" as const,
          label: "Unlock vault",
          sub: "Everything else needs the vault open",
          matched: null,
          run: () => {
            onClose();
            navigate({ to: vault?.mode === "team" ? "/login" : "/unlock" });
          },
        }],
      }];
    }

    const hosts = hostsQ.data ?? [];
    const q = query.trim();

    const hostRows: Row[] = hosts.map((h) => ({
      key: `host:${h.id}`,
      icon: "host",
      label: h.hostname,
      mono: true,
      hint: (Array.isArray(h.tags) ? h.tags : []).join(" / ") || undefined,
      run: () => {
        onClose();
        if (onConnect) onConnect(h.id);
        else navigate({ to: "/terminal/$hostId", params: { hostId: h.id } });
      },
    }));

    const actionRows: Row[] = [
      { key: "a:new", icon: "bolt", label: "New connection", hint: "⌘ N", run: () => { onClose(); navigate({ to: "/" }); } },
      { key: "a:rec", icon: "snip", label: "Recordings", hint: "", run: () => { onClose(); navigate({ to: "/recordings" }); } },
      { key: "a:settings", icon: "settings", label: "Settings", hint: "⌘ ,", run: () => { onClose(); navigate({ to: "/settings" }); } },
      { key: "a:lock", icon: "lock", label: "Lock vault", hint: "⌘ L", run: async () => { onClose(); await import("@/lib/api").then((m) => m.apiPost("/api/vault/lock")); navigate({ to: "/unlock" }); } },
    ];

    // Recents lead when the field is empty — the design's first group, and the
    // right default: the host you want next is usually one you just left.
    const recentRows: Row[] = hosts
      .filter((h: any) => h.last_connected_at)
      .sort((a: any, b: any) =>
        new Date(b.last_connected_at).getTime() - new Date(a.last_connected_at).getTime())
      .slice(0, 3)
      .map((h: any) => ({
        key: `recent:${h.id}`,
        icon: "clock",
        label: h.hostname,
        mono: true,
        hint: relTime(h.last_connected_at),
        run: () => {
          onClose();
          if (onConnect) onConnect(h.id);
          else navigate({ to: "/terminal/$hostId", params: { hostId: h.id } });
        },
      }));

    const recentIds = new Set(recentRows.map((r) => r.key.slice("recent:".length)));

    const defs: Array<[string, Row[]]> = q
      ? [["Hosts", hostRows], ["Actions", actionRows]]
      : [
          ["Recent sessions", recentRows],
          // Don't list a host twice when it's already sitting in recents.
          ["Hosts", hostRows.filter((r) => !recentIds.has(r.key.slice("host:".length))).slice(0, 5)],
          ["Actions", actionRows],
        ];

    const out: Array<{ label: string; rows: Array<Row & { matched: number[] | null }> }> = [];
    for (const [label, rows] of defs) {
      const filtered = q
        ? rows
            .map((r) => ({ r, m: fuzzy(q, r.label + " " + (r.sub ?? "")) }))
            .filter((x) => x.m !== null)
            .map((x) => ({ ...x.r, matched: fuzzy(q, x.r.label) }))
        : rows.map((r) => ({ ...r, matched: null }));
      if (filtered.length) out.push({ label, rows: filtered });
    }
    return out;
  }, [hostsQ.data, query, navigate, onClose, onConnect, unlocked, vault?.mode]);

  const flat = useMemo(() => groups.flatMap((g) => g.rows), [groups]);

  // Keyboard handling.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
      else if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, flat.length - 1)); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
      else if (e.key === "Enter") { e.preventDefault(); flat[sel]?.run(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, flat, sel, onClose]);

  if (!open) return null;

  let flatIndex = -1;

  return (
    <div className="cmdk-backdrop" onClick={onClose}>
      <div className="cmdk" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Command palette">
        <div className="cmdk__input-wrap">
          <I.Search size={16} className="search-icon" />
          <input
            ref={inputRef}
            className="cmdk__input"
            placeholder="Search hosts, actions, snippets…"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setSel(0); }}
          />
          <span className="cmdk__esc">ESC</span>
        </div>

        <div className="cmdk__results">
          {flat.length === 0 ? (
            <div className="cmdk__empty">
              <span className="cmdk__empty-title">No matches for "{query}"</span>
              <span className="cmdk__empty-sub">Try a hostname, action, or tag.</span>
            </div>
          ) : (
            groups.map((g) => (
              <div key={g.label}>
                <div className="cmdk__group-label">{g.label}</div>
                {g.rows.map((row) => {
                  flatIndex++;
                  const isSel = flatIndex === sel;
                  const myIndex = flatIndex;
                  const Icon = ICONS[row.icon];
                  return (
                    <div
                      key={row.key}
                      className={`cmdk__row${isSel ? " sel" : ""}`}
                      onMouseEnter={() => setSel(myIndex)}
                      onClick={() => row.run()}
                    >
                      <span className="cmdk__row-icon"><Icon size={14} /></span>
                      <div className="cmdk__row-main">
                        <div className={`cmdk__row-label${row.mono ? " mono" : ""}`}>
                          <Highlight label={row.label} matched={row.matched} />
                        </div>
                        {row.sub ? <div className="cmdk__row-sub">{row.sub}</div> : null}
                      </div>
                      {row.hint ? <span className="cmdk__row-hint">{row.hint}</span> : null}
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="cmdk__footer">
          <span className="cmdk__key"><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
          <span className="cmdk__key"><kbd>↵</kbd> select</span>
          <span className="cmdk__key"><kbd>esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}
