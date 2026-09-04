/**
 * Electron main process — the Skiff backend.
 *
 * There is no HTTP server here. No port is bound, no cookie is signed, and
 * nothing listens on the network. The engine runs in this process and the
 * renderer reaches it only through the IPC channels registered below.
 *
 * That is a security property, not just a simplification: the server build
 * had to expose 127.0.0.1:8080, which any other local process — or any web
 * page in the user's browser via DNS rebinding — could attempt to reach. For
 * an application holding SSH private keys that was the wrong trade. Removing
 * the listener removes the entire class of attack.
 */

import { app, BrowserWindow, Menu, ipcMain, shell, session } from "electron";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createEngine, destroyEngine, type EngineContext } from "./engine.js";
import { registerHandlers } from "./ipc/registry.js";
import { registerAuthHandlers } from "./ipc/auth.js";
import { registerDataHandlers } from "./ipc/data.js";
import { registerTerminalHandlers } from "./ipc/terminal.js";
import { registerTeamHandlers } from "./ipc/team.js";
import { registerSettingsHandlers } from "./ipc/settings.js";
import { registerKeychainHandlers } from "./ipc/keychain.js";
import { registerApprovalHandlers } from "./ipc/approvals.js";
import { registerUpdateHandlers } from "./ipc/updates.js";
import { registerFileHandlers } from "./ipc/files.js";
import { registerTunnelHandlers, tunnelManager } from "./ipc/tunnels.js";
import { registerSnippetHandlers } from "./ipc/snippets.js";
import { getSessionId } from "./ipc/auth.js";
import {
  createTray,
  destroyTray,
  refreshTray,
  markQuitting,
  isQuitting,
  notifyHiddenToTray,
  type TrayDeps,
} from "./tray.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const isDev = !app.isPackaged;
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL ?? "http://localhost:5173";

let mainWindow: BrowserWindow | null = null;
let engine: EngineContext | null = null;

/** True when a tray icon actually exists to restore the window from. */
let trayReady = false;
function trayAvailable(): boolean {
  return trayReady;
}

function getWindow(): BrowserWindow | null {
  return mainWindow;
}

/**
 * Drop Electron's stock menu.
 *
 * Its accelerators are handled in the browser process and never reach the
 * page, which is fatal for a terminal: Ctrl+= / Ctrl+- / Ctrl+0 were zooming
 * the whole window instead of resizing the terminal font, and Ctrl+W closed
 * the window outright — a keystroke away from a running session, on a key
 * combination shells use. An app that exists to receive Ctrl+key cannot leave
 * a default menu bidding for them first.
 *
 * Chromium still handles clipboard and selection natively, so removing the
 * Edit menu costs nothing. The dev conveniences the menu used to provide are
 * re-bound below, in development only, where they cannot collide with a
 * shipped build.
 */
function installMenu(win: BrowserWindow): void {
  Menu.setApplicationMenu(null);

  // F11 came from the stock menu's toggleFullScreen role, so removing the
  // menu took window fullscreen with it. It is rebound here rather than by
  // restoring the menu, because the menu is what was stealing Ctrl+= / Ctrl+-
  // / Ctrl+0 / Ctrl+W from the terminal in the first place. Shipped builds get
  // this too — fullscreen is not a dev convenience.
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    const key = input.key.toLowerCase();

    if (key === "f11") {
      win.setFullScreen(!win.isFullScreen());
      event.preventDefault();
      return;
    }

    if (!isDev) return;
    if (input.control && input.shift && key === "i") {
      win.webContents.toggleDevTools();
      event.preventDefault();
    } else if (input.control && !input.shift && key === "r") {
      win.webContents.reload();
      event.preventDefault();
    }
  });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 680,
    // Matches surface-base in the Instrument Panel design tokens, so the
    // window doesn't flash white before the renderer paints.
    backgroundColor: "#0E1116",
    show: false,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      // The three settings that make the renderer a sandboxed web page rather
      // than a Node process. Skiff holds decrypted credentials in main; if the
      // renderer could require('fs'), any XSS in the UI would escalate
      // straight to key theft.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload needs require(); contextIsolation still applies
      webviewTag: false,
    },
  });

  installMenu(mainWindow);

  // Avoid a white flash: wait until the first paint.
  mainWindow.once("ready-to-show", () => mainWindow?.show());

  /**
   * Closing hides rather than quits, so sessions keep running.
   *
   * Sessions live in the engine and a long command keeps going while the app
   * does. If closing the window killed the process, closing it mid-rsync would
   * kill the rsync — which a terminal app must not do by accident. The tray
   * keeps it alive; Quit there ends it properly.
   *
   * Skipped when the tray is off or unavailable, since then there would be no
   * way to get the window back.
   */
  mainWindow.on("close", (event) => {
    if (isQuitting() || !trayAvailable()) return;
    event.preventDefault();
    mainWindow?.hide();
    let sessions = 0;
    try { sessions = engine?.sessionManager.list().length ?? 0; } catch { /* ignore */ }
    notifyHiddenToTray(sessions);
  });


  // External links open in the user's real browser, never in an Electron
  // window — an in-app window would have our preload attached.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // Same http(s)-only rule as the app:openExternal handler, and for a
    // sharper reason: WebLinksAddon makes anything a *server* prints into a
    // clickable link, and that click arrives here. A compromised or hostile
    // host could echo `file:///...`, an SMB path, or a custom scheme and have
    // this hand it straight to the OS — remote code execution triggered by
    // reading a log file. Refusing anything that isn't http(s) closes it.
    if (!/^https?:\/\//i.test(url)) return { action: "deny" };
    void shell.openExternal(url);
    return { action: "deny" };
  });

  // Block in-page navigation away from the app. Without this, a crafted link
  // could navigate the renderer to a remote origin that still has the preload
  // bridge attached.
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const allowed = isDev ? DEV_SERVER_URL : "file://";
    if (!url.startsWith(allowed)) event.preventDefault();
  });

  if (isDev) {
    void mainWindow.loadURL(DEV_SERVER_URL);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function applyContentSecurityPolicy(): void {
  // The renderer loads only local assets. A strict CSP means that even if a
  // hostname or recording payload manages to inject markup, it cannot pull
  // remote script or exfiltrate over the network.
  //
  // Deliberately no blob: here. Recording playback needed a way to reach a
  // .cast without an HTTP server, and widening connect-src was one option;
  // handing the player the recording inline is the other, and it keeps this
  // policy as narrow as it was. See the player source in routes/recordings.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [
          isDev
            ? // Vite's dev server needs eval and a websocket for HMR.
              "default-src 'self'; script-src 'self' 'unsafe-eval' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://localhost:5173; img-src 'self' data:; font-src 'self' data:"
            : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self' data:",
        ],
      },
    });
  });
}

// Windows routes every toast through an AppUserModelID, and an app that never
// sets one gets no notifications at all — silently. `new Notification().show()`
// returns normally, `Notification.isSupported()` still says true, and nothing
// appears. The "Skiff is still running" warning was being swallowed exactly
// this way, which is the one notification that matters: it fires when the
// window vanishes and the process does not.
//
// The id matches electron-builder's `appId`, so a packaged install and a dev
// run identify themselves as the same application.
if (process.platform === "win32") app.setAppUserModelId("me.skiffssh.desktop");

app.whenReady().then(() => {
  applyContentSecurityPolicy();

  // Data lives in the OS-appropriate per-user location: %APPDATA% on Windows,
  // ~/Library/Application Support on macOS, ~/.config on Linux. Electron
  // resolves it; the engine just receives a path, which is exactly why
  // CoreConfig takes dataDir instead of reading env itself.
  engine = createEngine(app.getPath("userData"));

  registerHandlers({
    ...registerAuthHandlers(engine),
    ...registerDataHandlers(engine),
    ...registerTeamHandlers(engine),
    ...registerSettingsHandlers(engine),
    ...registerKeychainHandlers(engine),
    ...registerApprovalHandlers(engine),
    ...registerTunnelHandlers(engine),
    ...registerSnippetHandlers(engine),
    ...registerFileHandlers(engine, (event) => {
      const win = getWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send("files:transfer", event);
      }
    }),
    ...registerUpdateHandlers(engine, (status) => {
      const win = getWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send("app:updateStatus", status);
      }
    }),
    ...registerTerminalHandlers(engine, (event) => {
      const win = getWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send("terminal:event", event);
      }
    }),

    "app:version": async () => ({
      version: app.getVersion(),
      electron: process.versions.electron,
      node: process.versions.node,
      platform: process.platform,
    }),
    // app:showItemInFolder was removed. Nothing in the renderer called it, and
    // it took an arbitrary path straight to the OS file explorer. An unused
    // channel is still a reachable one — any XSS in the UI could have used it.
    // If a "reveal in folder" feature is added later it should validate that
    // the path is inside a directory Skiff owns.
    "app:openExternal": async (payload) => {
      const url = String((payload as { url?: string })?.url ?? "");
      // Only ever hand http(s) to the OS. Without this check a crafted
      // file:// or custom-scheme URL could be used to launch a local handler.
      if (!/^https?:\/\//i.test(url)) throw new Error("Refused non-http URL");
      await shell.openExternal(url);
      return { ok: true };
    },
  });

  createWindow();

  // ── Tray ──────────────────────────────────────────────────────────────
  const trayEnabled = (): boolean => {
    try {
      const row = engine?.db.raw
        .prepare("SELECT tray_enabled FROM vault_meta WHERE id = 1")
        .get() as { tray_enabled?: number } | undefined;
      return row?.tray_enabled === undefined ? true : !!row.tray_enabled;
    } catch {
      return true;
    }
  };

  const trayDeps: TrayDeps = {
    getWindow: () => getWindow(),
    showWindow: () => {
      const win = getWindow();
      if (win && !win.isDestroyed()) {
        if (!win.isVisible()) win.show();
        if (win.isMinimized()) win.restore();
        win.focus();
      } else {
        createWindow();
      }
    },
    recentHosts: () => {
      try {
        const rows = engine?.db.raw
          .prepare(
            `SELECT id, label, hostname FROM hosts
             ORDER BY last_connected_at DESC NULLS LAST, label COLLATE NOCASE
             LIMIT 8`,
          )
          .all() as any[];
        return (rows ?? []).map((h) => ({ id: h.id, label: h.label || h.hostname }));
      } catch {
        return [];
      }
    },
    sessionCount: () => {
      try { return engine?.sessionManager.list().length ?? 0; } catch { return 0; }
    },
    tunnelCount: () => {
      try { return tunnelManager.countRunning(); } catch { return 0; }
    },
    vaultUnlocked: () => {
      try { return !!engine && getSessionId() !== null; } catch { return false; }
    },
    lockVault: () => {
      const win = getWindow();
      if (win && !win.isDestroyed()) win.webContents.send("app:lockVault");
    },
    connectTo: (hostId) => {
      const win = getWindow();
      if (win && !win.isDestroyed()) win.webContents.send("app:connectTo", { hostId });
    },
  };

  trayReady = trayEnabled() ? createTray(trayDeps) !== null : false;

  // Rebuilt periodically rather than on every event: the counts only need to
  // be right when someone opens the menu, and rebuilding on each session
  // change would thrash the menu while tabs are being opened.
  const trayTimer = setInterval(() => {
    if (trayEnabled()) refreshTray(trayDeps);
  }, 15_000);
  app.on("before-quit", () => clearInterval(trayTimer));

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else trayDeps.showWindow();
  });
});

// On macOS apps conventionally stay running with no windows; elsewhere,
// closing the last window quits.
app.on("window-all-closed", () => {
  // With a tray, closing the window hides it rather than destroying it, so
  // this only fires when the window genuinely went away. Quit anyway off
  // macOS, matching platform convention.
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  markQuitting();
  destroyTray();
  // Tunnels hold real listening sockets. Without this the port can stay bound
  // after the app exits, and the next launch fails with "already in use" on a
  // port nothing is using.
  void tunnelManager.stopAll();
  if (engine) {
    destroyEngine(engine);
    engine = null;
  }
});

// A second instance would open the same SQLite file and fight over the WAL.
// Focus the existing window instead.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// Never allow a renderer to attach a debugger to another process.
app.on("web-contents-created", (_e, contents) => {
  contents.on("will-attach-webview", (event) => event.preventDefault());
});

// Surface handler crashes rather than letting them vanish silently.
//
// Both are caught, not just the synchronous one. Node terminates the process
// on an unhandled rejection by default, and in this app the main process is
// where every SSH session lives — so a stray rejected promise anywhere would
// take down running shells, transfers and tunnels along with it. A desktop
// terminal must not die because a background task failed, and a rejection is
// no more fatal than the exception already tolerated beside it.
process.on("uncaughtException", (err) => {
  console.error("[main] uncaught exception:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[main] unhandled rejection:", reason);
});

export { ipcMain };
