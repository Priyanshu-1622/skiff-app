/**
 * OpenSSH client config parsing.
 *
 * Lives in core rather than in the HTTP routes because both hosts need it:
 * the server exposes it as `/api/import/parse`, and the desktop app reads
 * `~/.ssh/config` directly on first run. Keeping one parser means an import
 * behaves identically in both, and a fix to the parsing rules lands in both
 * at once.
 */

export interface ParsedHost {
  alias: string;
  hostname: string | null;
  port: number | null;
  user: string | null;
  identityFile: string | null;
}

/**
 * Parse the subset of ssh_config directives Skiff can represent as a host
 * entry: Host, HostName, Port, User, IdentityFile.
 *
 * Wildcard blocks (`Host *`, `Host web-?`) are deliberately skipped. Their
 * directives apply to many hosts at once, which has no single-row equivalent —
 * importing them would silently invent hosts the user never configured.
 */
export function parseSSHConfig(text: string): ParsedHost[] {
  const hosts: ParsedHost[] = [];
  let current: ParsedHost | null = null;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    // Directives are `keyword value`, separated by whitespace. `=` is also
    // legal in ssh_config but rare in practice; normalize it to a space.
    const normalized = line.replace(/^(\S+)\s*=\s*/, "$1 ");
    const match = normalized.match(/^(\S+)\s+(.+)$/);
    if (!match) continue;

    const [, keyword, value] = match;
    const kw = keyword!.toLowerCase();

    if (kw === "host") {
      // Commit the previous host before starting (or skipping) the next.
      if (current) hosts.push(current);
      current = null;
      if (value!.includes("*") || value!.includes("?")) continue;
      current = {
        alias: value!.trim(),
        hostname: null,
        port: null,
        user: null,
        identityFile: null,
      };
    } else if (current) {
      switch (kw) {
        case "hostname":
          current.hostname = value!.trim();
          break;
        case "port":
          current.port = parseInt(value!.trim(), 10) || null;
          break;
        case "user":
          current.user = value!.trim();
          break;
        case "identityfile":
          current.identityFile = value!.trim();
          break;
      }
    }
  }

  if (current) hosts.push(current);
  return hosts;
}
