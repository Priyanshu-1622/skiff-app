import { useState } from "react";
import { CommandPalette } from "@/components/CommandPalette";
import { StatusRail } from "@/components/shell";

/**
 * Dev-only screen previewer.
 *
 * Reachable at /preview. Renders each converted screen with mock data so they
 * can be inspected without a running server or real hosts — the exact gap that
 * made earlier screens impossible to verify. Not linked from the app UI; it's
 * a development aid.
 */

const SCREENS = ["Command Palette", "Status Rail"] as const;
type Screen = (typeof SCREENS)[number];

export function PreviewRoute() {
  const [screen, setScreen] = useState<Screen>("Command Palette");
  const [paletteOpen, setPaletteOpen] = useState(true);

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", background: "var(--bg-0)" }}>
      <div
        style={{
          display: "flex",
          gap: 8,
          padding: "10px 16px",
          borderBottom: "1px solid var(--border)",
          background: "var(--bg-1)",
          alignItems: "center",
        }}
      >
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-2)", marginRight: 8 }}>
          PREVIEW
        </span>
        {SCREENS.map((s) => (
          <button
            key={s}
            onClick={() => setScreen(s)}
            className={screen === s ? "btn btn--primary" : "btn btn--secondary"}
            style={{ fontSize: 12 }}
          >
            {s}
          </button>
        ))}
      </div>

      <div style={{ flex: 1, position: "relative", overflow: "auto" }}>
        {screen === "Command Palette" && (
          <>
            <div style={{ padding: 40, color: "var(--fg-2)", fontFamily: "var(--font-mono)", fontSize: 12 }}>
              Press Ctrl/Cmd-K to toggle. Click a row to see selection.
            </div>
            <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
            {!paletteOpen && (
              <button className="btn btn--primary" style={{ margin: 40 }} onClick={() => setPaletteOpen(true)}>
                Reopen palette
              </button>
            )}
          </>
        )}

        {screen === "Status Rail" && (
          <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column" }}>
            <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--fg-2)" }}>
              The rail sits at the bottom ↓
            </div>
            <StatusRail sessions={3} />
          </div>
        )}
      </div>
    </div>
  );
}
