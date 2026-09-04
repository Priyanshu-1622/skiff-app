/**
 * Dangerous-command guardrails.
 *
 * Pauses a command that is about to do something irreversible and asks the
 * person to confirm. It is a speed bump for tired people at 2am, not a
 * security control — anyone who wants to run `rm -rf /` can confirm the
 * dialog, and should be able to. Treating it as a security boundary would be a
 * mistake: it runs in the client, and a determined user is on the other side
 * of it by definition.
 *
 * ── Why the rule list is short ─────────────────────────────────────────────
 * Every false positive teaches people to click through without reading, and a
 * prompt that is always dismissed protects nobody. So this matches a small set
 * of commands that are catastrophic and rarely typed by accident, and stays
 * quiet about everything else. Adding "any command containing rm" would double
 * the hits and halve the attention paid to them.
 *
 * ── What it never does ─────────────────────────────────────────────────────
 * The buffered line is used for matching and then discarded. It is never
 * stored, never logged, and never sent anywhere — because the same buffer that
 * sees `rm -rf` also sees whatever someone types at a `sudo` password prompt.
 */

export type Severity = "critical" | "warning";

export interface GuardrailRule {
  id: string;
  severity: Severity;
  /** Shown as the heading — what this command does. */
  title: string;
  /** Shown as the body — why it's worth a second look. */
  detail: string;
  test: RegExp;
}

/**
 * Order matters only for reporting: the first match wins, so the most specific
 * and most severe rules come first.
 */
export const RULES: GuardrailRule[] = [
  {
    id: "rm-rf-root",
    severity: "critical",
    title: "Recursive delete from the filesystem root",
    detail:
      "This removes everything it can reach, starting at /. There is no undo and no confirmation from the shell.",
    // rm -rf / or rm -rf /* — but not rm -rf /some/path
    test: /\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rR][a-zA-Z]*[fF]?[a-zA-Z]*\s+\/(\s|\*|$)/,
  },
  {
    id: "rm-rf-home",
    severity: "critical",
    title: "Recursive delete of a home directory",
    detail: "This removes the user's entire home directory and everything in it.",
    test: /\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rR]\S*\s+(~|\$HOME|\/home\/\w+)(\s|\/?\*|$)/,
  },
  {
    id: "mkfs",
    severity: "critical",
    title: "Formatting a filesystem",
    detail:
      "This creates a new filesystem on the target device, destroying whatever is currently on it.",
    test: /\bmkfs(\.\w+)?\s+\/dev\//,
  },
  {
    id: "dd-to-device",
    severity: "critical",
    title: "Writing directly to a block device",
    detail:
      "dd writes raw blocks. Pointed at the wrong device this overwrites a disk with no warning and no recovery.",
    test: /\bdd\s+[^\n|;]*\bof=\/dev\/(sd|nvme|hd|vd|xvd|mmcblk|disk)/,
  },
  {
    id: "fork-bomb",
    severity: "critical",
    title: "Fork bomb",
    detail:
      "This spawns processes until the machine stops responding. It usually requires a hard reboot.",
    test: /:\s*\(\s*\)\s*\{\s*:?\s*\|\s*:?\s*&?\s*\}\s*;?\s*:/,
  },
  {
    id: "curl-pipe-shell",
    severity: "warning",
    title: "Running a script straight off the internet",
    detail:
      "The downloaded script runs immediately with your privileges, and nobody reads it first. If the URL or the server is wrong, so is everything that happens next.",
    test: /\b(curl|wget)\b[^\n|;]*\|\s*(sudo\s+)?(ba|z|k|s)?sh\b/,
  },
  {
    id: "chmod-777-root",
    severity: "warning",
    title: "Making system paths world-writable",
    detail:
      "Recursive 777 on a system path lets any user on the machine modify those files, including scripts that run as root.",
    test: /\bchmod\s+(-[a-zA-Z]*\s+)*(-R|--recursive)\s+(0?777)\s+\/(etc|usr|var|bin|sbin|lib|opt)?(\s|$|\/)/,
  },
  {
    id: "chown-recursive-root",
    severity: "warning",
    title: "Recursive ownership change on a system path",
    detail:
      "Changing ownership across a system directory commonly breaks sudo, ssh, or the package manager, and is hard to reverse.",
    test: /\bchown\s+(-[a-zA-Z]*\s+)*(-R|--recursive)\s+\S+\s+\/(etc|usr|var|bin|sbin|lib)(\s|$|\/)/,
  },
  {
    id: "drop-database",
    severity: "warning",
    title: "Dropping a database",
    detail: "This deletes the database and everything in it.",
    // Anchored to the start of a segment: a SQL statement typed at a psql
    // prompt begins the line, whereas `grep "drop database" ./docs` only
    // mentions the words. Matching the mention would flag people for reading
    // documentation, which is precisely the false positive that trains users
    // to dismiss these prompts unread.
    test: /^\s*drop\s+(database|schema)\b/i,
  },
  {
    id: "git-force-push",
    severity: "warning",
    title: "Force-pushing over a shared branch",
    detail:
      "This overwrites the remote branch. Anyone else's commits that aren't in your history are discarded.",
    test: /\bgit\s+push\b[^\n;]*\s(--force|-f)(\s|$)(?![^\n;]*--force-with-lease)/,
  },
  {
    id: "shutdown",
    severity: "warning",
    title: "Powering off or rebooting the host",
    detail: "The machine goes down immediately. If it's remote, you may not get it back.",
    test: /^\s*(sudo\s+)?(shutdown|poweroff|halt|reboot|init\s+0|init\s+6)\b/,
  },
];

export interface GuardrailHit {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  /** The command as typed, for display in the prompt. */
  command: string;
}

/**
 * Check a command line.
 *
 * Comments are stripped and the line is split on `;`, `&&` and `||` so that a
 * dangerous command hidden behind a harmless one is still caught — chaining is
 * how these usually arrive in a paste.
 */
export function checkCommand(line: string): GuardrailHit | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > 4096) return null;

  // Strip a trailing comment, but not a `#` inside quotes.
  const withoutComment = trimmed.replace(/(^|[^"'\\])#.*$/, "$1").trim();
  if (!withoutComment) return null;

  const segments = withoutComment
    .split(/;|&&|\|\|/)
    .map((s) => s.trim())
    .filter(Boolean);

  // The whole line is checked too: pipelines like `curl … | sh` don't survive
  // being split, and that's one of the rules that matters most.
  for (const candidate of [withoutComment, ...segments]) {
    for (const rule of RULES) {
      if (rule.test.test(candidate)) {
        return {
          id: rule.id,
          severity: rule.severity,
          title: rule.title,
          detail: rule.detail,
          command: trimmed,
        };
      }
    }
  }

  return null;
}
