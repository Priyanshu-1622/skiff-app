/**
 * Route-level error boundary.
 *
 * React unmounts the entire tree when a render throws and nothing catches it —
 * which is how a single malformed host row turned into a white screen with no
 * way out. This boundary bounds that blast radius to the routed view: the
 * window still paints, the error is readable, and there is always a way back.
 *
 * A class component because that is still the only way to implement
 * componentDidCatch; there is no hook equivalent.
 */

import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /**
   * Change this to clear a caught error. The root passes the current pathname,
   * so navigating away from a broken screen recovers automatically instead of
   * leaving the error stuck over every subsequent route.
   */
  resetKey?: string;
}

interface State {
  error: Error | null;
  info: ErrorInfo | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Deliberately console-only. Skiff holds decrypted credentials in memory
    // and a component stack can carry props with it, so this must never be
    // shipped anywhere off the device.
    console.error("[skiff] render error:", error, info.componentStack);
    this.setState({ info });
  }

  override componentDidUpdate(prev: Props): void {
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.reset();
    }
  }

  reset = (): void => {
    this.setState({ error: null, info: null });
  };

  override render(): ReactNode {
    const { error, info } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        role="alert"
        style={{
          display: "grid",
          placeItems: "center",
          minHeight: "100vh",
          padding: 24,
          background: "var(--bg-0)",
          color: "var(--fg-1)",
        }}
      >
        <div style={{ maxWidth: 620, width: "100%", textAlign: "center" }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>⚠</div>
          <div style={{ fontSize: 15, fontWeight: 600, color: "var(--fg-0)" }}>
            This screen hit an error
          </div>
          <div style={{ fontSize: 13, color: "var(--fg-2)", marginTop: 6, lineHeight: 1.5 }}>
            Your vault is untouched and still unlocked. You can retry this view
            or go back to your hosts.
          </div>

          <div
            style={{
              display: "flex",
              gap: 8,
              justifyContent: "center",
              marginTop: 18,
              flexWrap: "wrap",
            }}
          >
            <button type="button" className="btn btn--primary" onClick={this.reset}>
              Try again
            </button>
            <button
              type="button"
              className="btn btn--secondary"
              onClick={() => {
                // Hard load, not client routing: it discards any in-memory
                // state that caused the throw in the first place.
                window.location.href = "/";
              }}
            >
              Back to hosts
            </button>
            <button
              type="button"
              className="btn btn--secondary"
              onClick={() => window.location.reload()}
            >
              Reload app
            </button>
          </div>

          <details style={{ marginTop: 20, textAlign: "left" }}>
            <summary
              style={{
                cursor: "pointer",
                fontSize: 12,
                color: "var(--fg-2)",
                userSelect: "none",
              }}
            >
              Technical details
            </summary>
            <pre
              style={{
                marginTop: 8,
                padding: 12,
                maxHeight: 260,
                overflow: "auto",
                background: "var(--bg-2)",
                border: "1px solid var(--border-strong)",
                borderRadius: 6,
                font: "400 12px/1.5 var(--font-mono)",
                color: "var(--fg-1)",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {String(error.stack ?? error.message)}
              {info?.componentStack ?? ""}
            </pre>
          </details>
        </div>
      </div>
    );
  }
}
