/**
 * Line-buffer tests.
 *
 * These exist because the naive version — string concatenation — shipped and
 * silently disabled every guardrail for anyone who made a typo. The first test
 * below is that exact keystroke sequence, taken from the log that caught it.
 * The buffer is only ever read by `checkCommand`, so "correct" here means the
 * shell and the buffer agree on the line.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { TerminalLineBuffer } from "./line-buffer.js";
import { checkCommand } from "./guardrails.js";

/** Feed a whole string one character at a time, as real typing arrives. */
function type(buf: TerminalLineBuffer, keys: string): string | null {
  let line: string | null = null;
  for (const ch of keys) {
    const r = buf.feed(ch);
    if (r.line !== null) line = r.line;
  }
  return line;
}

test("the regression: backspaces no longer poison the line", () => {
  const buf = new TerminalLineBuffer();
  // Verbatim from the diagnostic log: "DROP " ⌫ " DATAN" ⌫ "bas" ⌫⌫⌫ "BASE ..."
  const line = type(buf, "DROP \x7f DATAN\x7fbas\x7f\x7f\x7fBASE skiff_test;\r");
  assert.equal(line, "DROP DATABASE skiff_test;");
  assert.equal(checkCommand(line!)?.id, "drop-database");
});

test("a dangerous command typed cleanly still matches", () => {
  const buf = new TerminalLineBuffer();
  assert.equal(type(buf, "rm -rf /\r"), "rm -rf /");
});

test("backspace at the start of an empty line does nothing", () => {
  const buf = new TerminalLineBuffer();
  assert.equal(type(buf, "\x7f\x7f\x7fls\r"), "ls");
});

test("Ctrl+U and Ctrl+C abandon the line", () => {
  const buf = new TerminalLineBuffer();
  assert.equal(type(buf, "rm -rf /\x15ls\r"), "ls");
  assert.equal(type(buf, "rm -rf /\x03ls\r"), "ls");
});

test("Ctrl+W kills a word, Ctrl+K kills to end", () => {
  const buf = new TerminalLineBuffer();
  assert.equal(type(buf, "rm -rf /tmp\x17/var\r"), "rm -rf /var");
  assert.equal(type(buf, "echo one two\x01\x0bls\r"), "ls");
});

test("editing mid-line inserts at the cursor, not at the end", () => {
  const buf = new TerminalLineBuffer();
  // Type "rm -f /", go left past "/", insert "r" -> "rm -rf /"
  assert.equal(type(buf, "rm -f /\x1b[D\x1b[D\x1b[Dr\r"), "rm -rf /");
});

test("Home and End move the cursor", () => {
  const buf = new TerminalLineBuffer();
  assert.equal(type(buf, "rm -rf /\x01sudo \x05\r"), "sudo rm -rf /");
  assert.equal(type(buf, "b\x1b[Ha\x1b[Fc\r"), "abc");
});

test("forward delete removes the character under the cursor", () => {
  const buf = new TerminalLineBuffer();
  assert.equal(type(buf, "lsX\x1b[D\x1b[3~\r"), "ls");
});

test("arrow keys sent as ESC O also move the cursor", () => {
  const buf = new TerminalLineBuffer();
  assert.equal(type(buf, "rm -f /\x1bOD\x1bOD\x1bODr\r"), "rm -rf /");
});

test("an escape sequence split across chunks is not treated as text", () => {
  const buf = new TerminalLineBuffer();
  buf.feed("rm -f /");
  buf.feed("\x1b");
  buf.feed("[D");
  buf.feed("\x1b[");
  buf.feed("D");
  buf.feed("\x1b[D");
  assert.equal(buf.feed("r\r").line, "rm -rf /");
});

test("bracketed paste markers are not part of the command", () => {
  const buf = new TerminalLineBuffer();
  assert.equal(type(buf, "\x1b[200~rm -rf /\x1b[201~\r"), "rm -rf /");
});

test("history recall clears the line and reports the desync", () => {
  const buf = new TerminalLineBuffer();
  buf.feed("rm -rf /");
  const up = buf.feed("\x1b[A");
  assert.equal(up.desynced, true);
  assert.equal(buf.value, "");
  // Whatever the shell recalled is unknown here, so nothing is claimed about it.
  assert.equal(buf.feed("\r").line, "");
});

test("Tab keeps what was typed and flags the line as desynced", () => {
  const buf = new TerminalLineBuffer();
  const r = buf.feed("rm -rf /ho\t");
  assert.equal(r.desynced, true);
  assert.equal(buf.value, "rm -rf /ho");
});

test("enterIndex is an offset into the caller's chunk", () => {
  const buf = new TerminalLineBuffer();
  assert.equal(buf.feed("ls\r").enterIndex, 2);
  assert.equal(buf.feed("\r").enterIndex, 0);
});

test("enterIndex stays correct after a held partial escape", () => {
  const buf = new TerminalLineBuffer();
  buf.feed("ab\x1b"); // the lone ESC is held over
  const r = buf.feed("[Dc\r");
  assert.equal(r.line, "acb");
  // "[D" and "c" are 3 chars of this chunk; Enter is the fourth.
  assert.equal(r.enterIndex, 3);
});

test("submitting resets the buffer for the next command", () => {
  const buf = new TerminalLineBuffer();
  type(buf, "rm -rf /\r");
  assert.equal(buf.value, "");
  assert.equal(type(buf, "ls\r"), "ls");
});

test("a line that only ever held control bytes comes out empty", () => {
  const buf = new TerminalLineBuffer();
  assert.equal(type(buf, "\x00\x1c\x1f\r"), "");
});

test("a backspace removes a whole multi-byte character", () => {
  const buf = new TerminalLineBuffer();
  assert.equal(type(buf, "echo café\x7fé\r"), "echo café");
  assert.equal(type(buf, "echo naïve\x7f\x7fve\r"), "echo naïve");
});
