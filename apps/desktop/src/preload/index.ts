/**
 * Preload bridge.
 *
 * This is the ONLY thing the renderer can see of Node/Electron. The window is
 * created with contextIsolation on and nodeIntegration off, so the renderer is
 * a plain sandboxed web page — it cannot require('fs'), cannot reach ssh2, and
 * cannot touch the vault except by asking through a channel listed here.
 *
 * That matters more for Skiff than for a typical Electron app. This process
 * holds decrypted SSH credentials in memory. If the renderer could reach Node
 * directly, any XSS in the UI — or a malicious string rendered from a hostname
 * or a recording — would escalate straight to key theft. The allowlist below
 * is what keeps a UI bug from becoming a credential compromise.
 */

import { contextBridge, ipcRenderer } from "electron";
import {
  INVOKE_CHANNELS,
  EVENT_CHANNELS,
  type InvokeChannel,
  type EventChannel,
} from "../shared/ipc.js";

const invokeAllowed = new Set<string>(INVOKE_CHANNELS);
const eventAllowed = new Set<string>(EVENT_CHANNELS);

const bridge = {
  /**
   * Call the main process and await a result. Rejects if the channel isn't on
   * the allowlist — a typo fails immediately and visibly instead of hanging.
   */
  invoke<T = unknown>(channel: InvokeChannel, payload?: unknown): Promise<T> {
    if (!invokeAllowed.has(channel)) {
      return Promise.reject(
        new Error(`Blocked IPC channel: ${String(channel)}`),
      );
    }
    return ipcRenderer.invoke(channel, payload) as Promise<T>;
  },

  /**
   * Subscribe to a pushed event. Returns an unsubscribe function.
   *
   * The raw IpcRendererEvent is deliberately not passed to the listener: it
   * carries `sender`, which is a handle back into the main process that the
   * renderer has no business holding.
   */
  on(channel: EventChannel, listener: (payload: never) => void): () => void {
    if (!eventAllowed.has(channel)) {
      throw new Error(`Blocked IPC event channel: ${String(channel)}`);
    }
    const wrapped = (_event: unknown, payload: never) => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },

  platform: process.platform,
};

contextBridge.exposeInMainWorld("skiff", bridge);
