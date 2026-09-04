/**
 * Terminal sessions over IPC.
 *
 * The server build opened one WebSocket per terminal, so routing was implicit:
 * whatever arrived on that socket belonged to that terminal. The desktop has a
 * single IPC bridge shared by every tab and split pane, so each event carries
 * an explicit `sessionId` and the renderer demultiplexes.
 *
 * The persistent-session behaviour is unchanged and is the reason this is
 * worth doing carefully: closing a tab DETACHES from the managed session
 * rather than ending it, so reopening the same host replays scrollback and
 * lands you back in the same shell. That logic lives in @skiff/core's
 * SessionManager and is untouched here — this file only swaps the transport.
 */

import net from "node:net";
import { Client as SSH2Client } from "ssh2";
import { z } from "zod";
import {
  SessionRecorder,
  connectTcp,
  createHostKeyFingerprint,
  readHostKeyAlgorithm,
  decrypt,
  generateId,
  writeAudit,
  requiresApproval,
  checkCommand,
  TerminalLineBuffer,
  activeGrant,
  formatSshError,
} from "@skiff/core";
import { ApiErrorCode } from "@skiff/shared";
import type { EngineContext } from "../engine.js";
import { fail, type Handlers } from "./contract.js";
import { requireVaultKey, currentUser, getSessionId } from "./auth.js";
import { tunnelManager } from "./tunnels.js";
import type { TerminalEvent } from "../../shared/ipc.js";

const OpenBody = z.object({
  hostId: z.string().min(1),
  cols: z.number().int().min(1).max(1000).default(80),
  rows: z.number().int().min(1).max(1000).default(24),
});
const WriteBody = z.object({ sessionId: z.string(), data: z.string() });
const ResolveGuardrailBody = z.object({
  sessionId: z.string(),
  proceed: z.boolean(),
  ruleId: z.string().optional(),
});
const ResizeBody = z.object({
  sessionId: z.string(),
  cols: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(1000),
});
const CloseBody = z.object({ sessionId: z.string() });
const FingerprintBody = z.object({
  sessionId: z.string(),
  accept: z.boolean(),
});

/**
 * Maps a renderer-facing sessionId (one per tab) to the SessionManager's
 * managed-session id (one per host). Several tabs on the same host share a
 * managed session, exactly as several browser tabs did before.
 */
interface TabBinding {
  managedId: string;
  hostId: string;
  client: { send: (chunk: Buffer) => void; end: (reason: string) => void };
}

/**
 * How terminal events reach the renderer. Structural rather than a
 * BrowserWindow type so this module stays Electron-free and testable; the
 * main process passes a function that calls webContents.send.
 */
export type EventSink = (event: TerminalEvent) => void;

/** Windows OpenSSH agent endpoint. ssh2 also accepts "pageant" for PuTTY. */
export const WINDOWS_AGENT_PIPE = "\\\\.\\pipe\\openssh-ssh-agent";

/**
 * Connect to a Windows named pipe just to find out whether anything is
 * listening, then drop the connection immediately.
 *
 * `fs.existsSync` / `fs.statSync` cannot be used for this — verified against a
 * real, running agent while chasing this bug: they do not throw `ENOENT` for a
 * live pipe, they throw `EBUSY` ('resource busy or locked'), because a Windows
 * named pipe with a server actively listening is not stat-able the way a
 * regular file is. `existsSync` swallows every error and returns `false`, so
 * it reported no agent while a real one was connected, key loaded, ready to
 * use. `net.connect` uses the actual named-pipe connect machinery and
 * distinguishes the two correctly.
 */
function probeWindowsPipe(pipePath: string, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      sock.removeAllListeners();
      try { sock.destroy(); } catch { /* already gone */ }
      resolve(ok);
    };
    const sock = net.connect(pipePath);
    sock.once("connect", () => finish(true));
    sock.once("error", () => finish(false));
    sock.setTimeout(timeoutMs, () => finish(false));
  });
}

/**
 * Where the SSH agent is listening, or null if there is none.
 *
 * On Windows this used to be written inline as
 * `process.env.SSH_AUTH_SOCK || WINDOWS_AGENT_PIPE`, which is *always*
 * truthy — so the `if (!sock)` guard beneath it could never fire there, and
 * the friendly "no agent is running" error was unreachable on the platform
 * most likely to need it. A later fix replaced the assumption with an
 * `existsSync` probe — which turned out to have the opposite problem, see
 * `probeWindowsPipe` above: it reported no agent on a machine where one was
 * genuinely running, the first time this was tested against a real Windows
 * agent rather than a mock.
 */
export async function resolveAgentSocket(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  probe: (pipePath: string) => Promise<boolean> = probeWindowsPipe,
): Promise<string | null> {
  if (env.SSH_AUTH_SOCK) return env.SSH_AUTH_SOCK;
  if (platform !== "win32") return null;
  // async, not .then()/.catch() on the call: a probe that throws
  // *synchronously*, rather than returning a rejected promise, would
  // otherwise escape this function as an uncaught exception instead of
  // resolving to null — the function itself was not async, so nothing here
  // wrapped the call to `probe(...)` in a try. A caller's custom probe
  // (tests included) throwing synchronously is exactly as valid a failure
  // mode as a rejection.
  try {
    return (await probe(WINDOWS_AGENT_PIPE)) ? WINDOWS_AGENT_PIPE : null;
  } catch {
    return null;
  }
}
export function registerTerminalHandlers(
  engine: EngineContext,
  sendEvent: EventSink,
): Handlers {
  const db = engine.db.raw;
  const tabs = new Map<string, TabBinding>();

  /**
   * The in-flight input line, and any command held pending confirmation.
   *
   * Keyed by managed session — deliberately not by tab. These lived on the
   * TabBinding, which is built fresh on every open, so the buffer started
   * empty every time the renderer got a new sessionId: a reattach, a remount,
   * navigating to Files and back. The shell on the other end keeps whatever
   * was half-typed at its prompt, so the guardrail was left reading only the
   * tail of the line. Type `DROP DATABASE`, leave the tab and come back, type
   * ` skiff_test;`, press Enter — the buffer held ` skiff_test;`, which no
   * rule anchored to the start of a command can match, and the statement ran
   * unchallenged. Nothing errored and nothing logged; the dialog simply never
   * appeared, which is why this read as intermittent rather than broken.
   *
   * Two tabs on one host had the same fault from the other side: they share a
   * single shell but had a buffer each. The shell's line is per managed
   * session, so the only correct key is the managed session.
   */
  interface LineState {
    /** Models the shell's line editor — see TerminalLineBuffer. */
    buffer: TerminalLineBuffer;
    /** A command held pending the user's confirmation, if any. */
    pending: string | null;
  }
  const lineBuffers = new Map<string, LineState>();
  const lineState = (managedId: string): LineState => {
    let state = lineBuffers.get(managedId);
    if (!state) {
      state = { buffer: new TerminalLineBuffer(), pending: null };
      lineBuffers.set(managedId, state);
    }
    return state;
  };

  /** Off unless switched on — see the settings row for the reasoning. */
  const guardrailsOn = (): boolean => {
    try {
      const row = db.prepare("SELECT guardrails_enabled FROM vault_meta WHERE id = 1").get() as
        | { guardrails_enabled?: number }
        | undefined;
      return !!row?.guardrails_enabled;
    } catch {
      return false;
    }
  };

  /**
   * Build an ssh2 config for a host — used for jump hosts.
   *
   * The bastion's host key is verified against known_hosts exactly like any
   * other, but an *unknown* key is refused rather than prompted. A
   * trust-on-first-use dialog appearing in the middle of a two-hop connection
   * is a bad place to ask someone to make a security decision: they're
   * expecting a terminal, the prompt is about a machine they didn't choose to
   * connect to, and the natural response is to click through it.
   *
   * Connecting to the bastion directly once — where the normal fingerprint
   * prompt appears with proper context — pins it, and jumps then work.
   */
  const buildConnectConfig = async (h: any): Promise<any> => {
    const config: any = {
      host: h.hostname,
      port: h.port,
      username: h.username,
      readyTimeout: 10_000,
      keepaliveInterval: 30_000,
    };

    if (h.auth_method === "agent") {
      const sock = await resolveAgentSocket();
      if (!sock) {
        fail(
          ApiErrorCode.VALIDATION_FAILED,
          `${h.label || h.hostname} uses the SSH agent, but no agent is running.`,
        );
      }
      config.agent = sock;
    } else if (h.credential_id) {
      const cred = db
        .prepare("SELECT * FROM credentials WHERE id = ?")
        .get(h.credential_id) as any;
      if (cred) {
        const plaintext = decrypt(
          Buffer.from(cred.encrypted_blob),
          Buffer.from(cred.nonce),
          requireVaultKey(engine),
        );
        if (cred.kind === "password") {
          config.password = plaintext;
        } else {
          let parsed: { value: string; passphrase?: string };
          try { parsed = JSON.parse(plaintext); } catch { parsed = { value: plaintext }; }
          config.privateKey = parsed.value;
          if (parsed.passphrase) config.passphrase = parsed.passphrase;
        }
      }
    }

    const known = db
      .prepare("SELECT * FROM known_hosts WHERE hostname = ? AND port = ?")
      .get(h.hostname, h.port) as any;

    config.hostVerifier = (key: Buffer): boolean => {
      const fp = createHostKeyFingerprint(key);
      if (!known) return false;
      return known.fingerprint === fp;
    };

    return config;
  };

  /**
   * Connects that have started but not yet registered a session.
   *
   * The reattach check asks the session manager whether this host is already
   * open, but a session is only registered once the shell callback fires —
   * seconds later, after the TCP connect, the handshake, and auth. Two opens
   * for the same host inside that window therefore both saw "nothing here"
   * and both dialled out: two SSH connections, two recorders, and one of them
   * orphaned the moment the second registered over it. React StrictMode mounts
   * every effect twice in dev, so this was not a rare race — it happened on
   * every first connect.
   */
  const connecting = new Map<string, Promise<void>>();

  /** Pending host-key confirmations, keyed by tab sessionId. */
  const fingerprintWaiters = new Map<string, (accept: boolean) => void>();

  function emit(event: TerminalEvent): void {
    sendEvent(event);
  }

  function makeClient(sessionId: string) {
    return {
      send: (chunk: Buffer) =>
        emit({ sessionId, type: "data", data: chunk.toString("base64") }),
      end: (reason: string) => {
        emit({ sessionId, type: "status", message: reason });
        emit({ sessionId, type: "exit" });

        // A tunnel outlives nothing: it runs over this SSH connection, so when
        // the session ends the tunnel is a port listening on a dead socket.
        // Closing it here means the failure is visible now rather than the
        // next time someone tries to use it and gets silence.
        const tab = tabs.get(sessionId);
        if (tab) void tunnelManager.stopForHost(tab.hostId);
      },
    };
  }

  return {
    "terminal:open": async (payload) => {
      const parsed = OpenBody.safeParse(payload);
      if (!parsed.success) fail(ApiErrorCode.VALIDATION_FAILED, "Invalid open payload");
      const { hostId, cols, rows } = parsed.data;

      const vaultKey = requireVaultKey(engine);
      const user = currentUser(engine);
      const storeSessionId = getSessionId();

      const host = db
        .prepare("SELECT * FROM hosts WHERE id = ?")
        .get(hostId) as any;
      if (!host) fail(ApiErrorCode.NOT_FOUND, "Host not found");

      // Break-glass gate. Checked here rather than in the UI because a policy
      // enforced only by the renderer isn't a policy — anything that can reach
      // IPC would walk straight past it.
      //
      // The jump host is gated the same way as the destination, as its own
      // request against its own id.
      //
      // A tagged host used purely as a bastion used to be reachable with no
      // approval at all: `requiresApproval` only ever looked at the
      // destination, so routing *through* a sensitive machine authenticated a
      // full SSH session to it while the policy stayed silent. "Reaching a
      // host marked sensitive requires sign-off" does not stop meaning that
      // because the shell that opens is on the far side of it.
      const gate = (
        target: { id: string; tags?: unknown },
        role: "jump" | "destination",
      ): void => {
        if (!requiresApproval(db, target)) return;
        const grant = activeGrant(db, target.id, user?.id ?? null);
        if (!grant) {
          writeAudit(db, {
            user: user ?? undefined,
            action: "access.blocked",
            resourceType: "host",
            resourceId: target.id,
            detail: { reason: "approval required", role },
          });
          fail(
            ApiErrorCode.APPROVAL_REQUIRED,
            role === "jump"
              ? "The jump host for this connection requires approval from another team member"
              : "This host requires approval from another team member",
          );
        }
        writeAudit(db, {
          user: user ?? undefined,
          action: "access.elevated",
          resourceType: "host",
          resourceId: target.id,
          detail: { requestId: grant.id, approvedBy: grant.approver_name, role },
        });
      };

      if (host.jump_host_id) {
        const jumpForGate = db
          .prepare("SELECT id, tags FROM hosts WHERE id = ?")
          .get(host.jump_host_id) as { id: string; tags?: unknown } | undefined;
        // A dangling jump reference is caught properly further down, where
        // the connection is actually built; nothing to gate on if it is gone.
        if (jumpForGate) gate(jumpForGate, "jump");
      }
      gate(host, "destination");

      // One tab == one renderer-facing session id.
      const sessionId = generateId();
      // Managed id keeps the server's semantics: per (vault session, host).
      const managedId = `${storeSessionId}:${hostId}`;
      const client = makeClient(sessionId);
      tabs.set(sessionId, { managedId, hostId, client });

      // If this host is mid-connect, let it finish: whichever open got there
      // first will have registered a session, and this one then reattaches to
      // it rather than dialling a second connection alongside it.
      const inFlight = connecting.get(managedId);
      if (inFlight) {
        try { await inFlight; } catch { /* that attempt failed; try our own */ }
      }

      // Fast path — a live session for this host already exists. Reattach and
      // replay scrollback instead of opening a second SSH connection.
      const existing = engine.sessionManager.get(managedId);
      if (existing && !existing.closed) {
        const scrollback = engine.sessionManager.attach(managedId, client);
        emit({ sessionId, type: "status", message: "Reattached" });
        if (scrollback?.length) {
          emit({
            sessionId,
            type: "data",
            data: scrollback.toString("base64"),
          });
        }
        return { sessionId, reattached: true };
      }

      // Slow path — open a new SSH connection. The gate is held until a
      // session is registered or the attempt fails, so a concurrent open for
      // this host waits above instead of racing us.
      let openGate = () => {};
      connecting.set(
        managedId,
        new Promise<void>((resolve) => {
          openGate = () => {
            if (connecting.get(managedId) !== undefined) connecting.delete(managedId);
            resolve();
          };
        }),
      );

      const credential = host.credential_id
        ? (db
            .prepare("SELECT * FROM credentials WHERE id = ?")
            .get(host.credential_id) as any)
        : null;

      // The bastion this connection is routed through, if any.
      //
      // Declared out here because the audit entry is written from the "ready"
      // handler below, which is registered before the jump branch runs. Without
      // it the log recorded only the destination: reaching a machine through a
      // bastion and reaching it directly produced identical entries, and the hop
      // — a full authenticated SSH connection to another host — left no trace at
      // all. "Who reached what" is not the whole question; "by what route" is the
      // rest of it.
      let viaHost: { id: string; label: string | null; hostname: string } | null = null;

      const ssh = new SSH2Client();
      // Which method this connection is actually attempting. On an auth
      // rejection the useful hint differs entirely by method — a wrong
      // password, a key missing from authorized_keys, and an agent holding
      // the wrong keys are three different problems with the same ssh2
      // message ("All configured authentication methods failed").
      let authKind: "password" | "key" | "agent" | undefined;
      const connConfig: any = {
        host: host.hostname,
        port: host.port,
        username: host.username,
        // Must comfortably exceed the 60s fingerprint-confirmation wait
        // below — a plain network timeout here can't be shorter than a
        // step that pauses for a human to actually read and decide, or
        // ssh2's own timeout fires first and aborts mid-decision.
        readyTimeout: 90_000,
        keepaliveInterval: 30_000,
      };

      // SSH agent. The agent holds the key and performs the signature, so no
      // key material ever reaches Skiff — which is the point of using one, and
      // why this is worth supporting rather than telling people to paste keys.
      if (host.auth_method === "agent") {
        const sock = await resolveAgentSocket();

        if (!sock) {
          fail(
            ApiErrorCode.VALIDATION_FAILED,
            "No SSH agent is running. Start one, or switch this host to a password or key.",
          );
        }
        connConfig.agent = sock;
        authKind = "agent";
      }

      if (credential) {
        // decrypt(ciphertextWithTag, nonce, vaultKey) -> string. Key
        // credentials are stored as JSON so the passphrase travels with the
        // key material in a single encrypted blob; older rows may be a bare
        // string, hence the try/catch fallback.
        const plaintext = decrypt(
          Buffer.from(credential.encrypted_blob),
          Buffer.from(credential.nonce),
          vaultKey,
        );
        if (credential.kind === "password") {
          authKind = "password";
          connConfig.password = plaintext;
          // Also answer keyboard-interactive prompts with the same password.
          // Many servers — including modern macOS, whose sshd disables plain
          // PasswordAuthentication by default and offers only
          // keyboard-interactive — never accept the "password" method at
          // all. Without this, ssh2 has no auth method left to try, and the
          // connection just sits silent until readyTimeout kills it — which
          // looks identical to a network problem, not an auth one.
          connConfig.tryKeyboard = true;
          ssh.on(
            "keyboard-interactive",
            (_name, _instructions, _lang, prompts, finish) => {
              finish(prompts.map(() => plaintext));
            },
          );
        } else {
          let parsed: { value: string; passphrase?: string };
          try {
            parsed = JSON.parse(plaintext);
          } catch {
            parsed = { value: plaintext };
          }
          authKind = "key";
          connConfig.privateKey = parsed.value;
          if (parsed.passphrase) connConfig.passphrase = parsed.passphrase;
        }
      }

      // Host-key verification. Unknown or changed keys pause the connection
      // and ask the user, rather than trusting on first use silently.
      const knownHost = db
        .prepare("SELECT * FROM known_hosts WHERE hostname = ? AND port = ?")
        .get(host.hostname, host.port) as any;

      /**
       * Host key verification.
       *
       * The callback form, not a returned Promise. ssh2 checks the *return
       * value* for truthiness, and a Promise object is always truthy — so
       * returning one accepted every unknown host immediately, before the user
       * had answered. The prompt still appeared, but the connection was
       * already open behind it, and pressing Cancel changed nothing.
       *
       * Verified against a real server: `() => Promise.resolve(false)`
       * connects; `(key, verify) => verify(false)` refuses.
       */
      connConfig.hostVerifier = (key: Buffer, verify: (ok: boolean) => void): void => {
        const fp = createHostKeyFingerprint(key);

        if (knownHost) {
          if (knownHost.fingerprint === fp) {
            verify(true);
            return;
          }
          emit({
            sessionId,
            type: "fingerprint_mismatch",
            expected: knownHost.fingerprint,
            actual: fp,
          });
          verify(false);
          return;
        }

        emit({
          sessionId,
          type: "fingerprint_new",
          fingerprint: fp,
          hostname: host.hostname,
        });

        // Nothing proceeds until the user answers, or the wait times out.
        const timer = setTimeout(() => {
          fingerprintWaiters.delete(sessionId);
          emit({
            sessionId,
            type: "error",
            message: "Fingerprint confirmation timed out",
          });
          verify(false);
        }, 60_000);

        fingerprintWaiters.set(sessionId, (accept: boolean) => {
          clearTimeout(timer);
          fingerprintWaiters.delete(sessionId);
          if (accept) {
            // Columns must match known_hosts as declared in the schema:
            // (hostname, port, fingerprint, algorithm, first_seen_at), keyed
            // by (hostname, port). There is no surrogate id. OR REPLACE
            // rather than plain INSERT because accepting a key the user has
            // just been shown is the point at which a re-pin should take,
            // and a bare INSERT would throw on the primary key instead.
            //
            // Wrapped because this runs on the IPC handler's stack, not
            // ssh2's: a throw here escapes past verify() entirely, and ssh2
            // then waits out the full readyTimeout and reports "Timed out
            // while waiting for handshake" — a network error, for a database
            // fault, ninety seconds after the cause. Whatever goes wrong, the
            // handshake gets an answer and the user gets the real reason.
            try {
              db.prepare(
                `INSERT OR REPLACE INTO known_hosts
                   (hostname, port, fingerprint, algorithm, first_seen_at)
                 VALUES (?, ?, ?, ?, ?)`,
              ).run(
                host.hostname,
                host.port,
                fp,
                readHostKeyAlgorithm(key),
                new Date().toISOString(),
              );
            } catch (err: any) {
              emit({
                sessionId,
                type: "error",
                message: `Couldn't save the host key: ${err.message}`,
              });
              verify(false);
              return;
            }
          }
          verify(accept);
        });
      };

      emit({ sessionId, type: "status", message: "Connecting..." });

      ssh.on("ready", () => {
        emit({ sessionId, type: "status", message: "Connected" });
        db.prepare("UPDATE hosts SET last_connected_at = ? WHERE id = ?").run(
          new Date().toISOString(),
          hostId,
        );
        writeAudit(db, {
          user: user ?? undefined,
          action: "host.connect",
          resourceType: "host",
          resourceId: hostId,
          detail: {
            label: host.label,
            hostname: host.hostname,
            username: host.username,
            ...(viaHost
              ? { via: { id: viaHost.id, label: viaHost.label, hostname: viaHost.hostname } }
              : {}),
          },
        });

        ssh.shell({ term: "xterm-256color" }, async (shellErr, stream) => {
          if (shellErr) {
            openGate();
            emit({ sessionId, type: "error", message: shellErr.message });
            try {
              ssh.end();
            } catch {
              /* already closing */
            }
            return;
          }

          const session = engine.sessionManager.register({
            id: managedId,
            hostId,
            user: user ?? undefined,
            ssh,
            stream,
          });

          // A tunnel runs over this SSH connection, so it cannot outlive it.
          //
          // This used to hang off the attached client's end() — but a
          // detached session has no attached client, and SessionManager.end()
          // skips that call entirely when nothing is attached. Close a tab
          // and the session ends later with no cleanup: the listener stayed
          // bound to a dead connection, accepting connections and forwarding
          // them into nothing. It looked like a working tunnel that never
          // answered. Hanging it off the session itself covers every way a
          // session can end, including the ones with nobody watching.
          session.onEnd = () => {
            // The shell is gone, so its half-typed line is genuinely stale —
            // this is the one moment the buffer should be dropped.
            lineBuffers.delete(managedId);
            void tunnelManager.stopForHost(hostId);
          };

          // Optional recording (per-vault setting; mode-aware default).
          const meta = db
            .prepare("SELECT recording_enabled FROM vault_meta WHERE id = 1")
            .get() as { recording_enabled: number } | undefined;

          if (meta?.recording_enabled) {
            const recId = generateId("rec");
            try {
              const recorder = await SessionRecorder.create({
                dir: engine.recordingsDir,
                id: recId,
                cols,
                rows,
                title: `${host.label} (${host.username}@${host.hostname})`,
              });
              db.prepare(
                `INSERT INTO session_recordings
                   (id, host_id, host_label, hostname, user_id, username, started_at, status)
                 VALUES (?, ?, ?, ?, ?, ?, ?, 'recording')`,
              ).run(
                recId,
                hostId,
                host.label,
                host.hostname,
                user?.id ?? null,
                user?.username ?? null,
                new Date().toISOString(),
              );

              session.onOutput = (chunk) => recorder.writeOutput(chunk);
              // Compose, do not replace: the tunnel cleanup above must still
              // run when a session that was being recorded ends.
              const releaseTunnels = session.onEnd;
              session.onEnd = () => {
                try { releaseTunnels?.(); } catch { /* cleanup is best effort */ }
                const { durationMs, bytes } = recorder.finalize();
                try {
                  db.prepare(
                    "UPDATE session_recordings SET ended_at = ?, duration_ms = ?, bytes = ?, status = 'complete' WHERE id = ?",
                  ).run(new Date().toISOString(), durationMs, bytes, recId);
                } catch {
                  /* db may be closing on shutdown */
                }
              };
            } catch {
              // Recording setup failed — proceed without it; the session must work.
            }
          }

          // If the tab was closed while we were still connecting, the detach
          // handler ran before this session existed, so no reap timer was
          // started. Tear it down now rather than leaking an orphaned SSH
          // connection and a recording stuck in 'recording' state.
          if (!tabs.has(sessionId)) {
            openGate();
            engine.sessionManager.end(managedId, "Client gone");
            return;
          }

          engine.sessionManager.attach(managedId, client);
          openGate();
        });
      });

      ssh.on("error", (sshErr) => {
        openGate();
        // ssh2's own wording is accurate but not actionable — "Timed out while
        // waiting for handshake" is the message that cost two days of
        // debugging with the source open. The original text is preserved
        // inside the translator for the log; what reaches the user says what
        // to try next.
        emit({
          sessionId,
          type: "error",
          message: formatSshError(sshErr, {
            hostname: host.hostname,
            port: host.port,
            username: host.username,
            auth: authKind,
          }),
        });
      });

      // ── Jump host (ProxyJump) ────────────────────────────────────────
      //
      // Connect to the bastion first, ask it to open a channel to the target,
      // and hand that channel to the target connection as its socket. The
      // target's traffic is then tunnelled through the bastion, and the target
      // never needs to be reachable from here directly — which is the entire
      // reason bastions exist.
      //
      // One hop only. Chains of jump hosts are legal in OpenSSH but rare, and
      // supporting them means handling partial failures halfway along a chain;
      // that deserves its own pass rather than being half-built here.
      if (host.jump_host_id) {
        const jump = db
          .prepare("SELECT * FROM hosts WHERE id = ?")
          .get(host.jump_host_id) as any;

        if (!jump) {
          openGate();
          fail(
            ApiErrorCode.NOT_FOUND,
            "This host's jump host no longer exists. Edit the host to pick another.",
          );
        }
        if (jump.id === host.id) {
          openGate();
          fail(ApiErrorCode.VALIDATION_FAILED, "A host can't jump through itself");
        }

        viaHost = { id: jump.id, label: jump.label ?? null, hostname: jump.hostname };

        const jumpConfig = await buildConnectConfig(jump);
        const jumpClient = new SSH2Client();

        jumpClient.on("ready", () => {
          jumpClient.forwardOut(
            "127.0.0.1",
            0,
            host.hostname,
            host.port,
            (err, stream) => {
              if (err) {
                openGate();
                emit({
                  sessionId,
                  type: "error",
                  message: `Couldn't reach ${host.hostname} through ${jump.label || jump.hostname}: ${err.message}`,
                });
                try { jumpClient.end(); } catch { /* already closing */ }
                return;
              }
              // ssh2 takes an existing stream as `sock` and speaks SSH over it.
              connConfig.sock = stream;
              ssh.connect(connConfig);
            },
          );
        });

        jumpClient.on("error", (err) => {
          openGate();
          // The bastion itself failed, not the target — say which machine to
          // look at, or the user debugs the wrong one.
          emit({
            sessionId,
            type: "error",
            message: `Jump host ${jump.label || jump.hostname}: ` + formatSshError(err, {
              hostname: jump.hostname,
              port: jump.port,
              username: jump.username,
            }),
          });
        });

        // The bastion connection has to outlive the session it carries.
        ssh.on("close", () => { try { jumpClient.end(); } catch { /* gone */ } });

        jumpClient.connect(jumpConfig);
        return { sessionId, reattached: false, via: jump.label || jump.hostname };
      }

      // Reachability first, on its own short deadline, and the resulting
      // socket is what ssh2 then runs over — so this costs no extra
      // connection. readyTimeout stays long because it still has to cover
      // the host-key prompt waiting on a human; what it must not also do is
      // decide whether the machine is switched on. A sleeping Mac silently
      // drops the SYN, which is indistinguishable from a slow handshake
      // until you separate the two.
      void (async () => {
        try {
          connConfig.sock = await connectTcp(host.hostname, host.port);
        } catch (err: any) {
          openGate();
          emit({ sessionId, type: "error", message: err.message });
          return;
        }
        ssh.connect(connConfig);
      })();

      return { sessionId, reattached: false };
    },

    "terminal:write": async (payload) => {
      const parsed = WriteBody.safeParse(payload);
      if (!parsed.success) fail(ApiErrorCode.VALIDATION_FAILED, "Invalid write");
      const tab = tabs.get(parsed.data.sessionId);
      if (!tab) fail(ApiErrorCode.NOT_FOUND, "No such terminal session");

      const bytes = Buffer.from(parsed.data.data, "base64");

      // Guardrails. The line is modelled here purely so it can be checked on
      // Enter, then discarded — it is never stored or logged, because the same
      // keystrokes also carry whatever gets typed at a sudo password prompt.
      //
      // TerminalLineBuffer rather than string concatenation: the shell runs a
      // line editor, so a backspace changes the command without removing
      // anything from a naive buffer. That was not a corner case — one typo
      // defeated every rule in guardrails.ts, silently.
      if (guardrailsOn()) {
        const state = lineState(tab.managedId);
        const text = bytes.toString("utf8");
        const { line: candidate, enterIndex: enter } = state.buffer.feed(text);

        if (candidate !== null) {
          const hit = checkCommand(candidate);
          if (hit && state.pending !== candidate) {
            // Hold the newline. Everything before it is already echoed, so the
            // user sees their command sitting at the prompt while they decide.
            state.pending = candidate;
            if (enter > 0) {
              engine.sessionManager.write(tab.managedId, Buffer.from(text.slice(0, enter), "utf8"));
            }
            writeAudit(db, {
              user: currentUser(engine) ?? undefined,
              action: "command.intercepted",
              resourceType: "host",
              resourceId: tab.hostId,
              detail: { rule: hit.id, severity: hit.severity },
            });
            emit({ sessionId: parsed.data.sessionId, type: "guardrail", hit } as any);
            return { ok: true, held: true };
          }
          state.pending = null;
        }
      }

      engine.sessionManager.write(tab.managedId, bytes);
      return { ok: true };
    },

    /**
     * Release or discard a command the guardrail paused.
     *
     * Confirming records that the person was warned and went ahead anyway,
     * which is the part an auditor actually wants: not that a rule exists, but
     * that someone read it and made a decision.
     */
    "terminal:resolveGuardrail": async (payload) => {
      const parsed = ResolveGuardrailBody.safeParse(payload);
      if (!parsed.success) fail(ApiErrorCode.VALIDATION_FAILED, "Invalid response");
      const tab = tabs.get(parsed.data.sessionId);
      if (!tab) fail(ApiErrorCode.NOT_FOUND, "No such terminal session");

      const state = lineState(tab.managedId);
      const command = state.pending;
      state.pending = null;
      if (!command) return { ok: true };

      writeAudit(db, {
        user: currentUser(engine) ?? undefined,
        action: parsed.data.proceed ? "command.confirmed" : "command.cancelled",
        resourceType: "host",
        resourceId: tab.hostId,
        detail: { rule: parsed.data.ruleId ?? null },
      });

      if (parsed.data.proceed) {
        engine.sessionManager.write(tab.managedId, Buffer.from("\r", "utf8"));
      } else {
        // Ctrl+U clears the line the shell has already echoed, so the
        // abandoned command isn't left sitting at the prompt.
        engine.sessionManager.write(tab.managedId, Buffer.from("\u0015", "utf8"));
      }
      return { ok: true };
    },

    "terminal:resize": async (payload) => {
      const parsed = ResizeBody.safeParse(payload);
      if (!parsed.success) fail(ApiErrorCode.VALIDATION_FAILED, "Invalid resize");
      const tab = tabs.get(parsed.data.sessionId);
      if (!tab) return { ok: true }; // resize after close is harmless
      engine.sessionManager.resize(
        tab.managedId,
        parsed.data.rows,
        parsed.data.cols,
      );
      return { ok: true };
    },

    "terminal:confirmFingerprint": async (payload) => {
      const parsed = FingerprintBody.safeParse(payload);
      if (!parsed.success) fail(ApiErrorCode.VALIDATION_FAILED, "Invalid confirmation");
      const waiter = fingerprintWaiters.get(parsed.data.sessionId);
      if (!waiter) fail(ApiErrorCode.NOT_FOUND, "No pending confirmation");
      waiter(parsed.data.accept);
      return { ok: true };
    },

    /**
     * End the session for real, rather than detaching from it.
     *
     * Closing a tab deliberately leaves the shell running — that is what
     * keeps a long rsync alive across a closed tab. But it left no way to
     * actually stop a session: the Disconnect button called close, so the
     * SSH connection stayed up and, with recording on, kept recording. The
     * only way to stop either was to quit the app.
     *
     * Ending here runs the session's onEnd, which finalizes the recording
     * and marks the row complete — so a recording stops when the session it
     * belongs to stops, which is the only moment that makes sense.
     */
    "terminal:disconnect": async (payload) => {
      const parsed = CloseBody.safeParse(payload);
      if (!parsed.success) fail(ApiErrorCode.VALIDATION_FAILED, "Invalid disconnect");
      const tab = tabs.get(parsed.data.sessionId);
      if (!tab) fail(ApiErrorCode.NOT_FOUND, "No such session");
      engine.sessionManager.end(tab.managedId, "Disconnected");
      tabs.delete(parsed.data.sessionId);
      return { ok: true };
    },

    "terminal:close": async (payload) => {
      const parsed = CloseBody.safeParse(payload);
      if (!parsed.success) fail(ApiErrorCode.VALIDATION_FAILED, "Invalid close");
      const tab = tabs.get(parsed.data.sessionId);
      if (!tab) return { ok: true };
      // Detach, don't end. This is what makes sessions survive a closed tab.
      engine.sessionManager.detach(tab.managedId, tab.client);
      tabs.delete(parsed.data.sessionId);
      return { ok: true };
    },
  };
}

