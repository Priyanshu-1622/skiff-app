import { create } from "zustand";

/**
 * Open terminal tabs.
 *
 * This store holds only the *list* of open hosts — it never holds a terminal
 * or a connection. Switching tabs navigates the router, which unmounts one
 * terminal and mounts another. That works because the engine already keeps SSH
 * sessions alive independently of the socket: closing a terminal detaches
 * rather than ends, and reopening replays the scrollback into the same live
 * shell. So a tab switch is a detach and a reattach, not a reconnect, and the
 * shell on the other end never notices.
 *
 * The alternative — keeping every tab's terminal mounted at once — would mean
 * several xterm instances competing to size themselves against a hidden
 * container, which is where that approach usually goes wrong.
 *
 * The list is persisted so tabs survive a reload or an app restart.
 */

const STORAGE_KEY = "skiff.terminal.tabs";

export interface TerminalTab {
  hostId: string;
  label: string;
}

interface TabState {
  tabs: TerminalTab[];
  open: (tab: TerminalTab) => void;
  close: (hostId: string) => TerminalTab | null;
  rename: (hostId: string, label: string) => void;
  clear: () => void;
}

function load(): TerminalTab[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((t) => t && typeof t.hostId === "string")
      : [];
  } catch {
    return [];
  }
}

function save(tabs: TerminalTab[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tabs));
  } catch {
    /* storage unavailable — tabs just won't persist */
  }
}

export const useTabs = create<TabState>((set, get) => ({
  tabs: load(),

  open: (tab) => {
    const tabs = get().tabs;
    if (tabs.some((t) => t.hostId === tab.hostId)) return;
    const next = [...tabs, tab];
    save(next);
    set({ tabs: next });
  },

  /** Returns the tab to switch to after closing, or null if none are left. */
  close: (hostId) => {
    const tabs = get().tabs;
    const i = tabs.findIndex((t) => t.hostId === hostId);
    const next = tabs.filter((t) => t.hostId !== hostId);
    save(next);
    set({ tabs: next });
    if (next.length === 0) return null;
    return next[Math.min(i, next.length - 1)] ?? null;
  },

  rename: (hostId, label) => {
    const tabs = get().tabs;
    if (!tabs.some((t) => t.hostId === hostId && t.label !== label)) return;
    const next = tabs.map((t) => (t.hostId === hostId ? { ...t, label } : t));
    save(next);
    set({ tabs: next });
  },

  clear: () => {
    save([]);
    set({ tabs: [] });
  },
}));
