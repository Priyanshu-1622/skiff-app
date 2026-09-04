/**
 * System tray.
 *
 * Two jobs: quick access to hosts without hunting for the window, and keeping
 * Skiff alive when the window is closed so sessions survive.
 *
 * ── Closing the window doesn't quit ───────────────────────────────────────
 * This is the behaviour change worth being deliberate about. Sessions live in
 * the engine, and the whole point of persistent sessions is that a long-running
 * command keeps running. If closing the window killed the process, closing it
 * mid-`rsync` would kill the rsync — which is exactly what a terminal app must
 * not do by accident.
 *
 * So the window hides and the tray keeps the process alive. Quitting is
 * explicit: the tray's Quit item, or Cmd/Ctrl+Q.
 *
 * The obvious risk is someone thinking they closed the app when they didn't.
 * That's handled by telling them the first time it happens, once, and by the
 * setting that turns the whole behaviour off.
 */

import { app, Tray, Menu, nativeImage, Notification, type BrowserWindow } from "electron";
import { join } from "node:path";
import { existsSync, writeFileSync } from "node:fs";

export interface TrayDeps {
  getWindow: () => BrowserWindow | null;
  showWindow: () => void;
  /** Hosts for the quick-connect list, most recently used first. */
  recentHosts: () => Array<{ id: string; label: string }>;
  sessionCount: () => number;
  tunnelCount: () => number;
  vaultUnlocked: () => boolean;
  lockVault: () => void;
  /** Ask the renderer to open a host. */
  connectTo: (hostId: string) => void;
}

let tray: Tray | null = null;
let quitting = false;
let warnedAboutHiding = false;

/**
 * Marker for the hide-to-tray hint, so "once" means once.
 *
 * The in-memory flag only lasts as long as the process, so anyone who closes
 * the window habitually got warned again on every launch — the notifications
 * then stack up in the Windows Action Centre and read as a fault. The comment
 * on notifyHiddenToTray always said "once"; this is what makes that true.
 *
 * A file rather than a database row: this fires while the vault may be locked,
 * and a UI hint is not vault data.
 */
function hintMarkerPath(): string {
  return join(app.getPath("userData"), "tray-hint-shown");
}

function alreadyHinted(): boolean {
  if (warnedAboutHiding) return true;
  try {
    return existsSync(hintMarkerPath());
  } catch {
    // Unreadable userData: warn this run rather than never.
    return false;
  }
}

function rememberHinted(): void {
  warnedAboutHiding = true;
  try {
    writeFileSync(hintMarkerPath(), new Date().toISOString(), "utf8");
  } catch {
    /* the in-memory flag still covers this run */
  }
}

export function isQuitting(): boolean {
  return quitting;
}

export function markQuitting(): void {
  quitting = true;
}

function iconPath(): string {
  // In development the resources sit beside the source; packaged, they're in
  // the app root. `process.resourcesPath` only exists in the packaged case.
  const base = app.isPackaged
    ? join(process.resourcesPath, "resources")
    : join(app.getAppPath(), "resources");
  // macOS uses a template image so the OS can recolour it for light and dark
  // menu bars; other platforms need a visible one.
  return join(base, process.platform === "darwin" ? "trayTemplate.png" : "tray.png");
}

export function createTray(deps: TrayDeps): Tray | null {
  if (tray) return tray;

  try {
    const image = nativeImage.createFromPath(iconPath());
    if (process.platform === "darwin") image.setTemplateImage(true);
    tray = new Tray(image);
  } catch {
    // Some Linux desktops have no tray at all. That's a missing convenience,
    // not a failure — the app runs exactly as before without one.
    return null;
  }

  tray.setToolTip("Skiff");

  const render = () => {
    if (!tray) return;
    const unlocked = deps.vaultUnlocked();
    const hosts = unlocked ? deps.recentHosts().slice(0, 8) : [];
    const sessions = deps.sessionCount();
    const tunnels = deps.tunnelCount();

    const menu = Menu.buildFromTemplate([
      { label: "Open Skiff", click: () => deps.showWindow() },
      { type: "separator" },

      // Locked is a state worth showing rather than an empty menu — otherwise
      // the tray looks broken when it's simply doing its job.
      ...(unlocked
        ? [
            {
              label: sessions === 1 ? "1 open session" : `${sessions} open sessions`,
              enabled: false,
            },
            ...(tunnels > 0
              ? [{ label: tunnels === 1 ? "1 tunnel" : `${tunnels} tunnels`, enabled: false }]
              : []),
            { type: "separator" as const },
            ...(hosts.length > 0
              ? [
                  { label: "Connect to", enabled: false },
                  ...hosts.map((h) => ({
                    label: `   ${h.label}`,
                    click: () => {
                      deps.showWindow();
                      deps.connectTo(h.id);
                    },
                  })),
                  { type: "separator" as const },
                ]
              : []),
            { label: "Lock vault", click: () => deps.lockVault() },
          ]
        : [{ label: "Vault is locked", enabled: false }]),

      { type: "separator" },
      { label: "Quit Skiff", click: () => { quitting = true; app.quit(); } },
    ]);

    tray.setContextMenu(menu);
  };

  render();

  // Clicking the icon should just show the window on Windows and Linux, where
  // that's the convention. macOS opens the menu, which is its convention.
  tray.on("click", () => {
    if (process.platform !== "darwin") deps.showWindow();
  });

  return tray;
}

/** Rebuild the menu — call when sessions, tunnels or lock state change. */
export function refreshTray(deps: TrayDeps): void {
  if (!tray) return;
  destroyTray();
  createTray(deps);
}

export function destroyTray(): void {
  try { tray?.destroy(); } catch { /* already gone */ }
  tray = null;
}

/**
 * Tell the user once that the app is still running.
 *
 * Only the first time, and only when there's actually something to lose. A
 * notification every time would be nagging; none at all leaves someone
 * wondering where the app went.
 */
export function notifyHiddenToTray(sessionCount: number): void {
  if (alreadyHinted()) return;

  const title = "Skiff is still running";
  const body =
    sessionCount > 0
      ? `${sessionCount === 1 ? "Your session is" : "Your sessions are"} still open. Quit from the tray icon to end them.`
      : "Skiff is in the tray. Quit from the tray icon to close it completely.";

  // Windows first, via the tray balloon.
  //
  // Toasts there need an AppUserModelID *and* a Start-menu shortcut pointing at
  // it. The id is set now, but a dev run has no shortcut, so a toast would still
  // vanish without a word — and this is the message that must not vanish: it is
  // the only thing telling someone their window closed but their sessions did
  // not. A balloon hangs off the tray icon and needs neither, which also puts
  // the message next to the icon the user is being told to look for.
  // Only recorded once something was actually displayed. Marking it shown on a
  // platform that dropped it would burn the one chance to say this.
  if (process.platform === "win32" && tray) {
    try {
      tray.displayBalloon({ title, content: body, iconType: "info" });
      rememberHinted();
      return;
    } catch {
      /* fall through to the standard notification */
    }
  }

  if (!Notification.isSupported()) return;
  try {
    new Notification({ title, body, silent: true }).show();
    rememberHinted();
  } catch {
    /* notifications unavailable — not worth failing over */
  }
}
