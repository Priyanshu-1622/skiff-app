/**
 * Terminal transport selector.
 *
 * In a browser this returns a real WebSocket to the Fastify server. In the
 * Electron desktop app there is no server, so it returns a WebSocket-shaped
 * adapter (ws-ipc.ts) backed by the IPC bridge. The terminal component uses
 * the returned object identically either way — it never learns which host
 * it's running in.
 */

import { createTerminalSocketIpc } from "./ws-ipc.js";

export interface TerminalMessage {
  type:
    | "data"
    | "status"
    | "error"
    | "fingerprint_new"
    | "fingerprint_mismatch"
    | "pong"
    // Emitted when a command trips a guardrail and is held at the prompt.
    | "guardrail";
  data?: string;
  message?: string;
  fingerprint?: string;
  hostname?: string;
  expected?: string;
  actual?: string;
  code?: string;
  t?: number;
  /** Present on "guardrail": what matched, and the command being held. */
  hit?: {
    id: string;
    severity: "critical" | "warning";
    title: string;
    detail: string;
    command: string;
  };
}

const isDesktop = (): boolean =>
  typeof window !== "undefined" && !!(window as any).skiff;

export function createTerminalSocket(hostId: string): WebSocket {
  if (isDesktop()) {
    // The adapter implements the subset of WebSocket the component uses; the
    // cast is deliberate and safe for that surface.
    return createTerminalSocketIpc(hostId) as unknown as WebSocket;
  }
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${proto}//${window.location.host}/api/terminal/${hostId}`;
  return new WebSocket(url);
}
