import { useEffect, useState } from "react";
import { Outlet, useRouterState } from "@tanstack/react-router";
import { Toaster } from "@/components/Toaster";
import { CommandPalette } from "@/components/CommandPalette";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { useNavigate } from "@tanstack/react-router";
import { useVault } from "@/lib/vault";

export function RootLayout() {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  const navigate = useNavigate();
  const lock = useVault((v) => v.lock);

  // The tray menu can lock the vault and jump to a host. Those arrive as
  // events from the main process rather than clicks, so the listeners live
  // here — the one component mounted for the whole app's lifetime.
  useEffect(() => {
    const bridge = (window as any).skiff;
    if (!bridge?.on) return;
    const offLock = bridge.on("app:lockVault", () => {
      void lock();
      navigate({ to: "/unlock" });
    });
    const offConnect = bridge.on("app:connectTo", ({ hostId }: { hostId: string }) => {
      navigate({ to: "/terminal/$hostId", params: { hostId } });
    });
    return () => { offLock?.(); offConnect?.(); };
  }, [navigate, lock]);


  // Global Ctrl/Cmd-K opens the command palette from anywhere in the app.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      {/*
        Only the routed view is inside the boundary. The palette and toaster
        stay mounted alongside it on purpose: when a screen does blow up,
        Ctrl/Cmd-K is still there to navigate somewhere else, and changing
        route clears the boundary via resetKey.
      */}
      <ErrorBoundary resetKey={pathname}>
        <Outlet />
      </ErrorBoundary>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <Toaster />
    </>
  );
}
