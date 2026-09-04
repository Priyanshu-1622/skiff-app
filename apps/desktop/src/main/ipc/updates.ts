/**
 * Auto-update.
 *
 * Checks GitHub Releases for a newer version, downloads it in the background,
 * and installs it when the app next quits.
 *
 * ── Why it matters more than it looks ──────────────────────────────────────
 * Without this, everyone who installs v1 stays on v1 forever. A security fix
 * would reach only the people who happen to revisit the download page — which,
 * for a tool that holds SSH private keys, is the wrong way to run a release.
 * That's why it ships in v1 rather than "later": v1.1 cannot add it
 * retroactively to installs that already exist.
 *
 * ── Consent ────────────────────────────────────────────────────────────────
 * Checking is automatic; installing is not. The download happens quietly, and
 * then the app waits — restarting someone's terminal without asking would kill
 * live SSH sessions, which is the one thing this app must never do casually.
 * The user chooses when to restart, or it simply applies on their next quit.
 *
 * ── The one network call ───────────────────────────────────────────────────
 * Skiff makes no other outbound requests. This is the exception, it goes only
 * to GitHub's release feed, it carries no vault data, and it can be switched
 * off. That last part is not decoration — an air-gapped install must be able
 * to stop it entirely, and the setting is honoured before any check runs.
 */

import { app } from "electron";
import type { EngineContext } from "../engine.js";
import type { Handlers } from "./contract.js";
import { requireVaultKey } from "./auth.js";

export type UpdateState =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "current"
  | "error"
  | "disabled";

export interface UpdateStatus {
  state: UpdateState;
  version: string | null;
  /** 0–100 while downloading. */
  progress: number;
  message: string | null;
  currentVersion: string;
  checkedAt: string | null;
}

type Emit = (status: UpdateStatus) => void;

export function registerUpdateHandlers(
  engine: EngineContext,
  emit: Emit,
): Handlers {
  const db = engine.db.raw;

  const status: UpdateStatus = {
    state: "idle",
    version: null,
    progress: 0,
    message: null,
    currentVersion: app.getVersion(),
    checkedAt: null,
  };

  const set = (patch: Partial<UpdateStatus>) => {
    Object.assign(status, patch);
    emit({ ...status });
  };

  const enabled = (): boolean => {
    try {
      const row = db
        .prepare("SELECT updates_enabled FROM vault_meta WHERE id = 1")
        .get() as { updates_enabled?: number } | undefined;
      // Default on: a security tool that silently stops checking for its own
      // security fixes is the worse failure of the two.
      return row?.updates_enabled === undefined ? true : !!row.updates_enabled;
    } catch {
      return true;
    }
  };

  /**
   * electron-updater is imported lazily and inside a try.
   *
   * In development there's no update feed and no code signature, so the module
   * throws on load. Letting that propagate would take the whole app down at
   * startup — which would mean a feature nobody can use in dev breaking the
   * thing everybody uses in dev.
   */
  let autoUpdater: any = null;
  let wired = false;

  async function getUpdater(): Promise<any | null> {
    if (autoUpdater) return autoUpdater;
    if (!app.isPackaged) return null;
    try {
      const mod = await import("electron-updater");
      autoUpdater = (mod as any).autoUpdater ?? (mod as any).default?.autoUpdater;
      if (!autoUpdater) return null;

      // Download quietly; never restart on our own initiative.
      autoUpdater.autoDownload = true;
      autoUpdater.autoInstallOnAppQuit = true;

      if (!wired) {
        wired = true;
        autoUpdater.on("checking-for-update", () =>
          set({ state: "checking", message: null }),
        );
        autoUpdater.on("update-available", (info: any) =>
          set({ state: "available", version: info?.version ?? null, progress: 0 }),
        );
        autoUpdater.on("update-not-available", () =>
          set({ state: "current", version: null, checkedAt: new Date().toISOString() }),
        );
        autoUpdater.on("download-progress", (p: any) =>
          set({ state: "downloading", progress: Math.round(p?.percent ?? 0) }),
        );
        autoUpdater.on("update-downloaded", (info: any) =>
          set({
            state: "ready",
            version: info?.version ?? null,
            progress: 100,
            checkedAt: new Date().toISOString(),
          }),
        );
        autoUpdater.on("error", (err: any) =>
          // Reported, never thrown. A failed update check must not interrupt
          // whatever the person was doing.
          set({ state: "error", message: err?.message ?? "Update check failed" }),
        );
      }
      return autoUpdater;
    } catch {
      return null;
    }
  }

  async function check(): Promise<UpdateStatus> {
    if (!enabled()) {
      set({ state: "disabled", message: null });
      return { ...status };
    }
    const updater = await getUpdater();
    if (!updater) {
      set({
        state: "idle",
        message: app.isPackaged ? "Updates unavailable" : "Updates only run in a packaged build",
      });
      return { ...status };
    }
    try {
      await updater.checkForUpdates();
    } catch (err: any) {
      set({ state: "error", message: err?.message ?? "Update check failed" });
    }
    return { ...status };
  }

  /**
   * A check shortly after launch, then daily.
   *
   * Delayed on purpose: the first seconds after start belong to unlocking and
   * connecting, not to a background download competing for bandwidth.
   */
  function startSchedule(): void {
    if (!app.isPackaged) return;

    // unref() so neither timer holds the event loop open. Without it the
    // daily interval keeps Node alive and the app can hang on quit instead
    // of exiting — a bug that only shows up in a packaged build, where it is
    // hardest to diagnose.
    const first = setTimeout(() => void check(), 30_000);
    const daily = setInterval(() => void check(), 24 * 60 * 60 * 1000);
    first.unref?.();
    daily.unref?.();

    app.on("before-quit", () => {
      clearTimeout(first);
      clearInterval(daily);
    });
  }

  startSchedule();

  return {
    "app:updateCheck": async () => check(),

    "app:updateStatusGet": async () => ({ ...status, enabled: enabled() }),

    "app:updateInstall": async () => {
      if (status.state !== "ready") {
        return { ok: false, reason: "No update is ready to install" };
      }
      const updater = await getUpdater();
      if (!updater) return { ok: false, reason: "Updates unavailable" };
      // Quits and relaunches. Sessions are detached rather than killed by the
      // engine's own shutdown path, but the user chose this moment.
      setImmediate(() => updater.quitAndInstall(false, true));
      return { ok: true };
    },

    "app:updateSetEnabled": async (payload) => {
      // Writes to vault_meta, so it needs an unlocked vault like every other
      // setting. This module had no auth check at all.
      requireVaultKey(engine);
      const on = !!(payload as { enabled?: boolean })?.enabled;
      db.prepare("UPDATE vault_meta SET updates_enabled = ? WHERE id = 1").run(on ? 1 : 0);
      if (!on) set({ state: "disabled", message: null });
      else void check();
      return { ok: true, enabled: on };
    },
  };
}
