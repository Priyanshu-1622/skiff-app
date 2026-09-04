/**
 * A model of the line the shell is currently editing.
 *
 * Guardrails need to know what command is about to be submitted, and the only
 * thing available on this side is the byte stream the user is typing.
 * Accumulating those bytes is not the same as knowing the line: the shell runs
 * a line editor, and a backspace, a Ctrl+U or a left-arrow changes the line
 * without removing anything from a naive buffer.
 *
 * That difference was not theoretical. The buffer used to be plain string
 * concatenation, so `DROP DATABASE skiff_test;` typed with six corrections
 * arrived as a 35-character string with the DEL bytes still in it:
 *
 *     D R O P _ x7f _ D A T A N x7f b a s x7f x7f x7f B A S E _ s k i f f ...
 *
 * `/^\s*drop\s+(database|schema)\b/i` does not match that, so the statement ran
 * unchallenged. Every rule in `guardrails.ts` was defeated by a single
 * backspace — which is also why the failure looked intermittent rather than
 * total: type a dangerous command cleanly and the dialog appears, make one
 * typo and it silently does not.
 *
 * ── What this deliberately does not do ─────────────────────────────────────
 * It models the line editor, not the shell. Tab completion and history recall
 * rewrite the line from data this side never sees, so they cannot be tracked
 * faithfully:
 *
 *   - Tab marks the line desynced but keeps what has been typed, because that
 *     text is still a prefix of the real line and the rules are prefix-shaped.
 *   - Up/Down replace the line wholesale, so the buffer is cleared. A command
 *     recalled from history and submitted is therefore NOT checked. That is a
 *     real gap, stated here rather than papered over: guardrails are a speed
 *     bump for tired people, not a control anything should depend on.
 *
 * Nothing here is stored or logged. The same keystrokes carry whatever gets
 * typed at a sudo prompt, so the text exists only until Enter.
 */

export interface LineFeedResult {
  /** The completed line, if this chunk contained Enter. Otherwise null. */
  line: string | null;
  /** Offset of the Enter character within the chunk, or -1 if there was none. */
  enterIndex: number;
  /** True once something happened that this cannot model faithfully. */
  desynced: boolean;
}

const DEL = "\x7f";
const BS = "\b";
const ESC = "\x1b";

/** Longest partial sequence worth holding for the next chunk. */
const MAX_ESCAPE = 8;

/**
 * Ceiling on the modelled line, so a pasted file cannot grow this without
 * bound. Well past anything `checkCommand` will look at — it gives up above
 * 4096 characters — so this only ever bounds memory, never matching.
 */
const MAX_LINE = 8192;

export class TerminalLineBuffer {
  private text = "";
  private cursor = 0;
  private desynced = false;
  /** An escape sequence split across two chunks. */
  private partial = "";

  reset(): void {
    this.text = "";
    this.cursor = 0;
    this.desynced = false;
    this.partial = "";
  }

  /** The line as it currently stands. */
  get value(): string {
    return this.text;
  }

  /**
   * Feed one chunk of user input.
   *
   * Processing stops at the first Enter, matching the caller's contract: it
   * holds that newline back while a confirmation dialog is up and re-sends it
   * later. Anything after the Enter in the same chunk is the caller's to deal
   * with, which is why `enterIndex` is returned rather than swallowed.
   */
  feed(chunk: string): LineFeedResult {
    const buf = this.partial + chunk;
    // Offsets are reported against the caller's chunk, not our joined buffer.
    const offset = this.partial.length;
    this.partial = "";

    let i = 0;
    while (i < buf.length) {
      const ch = buf[i]!;

      if (ch === "\r" || ch === "\n") {
        const line = this.text;
        const wasDesynced = this.desynced;
        this.text = "";
        this.cursor = 0;
        this.desynced = false;
        return { line, enterIndex: i - offset, desynced: wasDesynced };
      }

      if (ch === ESC) {
        const consumed = this.applyEscape(buf.slice(i));
        if (consumed === 0) {
          // Incomplete. Hold it for the next chunk, unless it is too long to
          // be a sequence we would recognise anyway.
          const rest = buf.slice(i);
          if (rest.length < MAX_ESCAPE) this.partial = rest;
          break;
        }
        i += consumed;
        continue;
      }

      i += this.applyChar(ch);
    }

    return { line: null, enterIndex: -1, desynced: this.desynced };
  }

  /** Apply one non-escape character. Returns how many were consumed. */
  private applyChar(ch: string): number {
    switch (ch) {
      case DEL:
      case BS:
        if (this.cursor > 0) {
          this.text = this.text.slice(0, this.cursor - 1) + this.text.slice(this.cursor);
          this.cursor--;
        }
        return 1;

      case "\x15": // Ctrl+U — kill line (whole line in zsh, to-start in bash)
      case "\x03": // Ctrl+C — abandon the line
        this.text = "";
        this.cursor = 0;
        return 1;

      case "\x17": { // Ctrl+W — kill the word before the cursor
        const head = this.text.slice(0, this.cursor);
        const kept = head.replace(/\S*\s*$/, "");
        this.text = kept + this.text.slice(this.cursor);
        this.cursor = kept.length;
        return 1;
      }

      case "\x0b": // Ctrl+K — kill to end of line
        this.text = this.text.slice(0, this.cursor);
        return 1;

      case "\x01": // Ctrl+A
        this.cursor = 0;
        return 1;

      case "\x05": // Ctrl+E
        this.cursor = this.text.length;
        return 1;

      case "\x02": // Ctrl+B
        if (this.cursor > 0) this.cursor--;
        return 1;

      case "\x06": // Ctrl+F
        if (this.cursor < this.text.length) this.cursor++;
        return 1;

      case "\x04": // Ctrl+D — delete forward when there is a line to edit
        if (this.cursor < this.text.length) {
          this.text = this.text.slice(0, this.cursor) + this.text.slice(this.cursor + 1);
        }
        return 1;

      case "\t":
        // Completion rewrites the line from the server's filesystem. What has
        // been typed is still a prefix of the result, so it is kept.
        this.desynced = true;
        return 1;

      default:
        break;
    }

    const code = ch.codePointAt(0)!;
    if (code < 0x20) return 1; // any other control byte is not line editing

    const text = String.fromCodePoint(code); // a surrogate pair is one character
    if (this.text.length >= MAX_LINE) return text.length; // bounded; see MAX_LINE
    this.text = this.text.slice(0, this.cursor) + text + this.text.slice(this.cursor);
    this.cursor += text.length;
    return text.length;
  }

  /**
   * Apply an escape sequence at the start of `s`.
   *
   * Returns how many characters were consumed, or 0 when `s` holds only part
   * of a sequence and the rest has not arrived yet.
   */
  private applyEscape(s: string): number {
    if (s.length < 2) return 0;

    // CSI — ESC [ params final
    if (s[1] === "[") {
      let j = 2;
      while (j < s.length && /[0-9;?]/.test(s[j]!)) j++;
      if (j >= s.length) return 0;
      const params = s.slice(2, j);
      const consumed = j + 1;

      switch (s[j]!) {
        case "C":
          if (this.cursor < this.text.length) this.cursor++;
          return consumed;
        case "D":
          if (this.cursor > 0) this.cursor--;
          return consumed;
        case "A":
        case "B":
          // History recall replaces the line with text never sent here.
          this.text = "";
          this.cursor = 0;
          this.desynced = true;
          return consumed;
        case "H":
          this.cursor = 0;
          return consumed;
        case "F":
          this.cursor = this.text.length;
          return consumed;
        case "~":
          if (params === "1" || params === "7") this.cursor = 0;
          else if (params === "4" || params === "8") this.cursor = this.text.length;
          else if (params === "3" && this.cursor < this.text.length) {
            this.text = this.text.slice(0, this.cursor) + this.text.slice(this.cursor + 1);
          }
          // 200 and 201 are the bracketed-paste markers. Nothing to do: the
          // pasted text arrives as ordinary characters between them.
          return consumed;
        default:
          return consumed; // a sequence with no bearing on the line
      }
    }

    // ESC O x — application cursor keys send these instead of CSI.
    if (s[1] === "O") {
      if (s.length < 3) return 0;
      const final = s[2]!;
      if (final === "C") {
        if (this.cursor < this.text.length) this.cursor++;
      } else if (final === "D") {
        if (this.cursor > 0) this.cursor--;
      } else if (final === "A" || final === "B") {
        this.text = "";
        this.cursor = 0;
        this.desynced = true;
      } else if (final === "H") {
        this.cursor = 0;
      } else if (final === "F") {
        this.cursor = this.text.length;
      }
      return 3;
    }

    // Meta chords: ESC b / ESC f move by word, ESC DEL kills the word behind.
    const meta = s[1]!;
    if (meta === "b") {
      this.cursor = this.text.slice(0, this.cursor).replace(/\S*\s*$/, "").length;
      return 2;
    }
    if (meta === "f") {
      const skipped = this.text.slice(this.cursor).match(/^\s*\S*/)?.[0].length ?? 0;
      this.cursor += skipped;
      return 2;
    }
    if (meta === DEL || meta === BS) {
      const head = this.text.slice(0, this.cursor);
      const kept = head.replace(/\S*\s*$/, "");
      this.text = kept + this.text.slice(this.cursor);
      this.cursor = kept.length;
      return 2;
    }
    return 2; // some other meta chord; not line editing
  }
}
