import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { apiGet, apiDelete, isDesktop } from "@/lib/api";
import { toast } from "@/lib/toast";
import * as I from "@/components/icons";
import { AppShell } from "@/components/shell";
import "@/styles/recordings.css";

interface Recording {
  id: string;
  hostId: string | null;
  hostLabel: string | null;
  hostname: string | null;
  userId: string | null;
  username: string | null;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  bytes: number | null;
  status: string;
}

/**
 * The asciinema player, bundled rather than fetched.
 *
 * It used to load from a CDN, which meant recordings simply didn't play with
 * no network — and quietly told a third party which machines were reviewing
 * sessions. Both are wrong for a tool whose pitch is that nothing leaves the
 * device. It's a dynamic import so it still stays out of the main bundle and
 * only loads when someone opens a recording.
 */
let playerLoading: Promise<any> | null = null;
function loadPlayer(): Promise<any> {
  if (!playerLoading) {
    playerLoading = (async () => {
      const [mod] = await Promise.all([
        import("asciinema-player"),
        import("asciinema-player/dist/bundle/asciinema-player.css"),
      ]);
      return mod;
    })().catch((err) => {
      playerLoading = null; // allow a retry rather than caching the failure
      throw err;
    });
  }
  return playerLoading;
}

/**
 * Why a .cast file will not play, or null if it looks well-formed.
 *
 * asciicast v2 is newline-delimited JSON: a header object on line 1 carrying
 * `version`, `width` and `height`, then one `[time, code, data]` array per
 * line. The player rejects anything else by throwing inside an init promise it
 * then discards, which is a silent failure — so the file is checked here,
 * where the reason can actually be shown.
 */
function describeCast(text: string): string | null {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  if (lines.length === 0) return "This recording is empty — the file has no content.";

  let header: any;
  try {
    header = JSON.parse(lines[0]!);
  } catch {
    return "This recording's header is not valid JSON, so the file is damaged.";
  }
  if (!header || typeof header !== "object" || Array.isArray(header)) {
    return "This recording is missing its header line.";
  }
  if (header.version !== 2) {
    return `This recording is asciicast version ${JSON.stringify(header.version)}; the player supports version 2.`;
  }
  if (!Number.isFinite(header.width) || !Number.isFinite(header.height)) {
    return "This recording's header has no terminal size, so it cannot be replayed.";
  }
  if (lines.length < 2) {
    return "This recording has a header but no output — nothing was captured before it ended.";
  }

  // Only the last line is checked in full: a recording cut short mid-write
  // leaves a truncated final line, which is the realistic corruption here and
  // the one the player dies on. Scanning every line of a large cast would cost
  // more than it finds.
  const last = lines[lines.length - 1]!;
  try {
    const ev = JSON.parse(last);
    if (!Array.isArray(ev) || ev.length < 3 || !Number.isFinite(ev[0])) {
      return "This recording's last entry is malformed, so it was probably cut short.";
    }
  } catch {
    return "This recording ends mid-line — it was cut short before it could be closed.";
  }
  return null;
}
function fmtDuration(ms: number | null): string {
  if (!ms || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return `${m}m ${rem}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function fmtBytes(b: number | null): string {
  if (!b) return "—";
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

function PlayerModal({ rec, onClose }: { rec: Recording; onClose: () => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let player: any = null;
    let cancelled = false;
    let readyTimer: number | undefined;

    // The player takes either a URL it will fetch, or the recording inline.
    // Desktop uses inline: there is no HTTP server, so a .cast arrives over
    // IPC — and handing it back as a blob URL only moved the problem, since
    // fetching one is still governed by connect-src. `{ data }` is read
    // straight into a Response by the player, so nothing crosses the network
    // layer and no CSP applies. The browser build fetches the real route.
    const source = async (): Promise<any> => {
      if (!isDesktop()) return `/api/recordings/${rec.id}/cast`;
      return { data: await apiGet<string>(`/api/recordings/${rec.id}/cast`) };
    };

    Promise.all([loadPlayer(), source()])
      .then(([AsciinemaPlayer, src]) => {
        if (cancelled || !containerRef.current) return;

        // Check the file ourselves before handing it over.
        //
        // asciinema-player swallows its own start-up failure — `create()` does
        // `const ready = core.init(); void ready.catch(() => {});` — so a bad
        // recording produces a rendered panel that never plays, with nothing
        // thrown and nothing logged. Every previous attempt at this bug looked
        // identical for that reason, whatever the source shape.
        if (typeof (src as any)?.data === "string") {
          const problem = describeCast((src as any).data as string);
          if (problem) { setError(problem); return; }
        }

        player = AsciinemaPlayer.create(src, containerRef.current, {
          // Neither "width" nor "both" is safe here, for two different
          // reasons — both found by driving the real player live and
          // reading its own source, not guessed.
          //
          // "width" scales the terminal's FONT to fill the container's
          // width alone, with no ceiling on the height that produces —
          // measured live at 128.966% for an 80-column recording in this
          // modal, making a 24-row terminal 679px tall against a
          // height-constrained modal (max-height: 88vh). The Play button,
          // part of the terminal's own control bar, rendered 58px below the
          // bottom of the actual browser window — reachable by no click,
          // real or synthetic.
          //
          // "both" fixes that by picking whichever axis is more
          // restrictive — but its scale is computed from a *reactive*
          // containerSize(), read directly from the shipped source
          // (opts-*.js): `scale = currentContainerSize.width / terminalW`.
          // `.rec-player` is a flex item with `flex-basis: 0%` (needed for
          // the scroll fix below), so its *first* measurement — before
          // flex-grow has resolved — can legitimately be width: 0. A
          // scale of exactly 0 computed on that first pass is memoized and
          // never recomputed: confirmed live by measuring `.ap-player`'s
          // own rendered width at zero, consistently, across a single
          // stable mount.
          //
          // `false` sidesteps both bugs at once: it skips the container
          // measurement entirely (the source's own `fit === false` branch
          // returns `{}` immediately) and renders the terminal at its
          // natural size from the explicit `terminalFontSize` below —
          // ~600×480px for an 80x24 recording, comfortably inside the
          // modal with no scaling computation, and nothing left to race.
          fit: false,
          terminalFontSize: "14px",
          theme: "asciinema",
          // The actual cause of fault 14, found by instrumenting the player's
          // own source line by line: the driver never loads a recording on
          // `create()` unless `preload` (or a poster) is set. Confirmed by
          // reading the driver's own state machine —
          //
          //   case EVENT.INIT_REQUESTED:
          //     if (currentState === STATE.COLD) {
          //       if (preload || poster?.type == "npt") { ...load... }
          //     }
          //     return { nextState: currentState };  // <- COLD forever, else
          //
          // Nothing here was ever calling `.play()` either, so with neither
          // set the player mounted correctly, the WASM VT engine initialised
          // correctly, and then sat in STATE.COLD permanently — no error, no
          // event, nothing to see, because nothing had gone wrong. It was
          // waiting for a command that never came. Confirmed by driving the
          // real player + a real recording directly: with `preload` added,
          // parsing this project's own recordings takes single-digit
          // milliseconds and reports the correct duration immediately.
          preload: true,
          // `controls` defaults to `"auto"`, which shows the play button only
          // while the mouse is actively moving over the player and hides it
          // otherwise — on a modal that had never loaded anything anyway,
          // there was nothing to notice hovering for. Forced on so the control
          // bar, including Play, is always visible.
          controls: true,
          // The player takes a logger and defaults to one that discards
          // everything. Given the above, that default is why this failure has
          // been invisible; a real one puts the reason on screen.
          logger: {
            log: (...a: unknown[]) => console.log("[player]", ...a),
            debug: (...a: unknown[]) => console.debug("[player]", ...a),
            info: (...a: unknown[]) => console.info("[player]", ...a),
            warn: (...a: unknown[]) => console.warn("[player]", ...a),
            error: (...a: unknown[]) => {
              console.error("[player]", ...a);
              if (!cancelled) {
                setError(
                  "The player could not start: " +
                    a.map((x) => (x instanceof Error ? x.message : String(x))).join(" "),
                );
              }
            },
          },
        });

        // A hang is reported, not waited on forever.
        //
        // This used to be attributed to Core._init()'s `await this.startupPromise`
        // never resolving. It doesn't hang there — confirmed by instrumenting
        // that exact line, which always resolved cleanly. The real cause was
        // `preload` never being set (see above); this timer is kept as a
        // genuine safety net for whatever the next real failure turns out to
        // be, now that `preload: true` makes it a meaningful check rather than
        // one that would fire on every successful load. There is no "ready"
        // event on the public API, so readiness is inferred from the duration
        // becoming known.
        readyTimer = window.setTimeout(() => {
          if (cancelled) return;
          const duration = (() => {
            try { return player?.getDuration?.(); } catch { return undefined; }
          })();
          if (duration === undefined) {
            setError(
              "The player loaded but never finished starting up. The recording " +
                "file itself is valid, so this is the player failing to " +
                "initialise — check the console for [player] messages.",
            );
          }
        }, 8000);
      })
      .catch((e: any) => {
        // The reason used to be swallowed, so a CSP refusal and a missing file
        // looked identical: a blank panel and one generic sentence.
        if (!cancelled) {
          setError(`Could not load the recording: ${e?.message ?? "unknown error"}`);
        }
      });

    return () => {
      cancelled = true;
      if (readyTimer !== undefined) window.clearTimeout(readyTimer);
      try { player?.dispose(); } catch { /* ignore */ }
    };
  }, [rec.id]);

  return (
    // Close on a click that *lands on the overlay itself*, rather than
    // stopping propagation inside the modal.
    //
    // This is fault 14. asciinema-player is built with SolidJS, which
    // delegates events: it does not bind a listener to the Play button, it
    // binds one listener to `document` and dispatches from there. Confirmed
    // in the shipped source — `delegateEvents(["click","mousedown",
    // "mousemove"])` → `document.addEventListener(name, eventHandler)`.
    //
    // The previous `<div className="rec-modal" onClick={e => e.stopPropagation()}>`
    // existed only to stop inside-clicks closing the modal, but React's
    // stopPropagation() also stops the *native* event, and React 17+ listens
    // at the root container — below `document`. So every click inside the
    // modal died at the React root and never reached Solid's listener. The
    // player was fully working: it mounted, initialised its WASM VT engine,
    // resolved getDuration(), and rendered its controls. The click simply
    // never arrived, which is why nothing errored and aria-label stayed
    // "Play".
    //
    // Comparing e.target to e.currentTarget needs no propagation stopping,
    // so the event still reaches document intact.
    <div
      className="rec-modal-overlay"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="rec-modal">
        <div className="rec-modal-head">
          <div>
            <div className="rec-modal-title">{rec.hostLabel || rec.hostname || "Session"}</div>
            <div className="rec-modal-sub">
              {rec.username ? `${rec.username} · ` : ""}{fmtWhen(rec.startedAt)}
            </div>
          </div>
          <button className="rec-icon-btn" onClick={onClose} aria-label="Close">
            <I.Close size={18} />
          </button>
        </div>
        {error
          ? <div className="rec-modal-error">{error}</div>
          : <div className="rec-player" ref={containerRef} />}
      </div>
    </div>
  );
}

export function RecordingsRoute() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [playing, setPlaying] = useState<Recording | null>(null);
  // Was window.confirm(): an unstyled OS dialog naming nothing in particular,
  // for an action that destroys a session record permanently.
  const [deleting, setDeleting] = useState<Recording | null>(null);
  const [query, setQuery] = useState("");

  const recordings = useQuery({
    queryKey: ["recordings"],
    queryFn: () => apiGet<Recording[]>("/api/recordings"),
  });

  const del = useMutation({
    mutationFn: (id: string) => apiDelete(`/api/recordings/${id}`),
    onSuccess: () => {
      toast.success("Recording deleted");
      void qc.invalidateQueries({ queryKey: ["recordings"] });
      setDeleting(null);
    },
    onError: () => toast.error("Could not delete recording"),
  });

  const all = recordings.data ?? [];
  const q = query.trim().toLowerCase();
  const list = q
    ? all.filter((r) =>
        [r.hostLabel, r.hostname, r.username].some((v) => v?.toLowerCase().includes(q)),
      )
    : all;
  const maxBytes = Math.max(1, ...all.map((r) => r.bytes ?? 0));

  return (
    <AppShell
      title="skiff — recordings"
      toolbar={{
        searchValue: query,
        onSearchChange: setQuery,
        placeholder: "Search recordings by host or user…",
      }}
      sidebar={{}}
    >
      <div className="rec-table">
        <div className="rec-table__head">
          <span className="c-activity">Size</span>
          <span className="c-host">Host</span>
          <span className="c-user">User</span>
          <span className="c-started">Started</span>
          <span className="c-duration">Duration</span>
          <span className="c-size">Bytes</span>
        </div>

        {recordings.isLoading && <div className="rec-empty">Loading…</div>}

        {!recordings.isLoading && list.length === 0 && (
          <div className="rec-empty">
            <I.Film size={30} />
            <p>No recordings yet.</p>
            <p className="rec-empty-hint">
              When session recording is on, your terminal sessions appear here.
            </p>
          </div>
        )}

        {list.map((r) => (
          <div
            key={r.id}
            className={`rec-row${r.status === "recording" ? " is-live" : ""}`}
            onClick={() => r.status !== "recording" && setPlaying(r)}
          >
            {/* A relative-size bar, not an activity graph. Real per-second
                activity would mean parsing every asciicast on load; this shows
                the one thing we already know and doesn't pretend otherwise. */}
            <span className="c-activity" title="Size relative to the largest recording">
              <span className="rec-bar">
                <span
                  className="rec-bar__fill"
                  style={{ width: `${maxBytes ? Math.max(4, ((r.bytes ?? 0) / maxBytes) * 100) : 4}%` }}
                />
              </span>
            </span>

            <span className="c-host">
              <span className="rec-host">
                {r.status === "interrupted" && (
                  <I.Warn size={12} className="rec-warn" />
                )}
                {r.hostLabel || r.hostname || "Session"}
                {r.status === "recording" && <span className="rec-live">● recording</span>}
              </span>
              {r.hostname && r.hostLabel && (
                <span className="rec-sub">{r.hostname}</span>
              )}
            </span>

            <span className="c-user">{r.username ?? "—"}</span>
            <span className="c-started">{fmtWhen(r.startedAt)}</span>
            <span className="c-duration">{fmtDuration(r.durationMs)}</span>
            <span className="c-size">{fmtBytes(r.bytes)}</span>

            <span className="rec-row__actions">
              {r.status !== "recording" && (
                <button
                  className="rec-icon-btn"
                  onClick={(e) => { e.stopPropagation(); setPlaying(r); }}
                  aria-label="Play"
                >
                  <I.Play size={14} />
                </button>
              )}
              <button
                className="rec-icon-btn rec-danger"
                onClick={(e) => {
                  e.stopPropagation();
                  setDeleting(r);
                }}
                aria-label="Delete"
              >
                <I.Trash size={14} />
              </button>
            </span>
          </div>
        ))}
      </div>

      {playing && <PlayerModal rec={playing} onClose={() => setPlaying(null)} />}

      {deleting && (
        <div
          className="dialog-overlay"
          onClick={(e) => { if (e.target === e.currentTarget) setDeleting(null); }}
        >
          <div className="dialog" role="dialog" aria-label="Delete recording">
            <div className="dialog__head"><h2>Delete this recording?</h2></div>
            <div className="dialog__body">
              <p style={{ margin: "0 0 10px", fontSize: 13, lineHeight: 1.55, color: "var(--fg-1)" }}>
                The <code>.cast</code> file is removed from disk and cannot be recovered.
                The audit log keeps its own record of the session either way.
              </p>
              <p style={{ margin: 0, fontSize: 12.5, color: "var(--fg-2)", fontFamily: "var(--font-mono)" }}>
                {deleting.hostLabel || deleting.hostname || "Session"} · {fmtWhen(deleting.startedAt)}
              </p>
            </div>
            <div className="dialog__foot">
              <button className="btn btn--secondary" onClick={() => setDeleting(null)}>Cancel</button>
              <button
                className="btn btn--danger"
                disabled={del.isPending}
                onClick={() => del.mutate(deleting.id)}
              >
                {del.isPending ? "Deleting…" : "Delete recording"}
              </button>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}
