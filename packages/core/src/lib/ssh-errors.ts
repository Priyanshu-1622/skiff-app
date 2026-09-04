/**
 * Turn an ssh2 / libuv connection failure into something a person can act on.
 *
 * Why this exists: "Timed out while waiting for handshake" is ssh2's own
 * wording, and it cost two days of debugging *with the source open* — the
 * actual cause was a database write throwing inside the host-key callback, so
 * ssh2 sat waiting for a decision that could never arrive. Someone installing
 * Skiff for the first time has no chance with a message like that, and a new
 * user's first connection is more likely to fail than succeed: wrong port, key
 * not authorised, password auth disabled server-side, host asleep.
 *
 * Each message says what happened and what to try next, in that order, and
 * never invents a cause it cannot support. Where the server gave a reason, the
 * server's own words are kept — they are more accurate than anything guessed
 * here.
 *
 * Deliberately transport-only. This does not know about Skiff's vault,
 * approvals or audit; it is given an error and returns a sentence.
 */

export interface FriendlyError {
  /** One sentence: what happened. */
  message: string;
  /** One sentence: what to try. Omitted when there is nothing honest to say. */
  hint?: string;
  /** The original message, so the real text is never lost. */
  original: string;
}

interface Ctx {
  hostname?: string;
  port?: number;
  username?: string;
  /** How this connection was authenticating, when known. */
  auth?: "password" | "key" | "agent";
  /** Set when the connection went through a bastion. */
  viaJump?: string;
}

/** ssh2 reports libuv codes on `err.code` for socket-level failures. */
function codeOf(err: unknown): string {
  const e = err as { code?: unknown; errno?: unknown };
  if (typeof e?.code === "string") return e.code;
  if (typeof e?.errno === "string") return e.errno;
  return "";
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return String((err as { message?: unknown })?.message ?? err ?? "Unknown error");
}

export function describeSshError(err: unknown, ctx: Ctx = {}): FriendlyError {
  const original = messageOf(err);
  const code = codeOf(err);
  const lower = original.toLowerCase();
  const where = ctx.hostname
    ? `${ctx.hostname}${ctx.port && ctx.port !== 22 ? `:${ctx.port}` : ""}`
    : "the host";

  // A bastion in the path changes what the user should check first, so say so
  // before anything else — otherwise they debug the wrong machine.
  const jumpNote = ctx.viaJump
    ? ` This connection goes through ${ctx.viaJump}, so the problem may be on either machine.`
    : "";

  // ── Socket-level: never reached SSH at all ───────────────────────────────

  if (code === "ECONNREFUSED" || lower.includes("econnrefused")) {
    return {
      message: `${where} refused the connection.`,
      hint:
        `Something answered, but nothing is listening on port ${ctx.port ?? 22}. ` +
        `Check the SSH service is running and that the port is right.` + jumpNote,
      original,
    };
  }

  if (code === "EHOSTUNREACH" || code === "ENETUNREACH" || lower.includes("unreach")) {
    return {
      message: `${where} could not be reached.`,
      hint: `Check the address, and that you are on a network that can see it — a VPN, for instance.` + jumpNote,
      original,
    };
  }

  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || lower.includes("getaddrinfo")) {
    return {
      message: `The name ${ctx.hostname ?? "given"} could not be resolved.`,
      hint: "Check the hostname for a typo, or use the IP address directly.",
      original,
    };
  }

  if (code === "ECONNRESET" || lower.includes("econnreset")) {
    return {
      message: `${where} closed the connection unexpectedly.`,
      hint:
        "This usually means the server rejected something early — often a firewall, " +
        "fail2ban, or an SSH config that does not allow this client." + jumpNote,
      original,
    };
  }

  if (code === "ETIMEDOUT" || lower.includes("etimedout")) {
    return {
      message: `${where} did not respond.`,
      hint:
        "Nothing answered at all. The machine may be off or asleep, or a firewall " +
        "may be dropping the connection silently rather than refusing it." + jumpNote,
      original,
    };
  }

  // ── Handshake timeout ────────────────────────────────────────────────────
  //
  // This one is genuinely ambiguous and must not pretend otherwise. It fires
  // both when the network dropped the connection and when something on our own
  // side never answered the host-key prompt — which is exactly the fault that
  // took two days. Both possibilities are stated.

  if (lower.includes("timed out while waiting for handshake")) {
    return {
      message: `${where} accepted the connection but the SSH handshake never finished.`,
      hint:
        "Either the network dropped it partway, or the fingerprint prompt was " +
        "never answered. If you were shown a fingerprint, try again and accept it " +
        "promptly; otherwise check the machine is awake and reachable." + jumpNote,
      original,
    };
  }

  // ── Authentication ───────────────────────────────────────────────────────

  if (lower.includes("all configured authentication methods failed")) {
    const base = `${ctx.username ? `${ctx.username}@` : ""}${where} rejected the credentials.`;
    if (ctx.auth === "password") {
      return {
        message: base,
        hint:
          "Check the password. If it is correct, the server may have password " +
          "authentication disabled — modern macOS does by default. A key or the " +
          "SSH agent would be needed instead.",
        original,
      };
    }
    if (ctx.auth === "key") {
      return {
        message: base,
        hint:
          "Check the key is the right one and that its public half is in the " +
          "account's authorized_keys on the server. An encrypted key also needs " +
          "its passphrase saved with it.",
        original,
      };
    }
    if (ctx.auth === "agent") {
      return {
        message: base,
        hint:
          "The agent is running but none of the keys it holds were accepted. " +
          "Run ssh-add -l to see what it is offering.",
        original,
      };
    }
    return {
      message: base,
      hint: "Check the username and the credentials for this host.",
      original,
    };
  }

  if (lower.includes("no matching key exchange") || lower.includes("no matching cipher") ||
      lower.includes("handshake failed") || lower.includes("no matching mac")) {
    return {
      message: `Could not agree on encryption with ${where}.`,
      hint:
        "The server offers only algorithms this client does not accept, which " +
        "usually means it is very old. It may need updating.",
      original,
    };
  }

  // ── Host keys ────────────────────────────────────────────────────────────

  if (lower.includes("host key") || lower.includes("hostkey")) {
    return {
      message: `The host key for ${where} did not match what Skiff has on record.`,
      hint:
        "This can mean the server was rebuilt or its key rotated — or that " +
        "something is intercepting the connection. Do not accept the new key " +
        "unless you know why it changed.",
      original,
    };
  }

  // ── Anything else ────────────────────────────────────────────────────────
  //
  // No guess. The server's own words, unaltered, are better than a wrong
  // explanation delivered confidently.

  return { message: original, original };
}

/** Convenience: the two sentences as one string, for places that take a single line. */
export function formatSshError(err: unknown, ctx: Ctx = {}): string {
  const d = describeSshError(err, ctx);
  return d.hint ? `${d.message} ${d.hint}` : d.message;
}
