/**
 * Approval handlers.
 *
 * Policy changes are admin-only and audited; decisions are audited with both
 * names attached. The audit entries are the product here as much as the gate
 * is — a break-glass event nobody can reconstruct afterwards is barely better
 * than no gate at all.
 */

import { z } from "zod";
import {
  readPolicy,
  writePolicy,
  listRequests,
  createRequest,
  decideRequest,
  countPending,
  requiresApproval,
  activeGrant,
  writeAudit,
  DEFAULT_POLICY,
} from "@skiff/core";
import { ApiErrorCode } from "@skiff/shared";
import type { EngineContext } from "../engine.js";
import { fail, type Handlers } from "./contract.js";
import { currentUser, requireVaultKey } from "./auth.js";

const RequestBody = z.object({
  hostId: z.string().min(1),
  reason: z.string().max(500).optional(),
});

const DecideBody = z.object({
  requestId: z.string().min(1),
  approve: z.boolean(),
});

const PolicyBody = z.object({
  enabled: z.boolean(),
  tags: z.array(z.string().min(1)).max(20),
  requestTtlMinutes: z.number().int().min(1).max(1440),
  grantMinutes: z.number().int().min(1).max(1440),
});

export function registerApprovalHandlers(engine: EngineContext): Handlers {
  const db = engine.db.raw;

  const mode = (): string => {
    try {
      const row = db.prepare("SELECT mode FROM vault_meta WHERE id = 1").get() as
        | { mode?: string }
        | undefined;
      return row?.mode ?? "personal";
    } catch {
      return "personal";
    }
  };

  const requireUnlocked = () => {
    requireVaultKey(engine);
    return currentUser(engine);
  };

  return {
    "approvals:policy": async () => (requireUnlocked(), {
      ...readPolicy(db),
      // Personal vaults have nobody to approve, so the UI shows why the
      // switch is unavailable rather than an inert toggle.
      supported: mode() === "team",
    }),

    "approvals:setPolicy": async (payload) => {
      const user = requireUnlocked();
      if (mode() !== "team") {
        fail(
          ApiErrorCode.WRONG_MODE,
          "Approvals need a second person — available in team vaults",
        );
      }
      if (!user?.isAdmin) fail(ApiErrorCode.FORBIDDEN, "Admin only");

      const parsed = PolicyBody.safeParse({ ...DEFAULT_POLICY, ...(payload ?? {}) });
      if (!parsed.success) fail(ApiErrorCode.VALIDATION_FAILED, "Invalid policy");

      const next = {
        ...parsed.data,
        tags: parsed.data.tags.map((t) => t.trim().toLowerCase()).filter(Boolean),
      };
      writePolicy(db, next);
      writeAudit(db, {
        user: user ?? undefined,
        action: "approvals.policy",
        detail: next,
      });
      return next;
    },

    "approvals:list": async () => {
      requireUnlocked();
      return listRequests(db, 100);
    },

    // The status rail polls this, so it runs constantly — but it still reads
    // vault data and must not answer while locked.
    "approvals:pendingCount": async () => {
      requireUnlocked();
      return { count: countPending(db) };
    },

    "approvals:request": async (payload) => {
      const user = requireUnlocked();
      const parsed = RequestBody.safeParse(payload);
      if (!parsed.success) fail(ApiErrorCode.VALIDATION_FAILED, "Host required");

      const host = db
        .prepare("SELECT id, label, tags, jump_host_id FROM hosts WHERE id = ?")
        .get(parsed.data.hostId) as any;
      if (!host) fail(ApiErrorCode.NOT_FOUND, "Host not found");

      // Connecting to `host` may cross a jump host on the way, and that hop can
      // be gated independently — see the matching check in terminal:open. The
      // renderer only knows the destination it was trying to reach, not which
      // hop actually blocked it, so this resolves that itself: one click raises
      // every request the connection still needs, not just one that might be
      // for the wrong host.
      // Whether each candidate is the destination itself or a hop the
      // connection merely passes through — the request for a jump host needs
      // to say so, or "mac mini requires approval" reads as someone wanting a
      // shell on mac mini when they actually want one on `via-bastion` and
      // mac mini just carries the traffic there.
      const candidates: Array<{
        id: string;
        label: string | null;
        tags?: unknown;
        role: "destination" | "jump";
      }> = [{ ...host, role: "destination" }];
      if (host.jump_host_id) {
        const jump = db
          .prepare("SELECT id, label, tags FROM hosts WHERE id = ?")
          .get(host.jump_host_id) as any;
        if (jump) candidates.push({ ...jump, role: "jump" });
      }

      const needed = candidates.filter(
        (h) => requiresApproval(db, h) && !activeGrant(db, h.id, user?.id ?? null),
      );
      if (needed.length === 0) {
        fail(
          ApiErrorCode.CONFLICT,
          "This connection doesn't need approval, or you already have access",
        );
      }

      const userReason = parsed.data.reason?.trim() || null;
      const requests = needed.map((h) => {
        // The reason line renders directly in the Approvals list, right under
        // the host name — so the jump context belongs there, not in a detail
        // view nobody has to open. The destination's own request is untouched:
        // its host label already says what it is.
        const reason =
          h.role === "jump"
            ? `Jump host for connecting to "${host.label ?? host.id}"${
                userReason ? ` — ${userReason}` : ""
              }`
            : userReason;
        const request = createRequest(db, {
          hostId: h.id,
          hostLabel: h.label ?? null,
          requesterId: user?.id ?? null,
          requesterName: user?.username ?? null,
          reason,
        });
        writeAudit(db, {
          user: user ?? undefined,
          action: "approval.requested",
          resourceType: "host",
          resourceId: h.id,
          detail: { requestId: request.id, reason: request.reason },
        });
        return request;
      });

      // Unchanged shape for a single request, so existing callers that read
      // `.id` off the result keep working; `requests` carries the rest when
      // there is more than one.
      return { ...requests[0], requests };
    },

    "approvals:decide": async (payload) => {
      const user = requireUnlocked();
      const parsed = DecideBody.safeParse(payload);
      if (!parsed.success) fail(ApiErrorCode.VALIDATION_FAILED, "Invalid decision");

      const result = decideRequest(db, {
        requestId: parsed.data.requestId,
        approve: parsed.data.approve,
        approverId: user?.id ?? null,
        approverName: user?.username ?? null,
      });

      if (!result.ok) {
        if (result.error === "self_approval") {
          // The rule that makes this mean anything.
          fail(ApiErrorCode.FORBIDDEN, "You can't approve your own request");
        }
        if (result.error === "not_found") fail(ApiErrorCode.NOT_FOUND, "Request not found");
        if (result.error === "expired") fail(ApiErrorCode.CONFLICT, "That request expired");
        fail(ApiErrorCode.CONFLICT, "That request was already decided");
      }

      writeAudit(db, {
        user: user ?? undefined,
        action: parsed.data.approve ? "approval.granted" : "approval.denied",
        resourceType: "host",
        resourceId: result.request.host_id,
        detail: {
          requestId: result.request.id,
          requestedBy: result.request.requester_name,
          until: result.request.grant_expires_at,
        },
      });
      return result.request;
    },
  };
}
