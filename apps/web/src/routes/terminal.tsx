import { useEffect, useRef, useState, useCallback } from "react";
import { useParams, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { apiGet, apiPost } from "@/lib/api";
import { createTerminalSocket, type TerminalMessage } from "@/lib/ws";
import { toast } from "@/lib/toast";
import * as I from "@/components/icons";
import { useTabs } from "@/lib/tabs";

type ConnState = "connecting" | "connected" | "disconnected" | "error";

const MIN_FONT = 10;
const MAX_FONT = 24;
const DEFAULT_FONT = 14;
const FONT_STORAGE_KEY = "skiff.terminal.fontSize";
const SPLIT_RATIO_KEY = "skiff.terminal.splitRatio";
/** Keeps both panes usable — a pane narrower than this cannot show much. */
const MIN_SPLIT_RATIO = 0.2;
const MAX_SPLIT_RATIO = 0.8;

/**
 * Base64-encode a UTF-8 string without `String.fromCharCode(...bytes)`,
 * which throws RangeError (call stack exceeded) on large inputs such as
 * a pasted block of text. Builds the binary string in a simple loop.
 */
/** mm:ss under an hour, h:mm:ss over — matches the design's session clock. */
function formatElapsed(total: number): string {
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function encodeInputToBase64(data: string): string {
  const bytes = new TextEncoder().encode(data);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

/**
 * One terminal.
 *
 * Split panes work by rendering this twice rather than extracting the six
 * hundred lines of connection logic below into something reusable. Each
 * instance already owns its own refs, socket, xterm and state — React gives us
 * that for free — so two side by side are genuinely independent without any of
 * it being rewritten. The alternative was refactoring the screen people live
 * in, on a feature that can't be verified without a real server.
 *
 * The secondary pane hides the tab strip: tabs belong to the window, not to a
 * pane, and two tab strips would imply otherwise.
 */
function TerminalPane({
  hostId,
  isPane = false,
  onSplit,
  onCloseSplit,
  splitOpen = false,
}: {
  hostId: string;
  isPane?: boolean;
  onSplit?: () => void;
  onCloseSplit?: () => void;
  splitOpen?: boolean;
}) {
  const navigate = useNavigate();

  const termRef = useRef<HTMLDivElement>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const xtermRef = useRef<any>(null);
  const fitRef = useRef<any>(null);
  const streamReadyRef = useRef(false);
  const pendingInputRef = useRef<string[]>([]);
  const pingIntervalRef = useRef<number | null>(null);
  const lastPingTsRef = useRef<number>(0);

  const [connState, setConnState] = useState<ConnState>("connecting");
  const [statusMsg, setStatusMsg] = useState("Connecting…");
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [fontSize, setFontSize] = useState<number>(() => {
    const stored = parseInt(localStorage.getItem(FONT_STORAGE_KEY) || "");
    return stored >= MIN_FONT && stored <= MAX_FONT ? stored : DEFAULT_FONT;
  });
  const [reconnectKey, setReconnectKey] = useState(0);
  const [showHelp, setShowHelp] = useState(false);
  const [pendingFp, setPendingFp] = useState<{ fingerprint: string; hostname: string } | null>(null);
  /** Seconds since the session went live — shown in the session strip. */
  const [elapsed, setElapsed] = useState(0);
  const [findOpen, setFindOpen] = useState(false);
  const [guard, setGuard] = useState<{
    id: string; severity: "critical" | "warning";
    title: string; detail: string; command: string;
  } | null>(null);
  const [gateOpen, setGateOpen] = useState(false);
  const [gateReason, setGateReason] = useState("");
  const [gateSent, setGateSent] = useState(false);
  const [gateBusy, setGateBusy] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findHits, setFindHits] = useState<{ current: number; total: number } | null>(null);

  const tabs = useTabs((s) => s.tabs);
  const openTab = useTabs((s) => s.open);
  const closeTab = useTabs((s) => s.close);
  const renameTab = useTabs((s) => s.rename);

  const host = useQuery({
    queryKey: ["host", hostId],
    queryFn: () => apiGet<any>(`/api/hosts/${hostId}`),
    enabled: !!hostId,
  });

  // The REC badge must reflect reality, not decoration: it appears only when
  // recording is actually switched on for this vault.
  const vaultStatus = useQuery({
    queryKey: ["vault-status"],
    queryFn: () => apiGet<any>("/api/vault/status"),
    staleTime: 60_000,
  });
  const recordingOn = !!vaultStatus.data?.recordingEnabled;

  // Arriving at a host puts it in the tab strip; the label lands once the host
  // query resolves, so the tab appears immediately rather than waiting.
  useEffect(() => {
    if (!hostId) return;
    openTab({ hostId, label: host.data?.label || host.data?.hostname || hostId });
  }, [hostId, host.data, openTab]);

  useEffect(() => {
    if (hostId && host.data?.label) renameTab(hostId, host.data.label);
  }, [hostId, host.data?.label, renameTab]);

  const closeCurrentRef = useRef<() => void>(() => {});
  const openFindRef = useRef<() => void>(() => {});
  const switchRef = useRef<(dir: 1 | -1) => void>(() => {});
  const searchRef = useRef<any>(null);
  const findInputRef = useRef<HTMLInputElement>(null);

  /** Closing detaches this session and moves to the neighbouring tab. */
  const closeCurrent = useCallback(() => {
    socketRef.current?.close();
    const next = closeTab(hostId);
    if (next) navigate({ to: "/terminal/$hostId", params: { hostId: next.hostId } });
    else navigate({ to: "/" });
  }, [hostId, closeTab, navigate]);
  closeCurrentRef.current = closeCurrent;

  /**
   * Disconnect ends the session; closing a tab only detaches from it.
   *
   * They were the same action, so nothing could actually stop a session —
   * the shell stayed up and, with recording on, kept recording until the
   * app quit.
   */
  const disconnectCurrent = useCallback(() => {
    const sock = socketRef.current;
    if (sock?.readyState === WebSocket.OPEN) {
      try { sock.send(JSON.stringify({ type: "disconnect" })); } catch { /* going away */ }
    }
    closeCurrent();
  }, [closeCurrent]);

  const runFind = useCallback((q: string, back = false) => {
    const addon = searchRef.current;
    if (!addon) return;
    if (!q) { addon.clearDecorations?.(); setFindHits(null); return; }
    const opts = {
      decorations: {
        matchBackground: "#2B3440",
        activeMatchBackground: "#4C8DFF",
        activeMatchColorOverviewRuler: "#4C8DFF",
      },
    };
    back ? addon.findPrevious(q, opts) : addon.findNext(q, opts);
  }, []);

  const closeFind = useCallback(() => {
    setFindOpen(false);
    setFindQuery("");
    setFindHits(null);
    searchRef.current?.clearDecorations?.();
    xtermRef.current?.focus();
  }, []);

  openFindRef.current = () => {
    setFindOpen(true);
    setTimeout(() => findInputRef.current?.select(), 20);
  };

  switchRef.current = (dir) => {
    if (tabs.length < 2) return;
    const i = tabs.findIndex((t) => t.hostId === hostId);
    const next = tabs[(i + dir + tabs.length) % tabs.length];
    if (next) navigate({ to: "/terminal/$hostId", params: { hostId: next.hostId } });
  };



  // Persist font size
  useEffect(() => {
    localStorage.setItem(FONT_STORAGE_KEY, String(fontSize));
    if (xtermRef.current) {
      xtermRef.current.options.fontSize = fontSize;
      try { fitRef.current?.fit(); } catch { /* ignore */ }
    }
  }, [fontSize]);

  // Session clock. Starts when the stream goes live and resets on reconnect,
  // so it reads as "how long this session has been up" rather than how long
  // the page has been open.
  useEffect(() => {
    if (connState !== "connected") return;
    setElapsed(0);
    const id = window.setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => window.clearInterval(id);
  }, [connState, reconnectKey]);


  /**
   * Escape refuses a held command.
   *
   * The dialog had no Escape handling at all, so the one key everyone presses
   * to dismiss a modal did nothing — and the command stayed held with no
   * obvious way out. Refusing rather than merely closing is the only safe
   * reading: dismissing a warning is not agreeing to it.
   *
   * Capture phase, because xterm turns Escape into  for the shell and
   * cancels the event before it can bubble — the same reason Ctrl+F needed it.
   */
  useEffect(() => {
    if (!guard) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      socketRef.current?.send(
        JSON.stringify({ type: "resolveGuardrail", proceed: false, ruleId: guard.id }),
      );
      setGuard(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [guard]);

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Ctrl+F: find in scrollback
      if (e.ctrlKey && !e.shiftKey && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        openFindRef.current();
        return;
      }

      // Ctrl+Tab / Ctrl+Shift+Tab: move between open sessions
      if (e.ctrlKey && e.key === "Tab") {
        e.preventDefault();
        switchRef.current(e.shiftKey ? -1 : 1);
        return;
      }

      // Ctrl+Shift+W: close this tab (detaches; the shell keeps running)
      if (e.ctrlKey && e.shiftKey && (e.key === "W" || e.key === "w")) {
        e.preventDefault();
        closeCurrentRef.current();
        return;
      }
      // Ctrl+= or Ctrl++: increase font size
      if (e.ctrlKey && (e.key === "=" || e.key === "+")) {
        e.preventDefault();
        setFontSize((s) => Math.min(s + 1, MAX_FONT));
        return;
      }
      // Ctrl+-: decrease font size
      if (e.ctrlKey && e.key === "-") {
        e.preventDefault();
        setFontSize((s) => Math.max(s - 1, MIN_FONT));
        return;
      }
      // Ctrl+0: reset font size
      if (e.ctrlKey && e.key === "0") {
        e.preventDefault();
        setFontSize(DEFAULT_FONT);
        return;
      }
    };
    // Capture phase, not bubble. xterm handles keydown on its own hidden
    // textarea and calls cancel() for anything it recognises, which does
    // preventDefault() *and* stopPropagation() — Ctrl+F is a control code
    // (^F) it sends straight to the shell. A bubble-phase listener on window
    // therefore never runs while the terminal has focus, which is the only
    // time these shortcuts are wanted. Capturing runs window-first, before
    // the event reaches the textarea at all.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const reconnect = useCallback(() => {
    socketRef.current?.close();
    setConnState("connecting");
    setStatusMsg("Reconnecting…");
    setLatencyMs(null);
    setReconnectKey((k) => k + 1);
  }, []);

  const approveFingerprint = useCallback(() => {
    const sock = socketRef.current;
    if (sock?.readyState === WebSocket.OPEN) {
      sock.send(JSON.stringify({ type: "fingerprint_approve" }));
    }
    setPendingFp(null);
  }, []);

  const rejectFingerprint = useCallback(() => {
    const sock = socketRef.current;
    if (sock?.readyState === WebSocket.OPEN) {
      sock.send(JSON.stringify({ type: "fingerprint_reject" }));
    }
    setPendingFp(null);
  }, []);

  useEffect(() => {
    if (!hostId || !termRef.current) return;
    let term: any, fitAddon: any;
    let cancelled = false;
    streamReadyRef.current = false;
    pendingInputRef.current = [];

    const init = async () => {
      const { Terminal } = await import("@xterm/xterm");
      const { FitAddon } = await import("@xterm/addon-fit");
      const { WebLinksAddon } = await import("@xterm/addon-web-links");
      const { SearchAddon } = await import("@xterm/addon-search");
      if (cancelled) return;

      term = new Terminal({
        cursorBlink: true,
        fontSize,
        fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Consolas', 'Menlo', monospace",
        scrollback: 5000,
        allowProposedApi: true,
        macOptionIsMeta: true,
        rightClickSelectsWord: true,
        // Instrument Panel palette. The status hues here are the same ones the
        // rest of the app uses for live/caution/critical, so a green "Running"
        // in the terminal and a green health dot in the sidebar mean the same
        // thing. Background is surface-base, not black.
        theme: {
          background: "#0E1116", foreground: "#E6EAF0",
          cursor: "#4C8DFF", selectionBackground: "#2B3440",
          black: "#161B22", red: "#F85149", green: "#3FB950",
          yellow: "#D29922", blue: "#4C8DFF", magenta: "#B77DF0",
          cyan: "#3FB6C9", white: "#8B95A5",
          brightBlack: "#3A434F", brightRed: "#FF6B63",
          brightGreen: "#56D364", brightYellow: "#E3B341",
          brightBlue: "#7AA9FF", brightMagenta: "#CB9BF5",
          brightCyan: "#56C9DB", brightWhite: "#E6EAF0",
        },
      });
      fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.loadAddon(new WebLinksAddon());
      const searchAddon = new SearchAddon();
      term.loadAddon(searchAddon);
      searchRef.current = searchAddon;
      // The addon reports match counts; the find bar shows them as "3 / 17".
      searchAddon.onDidChangeResults?.((r: any) => {
        setFindHits(r && r.resultCount >= 0
          ? { current: r.resultIndex + 1, total: r.resultCount }
          : null);
      });
      term.open(termRef.current!);
      try { fitAddon.fit(); } catch { /* ignore */ }
      xtermRef.current = term;
      fitRef.current = fitAddon;

      // Auto-focus so users can type immediately
      term.focus();

      // Buffer keystrokes until the SSH shell is ready (fixes first-keystroke loss)
      term.onData((data: string) => {
        const sock = socketRef.current;
        if (!sock || sock.readyState !== WebSocket.OPEN) return;
        if (streamReadyRef.current) {
          sock.send(JSON.stringify({ type: "input", data: encodeInputToBase64(data) }));
        } else {
          pendingInputRef.current.push(data);
        }
      });

      const socket = createTerminalSocket(hostId);
      socketRef.current = socket;

      // Whether a real, described error already arrived on the message
      // channel. The transport error fires afterwards and says strictly less,
      // so it must not overwrite it. Scoped to this connection attempt, which
      // is exactly the lifetime that matters.
      let described = false;

      socket.onopen = () => {
        // Send initial size so the server starts with the right dimensions
        try {
          socket.send(JSON.stringify({ type: "resize", rows: term.rows, cols: term.cols }));
        } catch { /* ignore */ }
      };

      socket.onmessage = (event) => {
        let msg: TerminalMessage;
        try { msg = JSON.parse(event.data); } catch { return; }
        switch (msg.type) {
          case "data":
            term.write(Uint8Array.from(atob(msg.data!), c => c.charCodeAt(0)));
            break;
          case "status":
            setStatusMsg(msg.message || "");
            if (msg.message === "Connected" || msg.message === "Reattached") {
              setConnState("connected");
              streamReadyRef.current = true;
              // Make sure the server-side PTY has our dimensions before we
              // replay anything the user typed while waiting.
              try {
                if (socket.readyState === WebSocket.OPEN) {
                  socket.send(JSON.stringify({ type: "resize", rows: term.rows, cols: term.cols }));
                }
              } catch { /* ignore */ }
              // Flush any keystrokes buffered before the shell was ready
              while (pendingInputRef.current.length > 0) {
                const data = pendingInputRef.current.shift()!;
                socket.send(JSON.stringify({ type: "input", data: encodeInputToBase64(data) }));
              }
              // Start latency ping loop
              if (pingIntervalRef.current) window.clearInterval(pingIntervalRef.current);
              pingIntervalRef.current = window.setInterval(() => {
                if (socket.readyState === WebSocket.OPEN) {
                  lastPingTsRef.current = Date.now();
                  try { socket.send(JSON.stringify({ type: "ping", t: lastPingTsRef.current })); } catch { /* ignore */ }
                }
              }, 5000) as unknown as number;
            }
            if (msg.message === "Session ended") {
              setConnState("disconnected");
              streamReadyRef.current = false;
            }
            break;
          case "pong":
            if (lastPingTsRef.current > 0) {
              setLatencyMs(Date.now() - lastPingTsRef.current);
            }
            break;
          case "error":
            described = true;
            setConnState("error");
            setStatusMsg(msg.message || msg.code || "Error");
            // A blocked connection isn't a failure — it's the policy working.
            // Saying "connection failed" here would read as a bug and send
            // people looking for a network problem that doesn't exist.
            if (msg.code === "APPROVAL_REQUIRED") {
              term.writeln(`\r\n\x1b[33m⊘ ${msg.message || "Approval required"}\x1b[0m`);
              setGateOpen(true);
            } else {
              term.writeln(`\r\n\x1b[31m✗ ${msg.message || "Connection error"}\x1b[0m`);
              toast.error("Connection failed", { description: msg.message });
            }
            break;
          case "guardrail":
            // `hit` is optional on the message type, so it's normalised to
            // null rather than left undefined — the dialog opens on truthiness.
            setGuard(msg.hit ?? null);
            break;
          case "fingerprint_new":
            term.writeln(`\r\n\x1b[33m⚠ Unrecognized host key for ${msg.hostname}\x1b[0m`);
            term.writeln(`  ${msg.fingerprint}`);
            term.writeln("  Verify this matches the server before continuing.\r\n");
            setPendingFp({ fingerprint: msg.fingerprint || "", hostname: msg.hostname || hostId });
            break;
          case "fingerprint_mismatch":
            term.writeln(`\r\n\x1b[31m✗ FINGERPRINT MISMATCH — possible MITM attack\x1b[0m`);
            term.writeln(`  expected: ${msg.expected}`);
            term.writeln(`  actual:   ${msg.actual}`);
            toast.error("Fingerprint mismatch", { description: "Connection refused for safety. Verify the host manually.", duration: 10000 });
            break;
        }
      };

      socket.onclose = () => {
        if (cancelled) return;
        setConnState((s) => s === "error" ? s : "disconnected");
        setStatusMsg("Disconnected");
        streamReadyRef.current = false;
        if (pingIntervalRef.current) {
          window.clearInterval(pingIntervalRef.current);
          pingIntervalRef.current = null;
        }
      };
      socket.onerror = () => {
        if (cancelled) return;
        setConnState("error");
        // "WebSocket error" is the last resort, not the default. It used to
        // land unconditionally and overwrite the real reason — including
        // "This host requires approval from another team member", which is
        // policy working correctly, reported as a network fault.
        if (!described) setStatusMsg("WebSocket error");
      };

      const onResize = () => {
        try {
          fitAddon.fit();
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: "resize", rows: term.rows, cols: term.cols }));
          }
        } catch { /* ignore resize errors */ }
      };
      window.addEventListener("resize", onResize);
      const obs = new ResizeObserver(onResize);
      if (termRef.current) obs.observe(termRef.current);

      // Re-focus terminal when the user clicks anywhere inside the screen area
      const clickHandler = () => term.focus();
      termRef.current?.addEventListener("click", clickHandler);

      return () => {
        window.removeEventListener("resize", onResize);
        obs.disconnect();
        termRef.current?.removeEventListener("click", clickHandler);
      };
    };

    const cleanupPromise = init();
    return () => {
      cancelled = true;
      cleanupPromise.then((fn) => fn?.());
      if (pingIntervalRef.current) {
        window.clearInterval(pingIntervalRef.current);
        pingIntervalRef.current = null;
      }
      socketRef.current?.close();
      searchRef.current = null;
      xtermRef.current?.dispose();
      xtermRef.current = null;
      fitRef.current = null;
    };
    // reconnectKey is what triggers a re-init when the user clicks Reconnect
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostId, reconnectKey]);

  const h = host.data;
  const dotClass =
    connState === "connected" ? "connected"
    : connState === "connecting" ? "connecting"
    : connState === "error" ? "error"
    : "idle";

  const latencyTier =
    latencyMs == null ? null
    : latencyMs < 80 ? "good"
    : latencyMs < 200 ? "warn"
    : "bad";

  return (
    <div className={`term-page${findOpen ? " has-find" : ""}${isPane ? " is-pane" : ""}`}>
      {/* Tab strip. One tab today — the strip is here so multi-session tabs
          slot in without moving anything else. */}
      {!isPane && (
      <div className="term-tabs">
        <div className="term-tabs__list">
          {tabs.map((t) => {
            const active = t.hostId === hostId;
            return (
              <div
                key={t.hostId}
                className={`term-tab${active ? " is-active " + dotClass : ""}`}
                onClick={() => {
                  if (!active) navigate({ to: "/terminal/$hostId", params: { hostId: t.hostId } });
                }}
                title={t.label}
              >
                <span className="term-tab__dot" />
                <span className="term-tab__label">{t.label}</span>
                <button
                  type="button"
                  className="term-tab__close"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (active) closeCurrent();
                    else closeTab(t.hostId);
                  }}
                  title="Close session"
                  aria-label={`Close ${t.label}`}
                >
                  <I.Close size={11} />
                </button>
              </div>
            );
          })}
        </div>
        <button
          type="button"
          className="term-tabs__new"
          onClick={() => navigate({ to: "/" })}
          title="Open another host"
          aria-label="Open another host"
        >
          <I.Plus size={13} />
        </button>
      </div>
      )}

      {/* Session strip — what this session is and how it's behaving. */}
      <div className="term-session">
        <button
          type="button"
          className="term-session__back"
          onClick={() => navigate({ to: "/" })}
          title="Back to hosts (does not disconnect)"
          aria-label="Back to hosts"
        >
          <I.ArrowRight size={12} style={{ transform: "rotate(180deg)" }} />
        </button>

        <span className={`term-session__host ${dotClass}`}>
          <span className="dot" />
          {h?.label || hostId}
        </span>

        {h && (
          <span className="term-session__addr">
            {h.username}@{h.hostname}:{h.port}
          </span>
        )}

        <span className="term-session__sep" />

        <span className="term-session__clock" title="Session duration">
          <I.Clock size={11} />
          {formatElapsed(elapsed)}
        </span>

        <span className="term-session__status">{statusMsg}</span>

        <span className="term-session__spacer" />

        {recordingOn && connState === "connected" && (
          <span className="term-session__rec" title="This session is being recorded">
            <span className="rec-dot" />
            REC
          </span>
        )}

        {latencyMs != null && (
          <span className={`term-session__lat ${latencyTier && latencyTier !== "good" ? latencyTier : ""}`}>
            {latencyMs}<span className="unit">ms</span>
          </span>
        )}

        <span className="term-session__tools" role="group" aria-label="Terminal font size">
          <button
            type="button"
            onClick={() => setFontSize((v) => Math.max(v - 1, MIN_FONT))}
            disabled={fontSize <= MIN_FONT}
            title="Decrease font size (Ctrl+-)"
            aria-label="Decrease font size"
          >
            A−
          </button>
          <span className="value" title="Current font size">{fontSize}</span>
          <button
            type="button"
            onClick={() => setFontSize((v) => Math.min(v + 1, MAX_FONT))}
            disabled={fontSize >= MAX_FONT}
            title="Increase font size (Ctrl+=)"
            aria-label="Increase font size"
          >
            A+
          </button>
        </span>

        {!isPane && (
          // Shown even when it can't be used. Hiding it made the button appear
          // and disappear depending on how many tabs were open, which reads as
          // a glitch; disabled with an explanation is clearer.
          //
          // Two tabs are genuinely required: several tabs on one host share a
          // single managed SSH session, so splitting a host against itself
          // would have both panes fighting over the same stream and each
          // kicking the other out.
          <button
            type="button"
            className={`term-session__btn${splitOpen ? " is-primary" : ""}`}
            disabled={!splitOpen && !onSplit}
            onClick={() => (splitOpen ? onCloseSplit?.() : onSplit?.())}
            title={
              splitOpen
                ? "Close the split pane"
                : onSplit
                  ? "Show two sessions side by side"
                  : "Open a second host to split the view"
            }
            aria-label={splitOpen ? "Close split" : "Split view"}
          >
            <I.Server size={11} />
            {splitOpen ? "Unsplit" : "Split"}
          </button>
        )}

        <button
          type="button"
          className="term-session__btn"
          onClick={() => setShowHelp((v) => !v)}
          title="Keyboard shortcuts"
          aria-label="Show keyboard shortcuts"
        >
          <I.Info size={12} />
        </button>

        {(connState === "disconnected" || connState === "error") && (
          <button
            type="button"
            className="term-session__btn is-primary"
            onClick={reconnect}
            title="Reconnect to this host"
          >
            <I.ArrowRight size={11} />
            Reconnect
          </button>
        )}

        <button
          type="button"
          className="term-session__btn is-danger"
          onClick={disconnectCurrent}
          title="End this session and stop any recording"
        >
          <I.Close size={11} />
          Disconnect
        </button>
      </div>

      {findOpen && (
        <div className="term-find">
          <I.Search size={13} />
          <input
            ref={findInputRef}
            className="mono"
            value={findQuery}
            placeholder="Find in scrollback"
            onChange={(e) => { setFindQuery(e.target.value); runFind(e.target.value); }}
            onKeyDown={(e) => {
              if (e.key === "Escape") { e.preventDefault(); closeFind(); }
              else if (e.key === "Enter") { e.preventDefault(); runFind(findQuery, e.shiftKey); }
            }}
            autoFocus
          />
          <span className="term-find__count">
            {findHits ? (findHits.total ? `${findHits.current} / ${findHits.total}` : "no matches") : ""}
          </span>
          <button type="button" onClick={() => runFind(findQuery, true)} title="Previous (Shift+Enter)" aria-label="Previous match">
            <I.Chevron size={12} style={{ transform: "rotate(-90deg)" }} />
          </button>
          <button type="button" onClick={() => runFind(findQuery)} title="Next (Enter)" aria-label="Next match">
            <I.Chevron size={12} style={{ transform: "rotate(90deg)" }} />
          </button>
          <button type="button" onClick={closeFind} title="Close (Esc)" aria-label="Close find">
            <I.Close size={12} />
          </button>
        </div>
      )}

      {guard && (
        <div className="dialog-overlay">
          <div className={`dialog guard guard--${guard.severity}`} role="alertdialog">
            <div className="guard__head">
              <span className="guard__icon"><I.Warn size={18} /></span>
              <div>
                <h2 className="guard__title">{guard.title}</h2>
                <span className="guard__sev">
                  {guard.severity === "critical" ? "Irreversible" : "Worth a second look"}
                </span>
              </div>
            </div>

            <pre className="guard__cmd">{guard.command}</pre>
            <p className="guard__detail">{guard.detail}</p>

            <div className="guard__foot">
              <button
                className="btn btn--secondary"
                autoFocus
                onClick={() => {
                  socketRef.current?.send(
                    JSON.stringify({ type: "resolveGuardrail", proceed: false, ruleId: guard.id }),
                  );
                  setGuard(null);
                }}
              >
                Cancel
              </button>
              <button
                className={`btn ${guard.severity === "critical" ? "btn--danger" : "btn--primary"}`}
                onClick={() => {
                  socketRef.current?.send(
                    JSON.stringify({ type: "resolveGuardrail", proceed: true, ruleId: guard.id }),
                  );
                  setGuard(null);
                }}
              >
                Run it anyway
              </button>
            </div>
          </div>
        </div>
      )}

      {gateOpen && (
        <div className="dialog-overlay" onClick={(e) => { if (e.target === e.currentTarget) setGateOpen(false); }}>
          <div className="dialog" role="dialog" aria-label="Approval required">
            <div className="dialog__head">
              <h2>Approval required</h2>
            </div>

            <div className="ap-gate__body">
              {gateSent ? (
                <div className="ap-gate__waiting">
                  <I.Clock size={15} />
                  <span>
                    Request sent. Someone on your team needs to approve it — this
                    screen doesn't need to stay open. Try connecting again once
                    it's granted.
                  </span>
                </div>
              ) : (
                <>
                  <p className="ap-gate__lede">
                    {/* Not "<host> is tagged": the block can be on a jump host
                        this connection routes through rather than on the
                        destination itself, and this dialog cannot tell which —
                        approvals:request resolves that server-side and raises
                        whichever request(s) are actually needed. */}
                    This connection needs approval from another team member
                    before it can proceed.
                  </p>
                  <label className="ap-gate__label">Why do you need access?</label>
                  <textarea
                    className="ap-gate__input"
                    rows={3}
                    value={gateReason}
                    onChange={(e) => setGateReason(e.target.value)}
                    placeholder="Investigating the checkout errors from this morning"
                    autoFocus
                  />
                </>
              )}
            </div>

            <div className="dialog__foot">
              <button className="btn btn--secondary" onClick={() => setGateOpen(false)}>
                {gateSent ? "Close" : "Cancel"}
              </button>
              {!gateSent && (
                <button
                  className="btn btn--primary"
                  disabled={gateBusy}
                  onClick={async () => {
                    setGateBusy(true);
                    try {
                      await apiPost("/api/approvals/request", {
                        hostId,
                        reason: gateReason.trim() || undefined,
                      });
                      setGateSent(true);
                    } catch (e: any) {
                      toast.error(e?.message || "Couldn't send that request");
                    } finally {
                      setGateBusy(false);
                    }
                  }}
                >
                  {gateBusy ? "Sending…" : "Request access"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* xterm screen */}
      <div className="term__screen-wrap">
        <div ref={termRef} className="term__screen" />

        {/* Session-ended overlay */}
        {(connState === "disconnected" || connState === "error") && (
          <div className="term__overlay">
            <div className="term__overlay-card">
              <div className={`term__overlay-icon ${connState}`}>
                {connState === "error" ? <I.Close size={18} /> : <I.Info size={18} />}
              </div>
              <div className="term__overlay-title">
                {connState === "error" ? "Connection error" : "Session ended"}
              </div>
              <div className="term__overlay-msg">{statusMsg}</div>
              <div className="term__overlay-actions">
                <button type="button" className="btn btn--primary" onClick={reconnect}>
                  Reconnect
                </button>
                <button type="button" className="btn btn--secondary" onClick={() => navigate({ to: "/" })}>
                  Back to hosts
                </button>
              </div>
            </div>
          </div>
        )}

        {/* New host fingerprint confirmation */}
        {pendingFp && (
          <div className="term__overlay">
            <div className="term__overlay-card" style={{ maxWidth: 460 }}>
              <div className="term__overlay-icon connecting">
                <I.Info size={18} />
              </div>
              <div className="term__overlay-title">Verify host key</div>
              <div className="term__overlay-msg" style={{ lineHeight: 1.5 }}>
                First time connecting to <strong>{pendingFp.hostname}</strong>. Confirm the
                fingerprint below matches the server before trusting it.
              </div>
              <div style={{
                fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg-0)",
                background: "var(--bg-2)", border: "1px solid var(--border)",
                borderRadius: 6, padding: "8px 10px", margin: "12px 0", wordBreak: "break-all",
              }}>
                {pendingFp.fingerprint}
              </div>
              <div className="term__overlay-actions">
                <button type="button" className="btn btn--primary" onClick={approveFingerprint}>
                  Trust &amp; connect
                </button>
                <button type="button" className="btn btn--secondary" onClick={rejectFingerprint}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Keyboard shortcuts popover */}
        {showHelp && (
          <div className="term__help" onClick={() => setShowHelp(false)}>
            <div className="term__help-card" onClick={(e) => e.stopPropagation()}>
              <div className="term__help-head">
                <strong>Keyboard shortcuts</strong>
                <button type="button" onClick={() => setShowHelp(false)} aria-label="Close">
                  <I.Close size={12} />
                </button>
              </div>
              <ul>
                <li><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd><span>Copy selection</span></li>
                <li><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>V</kbd><span>Paste</span></li>
                <li><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>W</kbd><span>Close this session</span></li>
                <li><kbd>Ctrl</kbd>+<kbd>Tab</kbd><span>Next session</span></li>
                <li><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Tab</kbd><span>Previous session</span></li>
                <li><kbd>Ctrl</kbd>+<kbd>+</kbd><span>Increase font size</span></li>
                <li><kbd>Ctrl</kbd>+<kbd>-</kbd><span>Decrease font size</span></li>
                <li><kbd>Ctrl</kbd>+<kbd>0</kbd><span>Reset font size</span></li>
              </ul>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The terminal route.
 *
 * Owns only the split layout; everything else lives in the pane. The split
 * host is remembered per primary host, so splitting web-01 against db-02 and
 * then switching tabs and back restores the same pairing rather than losing it.
 */
export function TerminalRoute() {
  const { hostId } = useParams({ strict: false }) as { hostId: string };
  const tabs = useTabs((s) => s.tabs);
  const [splits, setSplits] = useState<Record<string, string>>({});

  // Where the divider sits, as the first pane's share of the width. The
  // layout was a fixed 1fr/1px/1fr, so panes were locked at half each and a
  // long line — `ls -la` output, say — had nowhere to go but wrap.
  const [splitRatio, setSplitRatio] = useState<number>(() => {
    const stored = Number(localStorage.getItem(SPLIT_RATIO_KEY));
    return Number.isFinite(stored) && stored >= MIN_SPLIT_RATIO && stored <= MAX_SPLIT_RATIO
      ? stored
      : 0.5;
  });
  const splitRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    localStorage.setItem(SPLIT_RATIO_KEY, String(splitRatio));
  }, [splitRatio]);

  // Pointer capture rather than window listeners: the pointer keeps
  // delivering to the divider even as it travels over either terminal, which
  // would otherwise swallow the move events.
  const startDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDragging(true);
  };

  const onDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    const box = splitRef.current?.getBoundingClientRect();
    if (!box || box.width === 0) return;
    const ratio = (e.clientX - box.left) / box.width;
    setSplitRatio(Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, ratio)));
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    try { (e.target as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* already released */ }
    setDragging(false);
  };

  const splitWith = splits[hostId] ?? null;

  // A split against a host whose tab was closed would leave a dead pane, so
  // it's dropped rather than left showing a disconnected session.
  useEffect(() => {
    if (!splitWith) return;
    if (!tabs.some((t) => t.hostId === splitWith)) {
      setSplits((prev) => {
        const next = { ...prev };
        delete next[hostId];
        return next;
      });
    }
  }, [tabs, splitWith, hostId]);

  const openSplit = () => {
    // Split against the next open tab. With only one tab open there's nothing
    // to split against, so the button offers the host list instead.
    const other = tabs.find((t) => t.hostId !== hostId);
    if (other) setSplits((prev) => ({ ...prev, [hostId]: other.hostId }));
  };

  const closeSplit = () =>
    setSplits((prev) => {
      const next = { ...prev };
      delete next[hostId];
      return next;
    });

  const canSplit = tabs.length > 1;

  if (!splitWith) {
    return (
      <TerminalPane
        key={hostId}
        hostId={hostId}
        onSplit={canSplit ? openSplit : undefined}
        splitOpen={false}
      />
    );
  }

  return (
    <div
      className={`term-split${dragging ? " is-dragging" : ""}`}
      ref={splitRef}
      style={{
        gridTemplateColumns: `${splitRatio}fr 6px ${1 - splitRatio}fr`,
      }}
    >
      {/* Keyed by host so switching the split target remounts cleanly rather
          than reusing another host's terminal. */}
      <TerminalPane
        key={hostId}
        hostId={hostId}
        onSplit={openSplit}
        onCloseSplit={closeSplit}
        splitOpen
      />
      <div
        className="term-split__divider"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panes"
        title="Drag to resize · double-click to even them up"
        onPointerDown={startDrag}
        onPointerMove={onDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={() => setSplitRatio(0.5)}
      />
      <TerminalPane key={splitWith} hostId={splitWith} isPane />
    </div>
  );
}
