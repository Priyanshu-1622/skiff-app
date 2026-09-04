import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { router } from "@/router";
import { useTheme } from "@/lib/theme";

// Fonts, bundled. Weights are pinned to the ones the design system actually
// uses — shipping the full families would add megabytes for faces nobody sets.
// Inter Tight carries every human label; JetBrains Mono every machine value.
import "@fontsource/inter-tight/400.css";
import "@fontsource/inter-tight/500.css";
import "@fontsource/inter-tight/600.css";
import "@fontsource/inter-tight/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/600.css";

// CSS — order matters: tokens → globals → shell → screen-level styles
import "@/styles/tokens.css";
import "@/styles/globals.css";
import "@/styles/shell.css";
import "@/styles/unlock.css";
import "@/styles/firstrun.css";
import "@/styles/hostlist.css";
import "@/styles/dashboard.css";
import "@/styles/cmdk.css";
import "@/styles/addhost.css";
import "@xterm/xterm/css/xterm.css";
import "@/styles/terminal.css";
import "@/styles/settings.css";
import "@/styles/team.css";
import "@/styles/import.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

useTheme.getState().setTheme(useTheme.getState().theme);

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Missing #root element in index.html");

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
