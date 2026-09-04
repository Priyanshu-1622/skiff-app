/**
 * macOS title bar.
 *
 * The Electron window uses `titleBarStyle: "hiddenInset"` on darwin, which
 * hides the frame but keeps the traffic lights floating over the top-left of
 * the content. This strip gives them something to sit on and provides the
 * drag region the hidden frame no longer supplies.
 *
 * On Windows and Linux the OS frame is kept (users there expect their own
 * window controls, and hand-rolled ones always read as slightly wrong), so
 * this component renders nothing and the grid drops the row entirely.
 */

export function isMacFrameless(): boolean {
  if (typeof window === "undefined") return false;
  const bridge = (window as any).skiff;
  return !!bridge && bridge.platform === "darwin";
}

export interface TitleBarProps {
  /** Centred label, e.g. "skiff — production". Machine values stay monospace. */
  title?: string;
}

export function TitleBar({ title = "skiff" }: TitleBarProps) {
  return (
    <div className="titlebar">
      <span className="titlebar__title">{title}</span>
    </div>
  );
}
