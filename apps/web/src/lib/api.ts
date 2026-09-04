/**
 * API dispatcher.
 *
 * The same React UI runs in two hosts: the Electron desktop app (no server,
 * talks to the main process over IPC) and a browser against the self-hosted
 * Fastify server (HTTP). This module picks the transport at runtime by looking
 * for the preload bridge, so every call site keeps importing `apiGet` etc.
 * from here and never has to know which host it's in.
 *
 * `window.skiff` is injected by the desktop preload script and is absent in a
 * plain browser — that presence check is the whole switch.
 */

import {
  ApiError,
  apiGetHttp,
  apiPostHttp,
  apiPutHttp,
  apiDeleteHttp,
  type HealthResponse,
} from "./api-http.js";
import {
  apiGetIpc,
  apiPostIpc,
  apiPutIpc,
  apiDeleteIpc,
} from "./api-ipc.js";

export { ApiError };
export type { HealthResponse };

/** True when running inside the Electron desktop shell. */
export const isDesktop = (): boolean =>
  typeof window !== "undefined" && !!(window as any).skiff;

export function apiGet<T>(path: string): Promise<T> {
  return isDesktop() ? apiGetIpc<T>(path) : apiGetHttp<T>(path);
}

export function apiPost<T = unknown>(path: string, payload?: unknown): Promise<T> {
  return isDesktop() ? apiPostIpc<T>(path, payload) : apiPostHttp<T>(path, payload);
}

export function apiPut<T = unknown>(path: string, payload?: unknown): Promise<T> {
  return isDesktop() ? apiPutIpc<T>(path, payload) : apiPutHttp<T>(path, payload);
}

export function apiDelete<T = unknown>(path: string): Promise<T> {
  return isDesktop() ? apiDeleteIpc<T>(path) : apiDeleteHttp<T>(path);
}
