/**
 * Renderer transport over IPC.
 *
 * This is a drop-in replacement for lib/api.ts. It keeps the exact same
 * exported surface — apiGet / apiPost / apiPut / apiDelete and ApiError — so
 * every existing TanStack Query hook, mutation, and error boundary in the app
 * continues to work untouched. Only the wire changes.
 *
 * The path-to-channel map is the whole trick: components still say
 * `apiGet("/api/hosts")` and this layer turns that into `hosts:list`. That
 * means the port can land without editing dozens of call sites, and the same
 * component tree can still run against the HTTP server if we ever want it to.
 */

import type { ApiResult } from "@skiff/shared";
import { ApiError } from "./api-http.js";
import type { InvokeChannel, SkiffBridge } from "../../../desktop/src/shared/ipc.js";

declare global {
  interface Window {
    skiff?: SkiffBridge;
  }
}


function bridge(): SkiffBridge {
  const b = window.skiff;
  if (!b) {
    throw new ApiError(
      "INTERNAL",
      "Skiff bridge unavailable — preload did not load",
      0,
    );
  }
  return b;
}

/**
 * The query string, as an object.
 *
 * `resolve` matches on the path alone and drops everything after the "?".
 * That silently discarded every filter the callers send — selecting a folder
 * requests `/api/hosts?folderId=...` and got back every host in the vault,
 * and the same for starred and search. IPC has no URL to carry them, so they
 * travel in the payload instead, exactly as the parameterised-path ids do.
 */
function queryOf(path: string): Record<string, string> {
  const q = path.split("?")[1];
  if (!q) return {};
  return Object.fromEntries(new URLSearchParams(q));
}

/**
 * Route a REST-style path + method to an IPC channel.
 *
 * Parameterised paths (`/api/hosts/:id`) are matched by shape and the id is
 * folded into the payload, because IPC has no URL to carry it.
 */
function resolve(
  method: string,
  path: string,
): { channel: InvokeChannel; extra?: Record<string, unknown> } {
  const clean = (path.split("?")[0] ?? path).replace(/\/$/, "");
  const seg = clean.split("/").filter(Boolean); // ["api", "hosts", "<id>"]

  const M = `${method} ${clean}`;
  const staticMap: Record<string, InvokeChannel> = {
    "GET /api/health": "health:check",
    "GET /api/vault/status": "vault:status",
    "POST /api/vault/setup": "vault:setup",
    "POST /api/vault/unlock": "vault:unlock",
    "POST /api/vault/lock": "vault:lock",
    "GET /api/folders": "folders:list",
    "POST /api/folders": "folders:create",
    "GET /api/hosts": "hosts:list",
    "POST /api/hosts": "hosts:create",
    "POST /api/import/parse": "import:parse",
    "POST /api/import/apply": "import:apply",
    "GET /api/recordings": "recordings:list",
    "PUT /api/settings/password": "settings:changePassword",
    "PUT /api/settings/idle-timeout": "settings:idleTimeout",
    "PUT /api/settings/recording": "settings:recording",
    "GET /api/settings/backup": "settings:backup",
    "POST /api/settings/upgrade-team": "settings:upgradeTeam",
    "POST /api/settings/restore": "settings:restore",
    "POST /api/team/login": "team:login",
    "GET /api/team/me": "team:me",
    "GET /api/team/users": "team:usersList",
    "POST /api/team/users": "team:userCreate",
    "POST /api/team/users/reprovision": "team:userReprovision",
    "GET /api/team/audit": "team:audit",
    "GET /api/audit": "audit:list",
    "GET /api/audit/integrity": "audit:verify",
    "GET /api/audit/export": "audit:export",
    "GET /api/keychain": "keychain:status",
    "POST /api/keychain/enable": "keychain:enable",
    "POST /api/keychain/disable": "keychain:disable",
    "POST /api/vault/unlock-device": "vault:unlockWithDevice",
    "GET /api/approvals/policy": "approvals:policy",
    "PUT /api/approvals/policy": "approvals:setPolicy",
    "GET /api/approvals": "approvals:list",
    "GET /api/approvals/pending": "approvals:pendingCount",
    "POST /api/approvals/request": "approvals:request",
    "POST /api/approvals/decide": "approvals:decide",
    "PUT /api/settings/guardrails": "settings:guardrails",
    "GET /api/updates": "app:updateStatusGet",
    "POST /api/updates/check": "app:updateCheck",
    "POST /api/updates/install": "app:updateInstall",
    "PUT /api/updates/enabled": "app:updateSetEnabled",
    "POST /api/files/list": "files:list",
    "POST /api/files/mkdir": "files:mkdir",
    "POST /api/files/rename": "files:rename",
    "POST /api/files/delete": "files:delete",
    "POST /api/files/local": "files:localList",
    "POST /api/files/local/mkdir": "files:localMkdir",
    "POST /api/files/local/rename": "files:localRename",
    "POST /api/files/local/delete": "files:localDelete",
    "POST /api/files/download": "files:download",
    "POST /api/files/upload": "files:upload",
    "POST /api/files/cancel": "files:cancel",
    "GET /api/tunnels": "tunnels:list",
    "GET /api/tunnels/count": "tunnels:count",
    "POST /api/tunnels": "tunnels:start",
    "POST /api/tunnels/stop": "tunnels:stop",
    "GET /api/snippets": "snippets:list",
    "POST /api/snippets": "snippets:create",
    "PUT /api/snippets": "snippets:update",
    "POST /api/snippets/delete": "snippets:delete",
    "POST /api/snippets/run": "snippets:run",
    "PUT /api/settings/tray": "settings:tray",
  };
  if (staticMap[M]) return { channel: staticMap[M] };

  // Parameterised routes.
  const id = seg[2];
  if (seg[1] === "hosts" && id) {
    if (method === "GET") return { channel: "hosts:get", extra: { id } };
    if (method === "PUT") return { channel: "hosts:update", extra: { id } };
    if (method === "DELETE") return { channel: "hosts:delete", extra: { id } };
  }
  if (seg[1] === "folders" && id) {
    if (method === "PUT") return { channel: "folders:update", extra: { id } };
    if (method === "DELETE") return { channel: "folders:delete", extra: { id } };
  }
  if (seg[1] === "recordings" && id) {
    if (method === "DELETE") return { channel: "recordings:delete", extra: { id } };
    if (seg[3] === "cast") return { channel: "recordings:cast", extra: { id } };
  }
  if (seg[1] === "team" && seg[2] === "users" && seg[4] === "disabled") {
    return { channel: "team:userSetDisabled", extra: { id: seg[3] } };
  }

  throw new ApiError("NOT_FOUND", `No IPC channel for ${M}`, 404);
}

async function call<T>(
  method: string,
  path: string,
  payload?: unknown,
): Promise<T> {
  const { channel, extra } = resolve(method, path);
  const query = queryOf(path);
  const hasQuery = Object.keys(query).length > 0;
  // Precedence: query params first, then an explicit payload, then the id
  // folded out of the path — most specific wins.
  const body =
    extra || hasQuery
      ? {
          ...query,
          ...(typeof payload === "object" && payload !== null
            ? (payload as object)
            : {}),
          ...(extra ?? {}),
        }
      : payload;

  const result = (await bridge().invoke(channel, body)) as ApiResult<T>;

  if (!result.ok) {
    // Same global auth guard the HTTP client had: a locked vault anywhere
    // other than the vault routes themselves bounces to unlock.
    if (result.error.code === "VAULT_LOCKED" && !path.includes("/vault/")) {
      window.location.hash = "#/unlock";
    }
    throw new ApiError(result.error.code, result.error.message, 0);
  }
  return result.data;
}

export const apiGetIpc = <T>(path: string) => call<T>("GET", path);
export const apiPostIpc = <T = unknown>(path: string, payload?: unknown) =>
  call<T>("POST", path, payload);
export const apiPutIpc = <T = unknown>(path: string, payload?: unknown) =>
  call<T>("PUT", path, payload);
export const apiDeleteIpc = <T = unknown>(path: string) => call<T>("DELETE", path);

// ── Terminal streaming ───────────────────────────────────────────────────
/**
 * Replaces createTerminalSocket(). The WebSocket gave one stream per terminal;
 * IPC gives one shared channel, so callers subscribe with a sessionId filter.
 */
export interface TerminalHandle {
  sessionId: string;
  write(dataBase64: string): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  confirmFingerprint(accept: boolean): Promise<void>;
  close(): Promise<void>;
}

export async function openTerminal(
  hostId: string,
  cols: number,
  rows: number,
  onEvent: (event: { type: string; [k: string]: unknown }) => void,
): Promise<TerminalHandle> {
  const b = bridge();
  const res = (await b.invoke("terminal:open", {
    hostId,
    cols,
    rows,
  })) as ApiResult<{ sessionId: string; reattached: boolean }>;
  if (!res.ok) throw new ApiError(res.error.code, res.error.message, 0);
  const { sessionId } = res.data;

  const unsubscribe = b.on("terminal:event", ((event: {
    sessionId: string;
    type: string;
  }) => {
    // Demultiplex: one channel serves every open tab.
    if (event.sessionId === sessionId) onEvent(event);
  }) as never);

  return {
    sessionId,
    write: async (dataBase64) => {
      await b.invoke("terminal:write", { sessionId, data: dataBase64 });
    },
    resize: async (cols_, rows_) => {
      await b.invoke("terminal:resize", { sessionId, cols: cols_, rows: rows_ });
    },
    confirmFingerprint: async (accept) => {
      await b.invoke("terminal:confirmFingerprint", { sessionId, accept });
    },
    close: async () => {
      unsubscribe();
      await b.invoke("terminal:close", { sessionId });
    },
  };
}
