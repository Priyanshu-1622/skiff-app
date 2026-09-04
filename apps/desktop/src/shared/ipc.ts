/**
 * The IPC contract.
 *
 * Every channel the renderer may invoke, and every event the main process may
 * push. This file is the single source of truth for both sides — the preload
 * bridge builds its surface from `INVOKE_CHANNELS`, and the main process
 * registers handlers against the same list. If a channel is added here and
 * nowhere else, startup will fail loudly rather than silently 404 the way an
 * unregistered HTTP route would.
 *
 * Naming mirrors the old REST paths so the mapping stays obvious during the
 * port: `GET /api/vault/status` becomes `vault:status`. Keeping the shapes
 * identical means the renderer's TanStack Query hooks keep their existing
 * cache keys and response types.
 */

// ── Request/response channels (renderer -> main, returns a value) ─────────
export const INVOKE_CHANNELS = [
  // health
  "health:check",

  // vault / auth
  "vault:status",
  "vault:setup",
  "vault:unlock",
  "vault:lock",

  // folders
  "folders:list",
  "folders:create",
  "folders:update",
  "folders:delete",

  // hosts
  "hosts:list",
  "hosts:get",
  "hosts:create",
  "hosts:update",
  "hosts:delete",

  // import
  "import:parse",
  "import:apply",

  // recordings
  "recordings:list",
  "recordings:cast",
  "recordings:delete",

  // settings
  "settings:changePassword",
  "settings:idleTimeout",
  "settings:recording",
  "settings:backup",
  "settings:upgradeTeam",
  "settings:restore",

  // team
  "team:login",
  "team:me",
  "team:usersList",
  "team:userCreate",
  "team:userReprovision",
  "team:userSetDisabled",
  "team:audit",
  "audit:list",
  "audit:verify",
  "audit:export",
  "keychain:status",
  "keychain:enable",
  "keychain:disable",
  "vault:unlockWithDevice",
  "approvals:policy",
  "approvals:setPolicy",
  "approvals:list",
  "approvals:pendingCount",
  "approvals:request",
  "approvals:decide",
  "terminal:resolveGuardrail",
  "settings:guardrails",
  "app:updateCheck",
  "app:updateStatusGet",
  "app:updateInstall",
  "app:updateSetEnabled",
  "files:list",
  "files:mkdir",
  "files:rename",
  "files:delete",
  "files:localList",
  "files:localMkdir",
  "files:localRename",
  "files:localDelete",
  "files:download",
  "files:upload",
  "files:cancel",
  "tunnels:list",
  "tunnels:count",
  "tunnels:start",
  "tunnels:stop",
  "snippets:list",
  "snippets:create",
  "snippets:update",
  "snippets:delete",
  "snippets:run",
  "settings:tray",

  // terminal lifecycle (the stream itself is event-based, below)
  "terminal:open",
  "terminal:write",
  "terminal:resize",
  "terminal:close",
  // close detaches and leaves the shell running; disconnect ends it.
  "terminal:disconnect",
  "terminal:confirmFingerprint",

  // desktop-only
  "app:version",
  "app:openExternal",
] as const;

export type InvokeChannel = (typeof INVOKE_CHANNELS)[number];

// ── Push channels (main -> renderer, fire and forget) ────────────────────
/**
 * Terminal output and status are pushed rather than polled. Each message
 * carries the sessionId it belongs to, because a single renderer can hold
 * several terminals open at once (tabs and split panes) over one IPC bridge —
 * the old design had one WebSocket per terminal, so routing was implicit.
 */
export const EVENT_CHANNELS = [
  "terminal:event",
  "app:updateStatus",
  "files:transfer",
  "app:lockVault",
  "app:connectTo",
] as const;

export type EventChannel = (typeof EVENT_CHANNELS)[number];

// ── Terminal event payloads ──────────────────────────────────────────────
/**
 * Mirrors the message types the WebSocket used to send, so the terminal
 * component's reducer can stay as-is apart from the transport swap.
 */
export type TerminalEvent =
  | { sessionId: string; type: "data"; data: string } // base64
  | { sessionId: string; type: "status"; message: string }
  | { sessionId: string; type: "error"; message?: string; code?: string }
  | { sessionId: string; type: "exit"; code?: number }
  | {
      sessionId: string;
      type: "fingerprint_new";
      fingerprint: string;
      hostname: string;
    }
  | {
      sessionId: string;
      type: "fingerprint_mismatch";
      expected: string;
      actual: string;
    }
  | {
      sessionId: string;
      type: "guardrail";
      hit: {
        id: string;
        severity: "critical" | "warning";
        title: string;
        detail: string;
        command: string;
      };
    };

// ── The API surface exposed on window.skiff ──────────────────────────────
export interface SkiffBridge {
  invoke<T = unknown>(channel: InvokeChannel, payload?: unknown): Promise<T>;
  on(channel: EventChannel, listener: (payload: never) => void): () => void;
  /**
   * Host platform. Typed as a plain string union rather than NodeJS.Platform
   * because this file is imported by the renderer too, which compiles under a
   * DOM tsconfig with no Node types.
   */
  platform: "win32" | "darwin" | "linux" | string;
}
