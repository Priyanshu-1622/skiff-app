/**
 * Ambient declarations for things imported for their side effects or without
 * shipped types. Kept minimal on purpose — this file should not become a
 * dumping ground for `any`.
 */

/** CSS imported for its side effect (the bundled asciinema player styles). */
declare module "*.css";

/**
 * asciinema-player's published types don't cover the bundle entry we use, so
 * the surface we actually call is declared here rather than casting at the
 * call site.
 */
declare module "asciinema-player" {
  export interface PlayerOptions {
    fit?: string | boolean;
    terminalFontSize?: string;
    theme?: string;
    autoPlay?: boolean;
    speed?: number;
    idleTimeLimit?: number;
  }

  export interface Player {
    dispose(): void;
    play(): void;
    pause(): void;
  }

  export function create(
    src: string,
    container: HTMLElement,
    options?: PlayerOptions,
  ): Player;
}
