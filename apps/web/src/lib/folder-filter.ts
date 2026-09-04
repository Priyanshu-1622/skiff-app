import { create } from "zustand";

/**
 * Which folder the host list is filtered to.
 *
 * This lives in a store rather than in the dashboard because the folder list is
 * in the sidebar, and the sidebar is on every screen. While it was dashboard
 * state, every other route rendered the sidebar with no folders at all and a
 * host count of zero — the folders appeared to vanish the moment you opened
 * Files or Tunnels.
 *
 * `__starred` is a filter rather than a real folder, which is why this is a
 * plain string and not a folder id.
 */
interface FolderFilterState {
  active: string | null;
  setActive: (id: string | null) => void;
}

export const useFolderFilter = create<FolderFilterState>((set) => ({
  active: null,
  setActive: (id) => set({ active: id }),
}));
