/**
 * Tunnel handlers.
 *
 * Tunnels are access, so they run over an open session for the host — the same
 * rule as SFTP, and for a sharper reason here: a local forward to port 5432
 * hands you the production database without ever opening a shell anyone would
 * notice. A tunnel that dialled out on its own would be a way straight past
 * break-glass approval.
 *
 * Nothing is persisted. A tunnel is a live thing bound to a live connection;
 * saving one to restore later would imply it survives a restart, which it
 * cannot. Saved tunnel *definitions* are a separate feature and should be
 * built as such rather than implied by accident.
 */

import { z } from "zod";
import {
  TunnelManager,
  validateTunnel,
  generateId,
  writeAudit,
  type TunnelSpec,
} from "@skiff/core";
import { ApiErrorCode } from "@skiff/shared";
import type { EngineContext } from "../engine.js";
import { fail, type Handlers } from "./contract.js";
import { requireVaultKey, currentUser } from "./auth.js";

const CreateBody = z.object({
  hostId: z.string().min(1),
  type: z.enum(["local", "remote"]),
  listenPort: z.number().int(),
  listenAddress: z.string().optional(),
  destHost: z.string().min(1),
  destPort: z.number().int(),
  label: z.string().max(120).optional(),
});

export const tunnelManager = new TunnelManager();

export function registerTunnelHandlers(engine: EngineContext): Handlers {
  const db = engine.db.raw;

  const sshFor = (hostId: string) => {
    requireVaultKey(engine);
    const session = engine.sessionManager.list().find((s: any) => s.hostId === hostId);
    if (!session) {
      fail(
        ApiErrorCode.CONFLICT,
        "Open a session to this host first — tunnels run over the connection you already have",
      );
    }
    return (session as any).ssh;
  };

  return {
    // A tunnel list names hosts and internal addresses, so it is vault data
    // even though the manager holds it in memory rather than the database.
    "tunnels:list": async () => {
      requireVaultKey(engine);
      return tunnelManager.list();
    },

    "tunnels:count": async () => {
      requireVaultKey(engine);
      return { count: tunnelManager.countRunning() };
    },

    "tunnels:start": async (payload) => {
      const parsed = CreateBody.safeParse(payload);
      if (!parsed.success) fail(ApiErrorCode.VALIDATION_FAILED, "Check the tunnel details");

      const spec: TunnelSpec = {
        id: generateId(),
        hostId: parsed.data.hostId,
        type: parsed.data.type,
        listenPort: parsed.data.listenPort,
        // Loopback unless asked otherwise: the difference is whether the
        // machine next to you on café wifi can reach your database too.
        listenAddress: parsed.data.listenAddress?.trim() || "127.0.0.1",
        destHost: parsed.data.destHost.trim(),
        destPort: parsed.data.destPort,
        label: parsed.data.label?.trim() || undefined,
      };

      const problem = validateTunnel(spec);
      if (problem) fail(ApiErrorCode.VALIDATION_FAILED, problem);

      const ssh = sshFor(spec.hostId);
      let state;
      try {
        state =
          spec.type === "local"
            ? await tunnelManager.startLocal(spec, ssh)
            : await tunnelManager.startRemote(spec, ssh);
      } catch (err: any) {
        fail(ApiErrorCode.CONFLICT, err?.message || "Couldn't open that tunnel");
      }

      writeAudit(db, {
        user: currentUser(engine) ?? undefined,
        action: "tunnel.open",
        resourceType: "host",
        resourceId: spec.hostId,
        detail: {
          type: spec.type,
          listen: `${spec.listenAddress}:${spec.listenPort}`,
          dest: `${spec.destHost}:${spec.destPort}`,
        },
      });
      return state;
    },

    "tunnels:stop": async (payload) => {
      requireVaultKey(engine);
      const parsed = z.object({ id: z.string().min(1) }).safeParse(payload);
      if (!parsed.success) fail(ApiErrorCode.VALIDATION_FAILED, "Tunnel id required");

      const state = tunnelManager.get(parsed.data.id);
      await tunnelManager.stop(parsed.data.id);

      if (state) {
        writeAudit(db, {
          user: currentUser(engine) ?? undefined,
          action: "tunnel.close",
          resourceType: "host",
          resourceId: state.hostId,
          detail: {
            type: state.type,
            listen: `${state.listenAddress}:${state.listenPort}`,
            connections: state.connections,
          },
        });
      }
      return { ok: true };
    },
  };
}
