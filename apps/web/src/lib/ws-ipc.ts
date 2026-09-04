/**
 * A WebSocket-shaped adapter over the terminal IPC channels.
 *
 * The terminal component was written against a raw browser WebSocket: it calls
 * `.send(JSON.stringify(...))`, reads `.readyState`, and assigns `.onmessage` /
 * `.onopen` / `.onclose`. Rewriting all of that to an IPC-native shape would
 * touch a lot of carefully-tuned reconnect and buffering logic.
 *
 * Instead this presents the exact surface the component already uses, backed by
 * the IPC bridge. `createTerminalSocket` returns one of these in Electron, so
 * the component is transport-agnostic without changing a line of it.
 *
 * The message translation is the crux: the component's WebSocket protocol used
 * `{type:"input"}` / `{type:"resize"}` / `{type:"ping"}` outbound and the main
 * process speaks `terminal:write` / `terminal:resize`. Ping/pong was a
 * WebSocket liveness measure; over in-process IPC there is no socket to keep
 * alive, so pings are answered locally with an immediate pong (latency ≈ 0)
 * rather than round-tripped.
 */

import type { SkiffBridge, TerminalEvent } from "../../../desktop/src/shared/ipc.js";

// The three readyState values the component checks.
const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

interface WsLike {
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(): void;
}

export function createTerminalSocketIpc(hostId: string): WsLike {
  const bridge = (window as any).skiff as SkiffBridge;

  const sock: WsLike = {
    readyState: CONNECTING,
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send() {
      /* replaced once the session id is known — see below */
    },
    close() {
      /* replaced below */
    },
  };

  let sessionId: string | null = null;
  let unsubscribe: (() => void) | null = null;
  // Anything the component sends before terminal:open resolves is buffered,
  // exactly as a real WebSocket queues writes made before it's OPEN.
  const outbox: string[] = [];
  // The mirror of `outbox`. The main process emits status events *during*
  // the terminal:open call, which arrive before its reply tells us our
  // session id — so there is nothing to match them against yet. Dropping
  // them loses real state: "Reattached" is emitted synchronously on the
  // reattach path, and losing it leaves the UI stuck on "Connecting…" over
  // a working shell. They are held here and filtered once the id is known.
  const inbox: TerminalEvent[] = [];
  const MAX_BUFFERED_EVENTS = 500;

  /** Deliver a JSON message to the component's onmessage handler. */
  const deliver = (obj: unknown) => {
    sock.onmessage?.({ data: JSON.stringify(obj) });
  };

  /** Route one main-process terminal event into the component's protocol. */
  const route = (event: TerminalEvent) => {
    switch (event.type) {
      case "data":
        deliver({ type: "data", data: event.data });
        break;
      case "status":
        deliver({ type: "status", message: event.message });
        break;
      case "error":
        deliver({ type: "error", message: event.message, code: event.code });
        break;
      case "exit":
        // The component treats "Session ended" as a clean disconnect.
        deliver({ type: "status", message: "Session ended" });
        sock.readyState = CLOSED;
        sock.onclose?.();
        break;
      case "fingerprint_new":
        deliver({
          type: "fingerprint_new",
          fingerprint: event.fingerprint,
          hostname: event.hostname,
        });
        break;
      case "fingerprint_mismatch":
        deliver({
          type: "fingerprint_mismatch",
          expected: event.expected,
          actual: event.actual,
        });
        break;
      // Without this the guardrail never reached the UI. The main process
      // held the command and asked; the shim dropped the question on the
      // floor, so no dialog appeared and nothing could answer it. The
      // protocol type declared "guardrail" and the component handled it —
      // only the route between them was missing, which is why it failed
      // silently rather than erroring anywhere.
      case "guardrail":
        deliver({ type: "guardrail", hit: (event as any).hit });
        break;
    }
  };

  const onEvent = (event: TerminalEvent) => {
    if (!sessionId) {
      if (inbox.length < MAX_BUFFERED_EVENTS) inbox.push(event);
      return;
    }
    if (event.sessionId !== sessionId) return;
    route(event);
  };

  // Wire the real send/close now that the closure state exists.
  sock.send = (raw: string) => {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    // Ping is a WebSocket keepalive; there's no socket here, so answer it
    // locally and immediately rather than bothering the main process.
    if (msg.type === "ping") {
      deliver({ type: "pong", t: msg.t });
      return;
    }

    if (sock.readyState !== OPEN || !sessionId) {
      outbox.push(raw);
      return;
    }

    // Ends the session rather than detaching from it — see the main-process
    // handler. Sent by Disconnect; closing a tab still detaches.
    if (msg.type === "disconnect") {
      void bridge.invoke("terminal:disconnect", { sessionId });
      return;
    }

    if (msg.type === "input") {
      void bridge.invoke("terminal:write", { sessionId, data: msg.data });
    } else if (msg.type === "resize") {
      void bridge.invoke("terminal:resize", {
        sessionId,
        cols: msg.cols,
        rows: msg.rows,
      });
    } else if (
      // The terminal component sends "fingerprint_approve" / "_reject"; the
      // old WebSocket server expected "confirm_fingerprint" with an `accept`
      // flag. Only the second name was handled here, so accepting a host key
      // in the desktop app did nothing at all — the connection sat on
      // "Connecting…" until the 60-second verifier timeout.
      //
      // Both names are accepted rather than renaming one side, because the
      // browser build still talks to the Fastify server and uses the old one.
      msg.type === "fingerprint_approve" ||
      msg.type === "fingerprint_reject" ||
      msg.type === "confirm_fingerprint"
    ) {
      const accept =
        msg.type === "fingerprint_approve" ? true :
        msg.type === "fingerprint_reject" ? false :
        !!msg.accept;
      void bridge.invoke("terminal:confirmFingerprint", { sessionId, accept });
    } else if (msg.type === "resolveGuardrail") {
      void bridge.invoke("terminal:resolveGuardrail", {
        sessionId,
        proceed: msg.proceed,
        ruleId: msg.ruleId,
      });
    }
  };

  sock.close = () => {
    if (sessionId) void bridge.invoke("terminal:close", { sessionId });
    unsubscribe?.();
    sock.readyState = CLOSED;
  };

  // Kick off the open. The component sets its handlers synchronously right
  // after calling createTerminalSocket, so defer the open callback to a
  // microtask to guarantee onopen is assigned before we fire it.
  unsubscribe = bridge.on("terminal:event", onEvent as never);

  Promise.resolve()
    .then(() =>
      bridge.invoke<{ ok: boolean; data?: { sessionId: string } } | any>(
        "terminal:open",
        { hostId, cols: 80, rows: 24 },
      ),
    )
    .then((res: any) => {
      // The bridge returns the ApiResult envelope; unwrap it.
      const sid = res?.data?.sessionId ?? res?.sessionId;
      if (!sid) {
        // A failing handler returns { ok: false, error: { code, message } }
        // rather than rejecting, so the code has to be carried across
        // deliberately. It used to be dropped here.
        const err = new Error(res?.error?.message ?? "Failed to open session");
        (err as { code?: string }).code = res?.error?.code;
        throw err;
      }
      sessionId = sid;
      sock.readyState = OPEN;
      sock.onopen?.();
      // Replay what arrived before we knew which session was ours, now
      // that there is an id to filter it against.
      for (const event of inbox.splice(0)) {
        if (event.sessionId === sessionId) route(event);
      }
      // Flush anything queued before we had a session id.
      const queued = outbox.splice(0);
      for (const raw of queued) sock.send(raw);
    })
    .catch((err: unknown) => {
      // A failed open used to become a bare onerror() with the reason thrown
      // away, which the terminal rendered as "websocket error".
      //
      // That is wrong for any failure and actively misleading for one in
      // particular: a host behind break-glass approval fails with
      // APPROVAL_REQUIRED, and the terminal keys on that code to open the
      // "Request access" dialog. With the code discarded, a correctly blocked
      // connection looked like a transport fault, no request was ever raised,
      // and the host became unreachable with nothing to approve.
      const e = err as { message?: string; code?: string };
      deliver({
        type: "error",
        message: e?.message ?? "Failed to open session",
        code: e?.code,
      });
      sock.readyState = CLOSED;
      sock.onerror?.();
    });

  return sock;
}
