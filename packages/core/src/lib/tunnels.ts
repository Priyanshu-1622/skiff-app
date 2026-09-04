/**
 * Port forwarding.
 *
 * Two directions, both over an SSH connection that already exists:
 *
 *   local  (-L)  a port on this machine → a host:port reachable from the server
 *                "let me hit the server's database as if it were local"
 *
 *   remote (-R)  a port on the server → a host:port reachable from here
 *                "let the server reach the app I'm running on my laptop"
 *
 * Like SFTP, these run over a live managed session rather than dialling out.
 * A tunnel is access, and access that opens its own connection would slip past
 * whatever gated the session — including a break-glass approval. It would be a
 * particularly bad hole here: a local forward to port 5432 gives you the
 * production database without ever opening a shell that anyone would see.
 *
 * ── Binding ───────────────────────────────────────────────────────────────
 * Local listeners bind to 127.0.0.1, not 0.0.0.0, unless explicitly asked.
 * The difference is whether the machine next to you on the café wifi can also
 * reach your production database. The default has to be the safe one.
 *
 * ── Not included ──────────────────────────────────────────────────────────
 * Dynamic forwarding (-D / SOCKS) isn't here. It needs a SOCKS5 proxy server,
 * not just a pipe, and shipping a half-correct proxy in a security tool is
 * worse than not shipping one. It belongs in its own pass.
 */

import { createServer, connect, type Server, type Socket } from "node:net";
import type { Client as SSH2Client } from "ssh2";

export type TunnelType = "local" | "remote";

export interface TunnelSpec {
  id: string;
  hostId: string;
  type: TunnelType;
  /** Port opened by whichever side is listening. */
  listenPort: number;
  /** Address the listener binds to. Defaults to loopback. */
  listenAddress: string;
  /** Where traffic is delivered. */
  destHost: string;
  destPort: number;
  label?: string;
}

export interface TunnelState extends TunnelSpec {
  status: "running" | "stopped" | "error";
  message: string | null;
  /** Connections handled since it started. */
  connections: number;
  startedAt: string | null;
}

interface RunningTunnel {
  state: TunnelState;
  server?: Server;
  ssh: SSH2Client;
  sockets: Set<Socket>;
  /** Detaches the ssh "close" watcher, so stopping does not leak listeners. */
  untrack?: () => void;
}

export class TunnelManager {
  private tunnels = new Map<string, RunningTunnel>();

  list(): TunnelState[] {
    return [...this.tunnels.values()].map((t) => ({ ...t.state }));
  }

  get(id: string): TunnelState | null {
    const t = this.tunnels.get(id);
    return t ? { ...t.state } : null;
  }

  countRunning(): number {
    return [...this.tunnels.values()].filter((t) => t.state.status === "running").length;
  }

  /**
   * Open a local forward.
   *
   * Listens here; each inbound connection asks the server to open a channel to
   * the destination, and the two are piped together.
   */
  async startLocal(spec: TunnelSpec, ssh: SSH2Client): Promise<TunnelState> {
    this.assertFree(spec.id);

    const sockets = new Set<Socket>();
    const state: TunnelState = {
      ...spec,
      status: "running",
      message: null,
      connections: 0,
      startedAt: new Date().toISOString(),
    };

    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      // A failed forward must not take the app down; it's one connection.
      socket.on("error", () => { try { socket.destroy(); } catch { /* gone */ } });

      state.connections++;

      ssh.forwardOut(
        socket.remoteAddress ?? "127.0.0.1",
        socket.remotePort ?? 0,
        spec.destHost,
        spec.destPort,
        (err, stream) => {
          if (err) {
            // The server refused, usually because nothing is listening on the
            // far side. Close this connection, keep the tunnel up.
            try { socket.destroy(); } catch { /* gone */ }
            state.message = err.message;
            return;
          }
          stream.on("error", () => { try { socket.destroy(); } catch { /* gone */ } });
          socket.pipe(stream).pipe(socket);
        },
      );
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", (err: NodeJS.ErrnoException) => {
        // EADDRINUSE is the common one and deserves a readable message —
        // "port already in use" beats a raw errno.
        reject(
          err.code === "EADDRINUSE"
            ? new Error(`Port ${spec.listenPort} is already in use on this machine`)
            : err,
        );
      });
      server.listen(spec.listenPort, spec.listenAddress || "127.0.0.1", () => resolve());
    });

    // Later failures are recorded, not thrown into the void.
    server.on("error", (err) => {
      state.status = "error";
      state.message = err.message;
    });

    // Belt to the caller's braces. Whatever else fails to clean up, a tunnel
    // stops when the connection it rides on goes away — otherwise the
    // listener stays bound and every connection to it hangs, since
    // forwardOut on a dead client never calls back.
    const onSshClose = () => { void this.stop(spec.id); };
    ssh.once("close", onSshClose);

    this.tunnels.set(spec.id, {
      state,
      server,
      ssh,
      sockets,
      untrack: () => ssh.removeListener("close", onSshClose),
    });

    return { ...state };
  }

  /**
   * Open a remote forward.
   *
   * The server listens; each connection it accepts is handed to us, and we
   * connect onward from this machine.
   */
  async startRemote(spec: TunnelSpec, ssh: SSH2Client): Promise<TunnelState> {
    this.assertFree(spec.id);

    const sockets = new Set<Socket>();
    const state: TunnelState = {
      ...spec,
      status: "running",
      message: null,
      connections: 0,
      startedAt: new Date().toISOString(),
    };

    await new Promise<void>((resolve, reject) => {
      ssh.forwardIn(spec.listenAddress || "127.0.0.1", spec.listenPort, (err) => {
        if (err) {
          reject(
            new Error(
              `The server refused to listen on port ${spec.listenPort}. ` +
                "Ports below 1024 need root, and GatewayPorts must be enabled for non-loopback addresses.",
            ),
          );
          return;
        }
        resolve();
      });
    });

    const onConnection = (info: any, accept: () => any, reject: () => void) => {
      // ssh2 fires this for every remote forward on the connection, so ignore
      // anything not meant for this tunnel.
      if (info.destPort !== spec.listenPort) return;

      const local = connect(spec.destPort, spec.destHost, () => {
        const stream = accept();
        state.connections++;
        sockets.add(local);
        local.on("close", () => sockets.delete(local));
        stream.on("error", () => { try { local.destroy(); } catch { /* gone */ } });
        local.pipe(stream).pipe(local);
      });

      local.on("error", (err) => {
        // Nothing listening on our side. Refuse cleanly rather than hanging
        // the server's connection.
        state.message = err.message;
        try { reject(); } catch { /* already gone */ }
      });
    };

    ssh.on("tcp connection", onConnection);
    const onRemoteSshClose = () => { void this.stop(spec.id); };
    ssh.once("close", onRemoteSshClose);

    this.tunnels.set(spec.id, {
      state,
      ssh,
      sockets,
      untrack: () => ssh.removeListener("close", onRemoteSshClose),
    });
    return { ...state };
  }

  async stop(id: string): Promise<void> {
    const t = this.tunnels.get(id);
    if (!t) return;

    try { t.untrack?.(); } catch { /* already gone */ }

    for (const socket of t.sockets) {
      try { socket.destroy(); } catch { /* gone */ }
    }
    t.sockets.clear();

    if (t.server) {
      await new Promise<void>((resolve) => t.server!.close(() => resolve()));
    } else {
      // Remote forward: ask the server to stop listening.
      try {
        t.ssh.unforwardIn(t.state.listenAddress || "127.0.0.1", t.state.listenPort, () => {});
      } catch { /* connection may already be gone */ }
    }

    this.tunnels.delete(id);
  }

  /** Close everything for a host — called when its session ends. */
  async stopForHost(hostId: string): Promise<void> {
    const ids = [...this.tunnels.values()]
      .filter((t) => t.state.hostId === hostId)
      .map((t) => t.state.id);
    for (const id of ids) await this.stop(id);
  }

  async stopAll(): Promise<void> {
    for (const id of [...this.tunnels.keys()]) await this.stop(id);
  }

  private assertFree(id: string): void {
    if (this.tunnels.has(id)) {
      throw new Error("That tunnel is already running");
    }
  }
}

/**
 * Validate a spec before anything is opened.
 *
 * Returns a human-readable reason rather than a boolean: every one of these is
 * shown to someone who has just mistyped something, and "invalid" alone is a
 * useless thing to read.
 */
export function validateTunnel(spec: Partial<TunnelSpec>): string | null {
  const port = (n: unknown) => typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 65535;

  if (spec.type !== "local" && spec.type !== "remote") return "Choose a tunnel direction";
  if (!port(spec.listenPort)) return "Listen port must be between 1 and 65535";
  if (!port(spec.destPort)) return "Destination port must be between 1 and 65535";
  if (!spec.destHost || !spec.destHost.trim()) return "Destination host is required";

  // A destination like "127.0.0.1:22" is a host and a port typed into the host
  // box, and the server cannot tell: it calls getaddrinfo on the whole string
  // and fails with "nodename nor servname provided", which reads like a DNS
  // fault rather than a form mistake. Caught here so the message names the
  // real problem. IPv6 literals are bracketed, so they are still allowed.
  const host = spec.destHost.trim();
  if (!host.startsWith("[") && host.includes(":")) {
    return "Destination host should not include a port — put it in the port box";
  }

  if (spec.type === "local" && spec.listenPort! < 1024) {
    return "Ports below 1024 need administrator rights on this machine";
  }
  return null;
}
