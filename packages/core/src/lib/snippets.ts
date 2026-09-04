/**
 * Snippets — saved commands, with variables.
 *
 * A snippet's body may contain `{{name}}` placeholders. Running one asks for
 * each value and substitutes it, so `sudo systemctl restart {{service}}` is one
 * saved command rather than one per service.
 *
 * ── Substitution is literal, and that is a decision ────────────────────────
 * Values are inserted exactly as typed. No quoting is added, no escaping is
 * applied. Two reasons, and they point the same way:
 *
 * Adding quotes would break the common case — someone typing `-n prod --tail 50`
 * into a variable wants three arguments, not one quoted string. And *partial*
 * escaping is the worst of both: it would look like protection while leaving
 * gaps, which invites people to paste untrusted values into a shell believing
 * something is guarding them.
 *
 * So the honest position is that a snippet is a command you are typing, with
 * blanks filled in. It carries exactly the risk of typing it. The guardrails
 * still run on the result, which is where the real check belongs.
 */

export interface Snippet {
  id: string;
  name: string;
  command: string;
  tags: string[];
  category: string | null;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
}

/** `{{name}}` — letters, digits, underscore, hyphen. */
const VARIABLE = /\{\{\s*([A-Za-z0-9_-]+)\s*\}\}/g;

/**
 * Variable names in a command, in first-appearance order and de-duplicated.
 *
 * Order matters: the prompt should follow the command left to right, because
 * that's how the person reading it thinks about the blanks.
 */
export function parseVariables(command: string): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const match of command.matchAll(VARIABLE)) {
    // The capture group is typed as possibly undefined even though this
    // pattern always has one. Skipping rather than asserting: a malformed
    // match should drop out quietly, not throw while someone is typing.
    const name = match[1];
    if (!name) continue;
    if (!seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

/**
 * Fill in the blanks.
 *
 * A variable with no supplied value is left as-is rather than replaced with an
 * empty string. `rm -rf {{path}}` becoming `rm -rf ` is a command that runs and
 * does something surprising; leaving the placeholder visible produces an error
 * the shell reports clearly.
 */
export function applyVariables(
  command: string,
  values: Record<string, string>,
): string {
  return command.replace(VARIABLE, (whole, name: string) => {
    const value = values[name];
    return value === undefined || value === "" ? whole : value;
  });
}

/** True when every placeholder has a value. */
export function isFullyResolved(
  command: string,
  values: Record<string, string>,
): boolean {
  return parseVariables(command).every(
    (name) => values[name] !== undefined && values[name] !== "",
  );
}

/**
 * Validate before saving. Returns a readable reason, or null.
 */
export function validateSnippet(input: {
  name?: string;
  command?: string;
}): string | null {
  const name = input.name?.trim();
  const command = input.command?.trim();

  if (!name) return "Give the snippet a name";
  if (name.length > 120) return "Name is too long";
  if (!command) return "The command can't be empty";
  if (command.length > 8000) return "That command is too long to save";

  // A lone `{{` is almost always a typo in a placeholder, and it would run as
  // literal text — better to catch it at save time than at 2am.
  const opens = (command.match(/\{\{/g) ?? []).length;
  const closes = (command.match(/\}\}/g) ?? []).length;
  if (opens !== closes) return "A {{variable}} is missing its closing braces";

  return null;
}
