import { useState, type ReactNode } from "react";
import { Sidebar, type SidebarProps } from "./Sidebar";
import { Toolbar, type ToolbarProps } from "./Toolbar";
import { StatusRail } from "./StatusRail";
import { TitleBar, isMacFrameless } from "./TitleBar";

/**
 * AppShell — the frame every authenticated screen inherits.
 *
 * Grid regions, top to bottom: an optional macOS title bar, then sidebar +
 * main side by side, then the status rail spanning the full width. On Windows
 * and Linux the title-bar row is absent entirely rather than empty, so the
 * content starts flush against the OS frame.
 */

export interface AppShellProps {
  children: ReactNode;
  sidebar?: Partial<SidebarProps>;
  toolbar?: ToolbarProps;
  /** Hide the toolbar row for screens that own their whole column (Terminal). */
  hideToolbar?: boolean;
  /** Live session count for the status rail. */
  sessions?: number;
  /** Centred macOS title, e.g. "skiff — production". */
  title?: string;
}

export function AppShell({
  children,
  sidebar = {},
  toolbar,
  hideToolbar,
  sessions,
  title,
}: AppShellProps) {
  const [collapsed, setCollapsed] = useState(false);
  const mac = isMacFrameless();

  const cls = [
    "app",
    mac ? "has-titlebar" : "",
    collapsed ? "is-collapsed" : "",
  ].filter(Boolean).join(" ");

  return (
    <div className={cls}>
      {mac && <TitleBar title={title} />}

      <Sidebar
        {...(sidebar as SidebarProps)}
        collapsed={collapsed}
        onToggleCollapse={() => setCollapsed((c) => !c)}
      />

      <main className="main">
        {!hideToolbar && <Toolbar {...(toolbar ?? {})} />}
        <div className="main__body">{children}</div>
      </main>

      <StatusRail sessions={sessions} />
    </div>
  );
}

export function BareShell({ children }: { children: ReactNode }) {
  return (
    <div className={`app--bare${isMacFrameless() ? " has-titlebar" : ""}`}>
      {isMacFrameless() && <TitleBar />}
      <div className="app--bare__body">{children}</div>
    </div>
  );
}
