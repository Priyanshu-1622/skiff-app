import { createConnection, type Socket } from "node:net";

/**
 * How long to wait for the TCP connection itself.
 *
 * Deliberately short. This covers only "can I open a socket to this address",
 * which on a working LAN takes milliseconds and over a working WAN link takes
 * well under a second. It is not the SSH handshake budget and must never be
 * confused with one: ssh2's `readyTimeout` has to stay long enough to cover a
 * host-key prompt that waits on a human, so it cannot double as the
 * reachability check. Splitting them is the entire point of this module —
 * an unreachable host fails in seconds instead of sitting on "Connecting..."
 * for the length of the handshake budget.
 */
export const TCP_CONNECT_TIMEOUT_MS = 5_000;

/**
 * Open a TCP connection, or fail quickly with a message worth reading.
 *
 * The resolved socket is meant to be handed to ssh2 as its `sock` option, so
 * this costs no extra connection — it is the same socket the SSH session then
 * runs over, just established under our own deadline rather than ssh2's.
 */
export function connectTcp(
  host: string,
  port: number,
  timeoutMs: number = TCP_CONNECT_TIMEOUT_MS,
): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port });
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error(describeTcpFailure({ code: "ETIMEDOUT" }, host, port)));
    }, timeoutMs);

    socket.once("connect", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(socket);
    });

    socket.once("error", (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(new Error(describeTcpFailure(err, host, port)));
    });
  });
}

/**
 * Turn a socket errno into something a person can act on.
 *
 * These four failures look identical in the UI otherwise ("it didn't
 * connect"), yet they call for completely different responses — wake the
 * machine, enable the service, fix the address, fix the route. The distinction
 * is free here and impossible to recover later, so it is spelled out.
 */
export function describeTcpFailure(
  err: { code?: string },
  host: string,
  port: number,
): string {
  const where = `${host}:${port}`;
  switch (err.code) {
    case "ECONNREFUSED":
      return `${where} refused the connection — nothing is listening on that port. Check the SSH server is running and the port is right.`;
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return `Can't resolve "${host}". Check the hostname, or use its IP address.`;
    case "EHOSTUNREACH":
    case "ENETUNREACH":
      return `No route to ${host}. Check you're on the same network.`;
    default:
      return `Can't reach ${where} — no response. The machine may be asleep or powered off, or a firewall may be dropping the connection.`;
  }
}
