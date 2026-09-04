/**
 * Break-glass approvals.
 *
 * Reaching a host marked sensitive requires a second person to sign off. The
 * request, the decision, and the window it opens are all recorded, so "who let
 * this happen" has an answer that doesn't depend on anyone's memory.
 *
 * ── The shape of it ────────────────────────────────────────────────────────
 * A host is gated when any of its tags is in the policy's tag list (default:
 * `prod`). Gating on tags rather than a per-host flag means the rule survives
 * hosts being added later — import twenty machines tagged `prod` and they're
 * all covered without anyone remembering to tick a box.
 *
 * An approval opens a *window*, not a single connection. Reconnecting after a
 * dropped link inside that window doesn't need a fresh signature — otherwise
 * flaky wifi would train people to keep a standing approval open, which is
 * exactly the behaviour this is meant to prevent.
 *
 * ── What this deliberately does not do ─────────────────────────────────────
 * One approver, not N-of-M. No approval chains, no delegation, no per-team
 * policy. Those only mean something in an organisation with a management
 * hierarchy, and they're what the enterprise tier is for. A fifteen-person
 * startup gets the complete, working feature here.
 *
 * ── Personal vaults ────────────────────────────────────────────────────────
 * Approvals need a second person, so a personal vault can't have them. Rather
 * than pretend, the policy simply can't be enabled there. Self-approval would
 * be theatre, and worse, it would produce audit entries implying oversight
 * that never happened.
 */

import type Database from "better-sqlite3";
import { generateId } from "./id.js";

export type RequestStatus = "pending" | "approved" | "denied" | "expired";

export interface AccessRequest {
  id: string;
  host_id: string;
  host_label: string | null;
  requester_id: string | null;
  requester_name: string | null;
  reason: string | null;
  status: RequestStatus;
  approver_id: string | null;
  approver_name: string | null;
  created_at: string;
  decided_at: string | null;
  /** When the *request* stops being answerable. */
  expires_at: string;
  /** When the granted access window closes. Null until approved. */
  grant_expires_at: string | null;
}

export interface ApprovalPolicy {
  enabled: boolean;
  /** Hosts carrying any of these tags need approval. */
  tags: string[];
  /** How long an unanswered request stays open. */
  requestTtlMinutes: number;
  /** How long access lasts once granted. */
  grantMinutes: number;
}

export const DEFAULT_POLICY: ApprovalPolicy = {
  enabled: false,
  tags: ["prod"],
  requestTtlMinutes: 15,
  grantMinutes: 30,
};

function nowIso(): string {
  return new Date().toISOString();
}

function plusMinutes(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

/** Tags are stored as a JSON array in a TEXT column; be forgiving reading it. */
function hostTags(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw !== "string" || !raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function readPolicy(db: Database.Database): ApprovalPolicy {
  try {
    const row = db
      .prepare("SELECT approval_policy FROM vault_meta WHERE id = 1")
      .get() as { approval_policy?: string } | undefined;
    if (!row?.approval_policy) return { ...DEFAULT_POLICY };
    const parsed = JSON.parse(row.approval_policy);
    return { ...DEFAULT_POLICY, ...parsed };
  } catch {
    return { ...DEFAULT_POLICY };
  }
}

export function writePolicy(db: Database.Database, policy: ApprovalPolicy): void {
  db.prepare("UPDATE vault_meta SET approval_policy = ? WHERE id = 1").run(
    JSON.stringify(policy),
  );
}

/** Does reaching this host need someone else's sign-off? */
export function requiresApproval(
  db: Database.Database,
  host: { id: string; tags?: unknown },
): boolean {
  const policy = readPolicy(db);
  if (!policy.enabled || policy.tags.length === 0) return false;
  const tags = hostTags(host.tags).map((t) => t.toLowerCase());
  return policy.tags.some((t) => tags.includes(t.toLowerCase()));
}

/**
 * An approved, unexpired grant for this user and host, if one exists.
 *
 * Scoped to the requester: an approval granted to one team member is not a
 * door the whole team can walk through.
 */
export function activeGrant(
  db: Database.Database,
  hostId: string,
  userId: string | null,
): AccessRequest | null {
  const row = db
    .prepare(
      `SELECT * FROM access_requests
       WHERE host_id = ? AND status = 'approved'
         AND grant_expires_at > ?
         AND (requester_id IS ? OR requester_id = ?)
       ORDER BY decided_at DESC LIMIT 1`,
    )
    .get(hostId, nowIso(), userId, userId) as AccessRequest | undefined;
  return row ?? null;
}

/** Mark requests nobody answered in time. Cheap, so it runs before every read. */
export function expireStale(db: Database.Database): void {
  try {
    db.prepare(
      "UPDATE access_requests SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?",
    ).run(nowIso());
  } catch {
    /* table may not exist yet on a very old vault */
  }
}

export function createRequest(
  db: Database.Database,
  input: {
    hostId: string;
    hostLabel: string | null;
    requesterId: string | null;
    requesterName: string | null;
    reason: string | null;
  },
): AccessRequest {
  const policy = readPolicy(db);

  // Reuse an open request rather than letting someone spam approvers by
  // clicking Connect repeatedly.
  const existing = db
    .prepare(
      `SELECT * FROM access_requests
       WHERE host_id = ? AND status = 'pending' AND expires_at > ?
         AND (requester_id IS ? OR requester_id = ?)
       LIMIT 1`,
    )
    .get(input.hostId, nowIso(), input.requesterId, input.requesterId) as
    | AccessRequest
    | undefined;
  if (existing) return existing;

  const id = generateId();
  db.prepare(
    `INSERT INTO access_requests
       (id, host_id, host_label, requester_id, requester_name, reason, status,
        created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
  ).run(
    id,
    input.hostId,
    input.hostLabel,
    input.requesterId,
    input.requesterName,
    input.reason,
    nowIso(),
    plusMinutes(policy.requestTtlMinutes),
  );

  return db
    .prepare("SELECT * FROM access_requests WHERE id = ?")
    .get(id) as AccessRequest;
}

export type DecisionError =
  | "not_found"
  | "already_decided"
  | "expired"
  | "self_approval";

/**
 * Approve or deny.
 *
 * Refuses self-approval. That single rule is what makes this "a second person
 * signed off" rather than "someone clicked twice" — without it the whole
 * feature is decoration.
 */
export function decideRequest(
  db: Database.Database,
  input: {
    requestId: string;
    approve: boolean;
    approverId: string | null;
    approverName: string | null;
  },
): { ok: true; request: AccessRequest } | { ok: false; error: DecisionError } {
  expireStale(db);

  const req = db
    .prepare("SELECT * FROM access_requests WHERE id = ?")
    .get(input.requestId) as AccessRequest | undefined;

  if (!req) return { ok: false, error: "not_found" };
  if (req.status !== "pending") {
    return { ok: false, error: req.status === "expired" ? "expired" : "already_decided" };
  }
  // Both null counts as the same person, not as two different ones.
  //
  // The previous check short-circuited when requester_id was null, so a
  // request with no identity could be approved by an approver with no
  // identity — which is the same human. That state is reachable: a personal
  // vault that upgrades to team carries forward rows written without a user
  // id. Falling back to the name closes it, and an unidentified approver is
  // refused outright rather than trusted.
  if (!input.approverId && !input.approverName) {
    return { ok: false, error: "self_approval" };
  }
  const sameId =
    req.requester_id !== null && req.requester_id === input.approverId;
  const sameNameWithoutIds =
    req.requester_id === null &&
    input.approverId === null &&
    req.requester_name === input.approverName;
  if (sameId || sameNameWithoutIds) {
    return { ok: false, error: "self_approval" };
  }

  const policy = readPolicy(db);
  db.prepare(
    `UPDATE access_requests
       SET status = ?, approver_id = ?, approver_name = ?, decided_at = ?,
           grant_expires_at = ?
     WHERE id = ?`,
  ).run(
    input.approve ? "approved" : "denied",
    input.approverId,
    input.approverName,
    nowIso(),
    input.approve ? plusMinutes(policy.grantMinutes) : null,
    input.requestId,
  );

  return {
    ok: true,
    request: db
      .prepare("SELECT * FROM access_requests WHERE id = ?")
      .get(input.requestId) as AccessRequest,
  };
}

export function listRequests(
  db: Database.Database,
  limit = 100,
): AccessRequest[] {
  expireStale(db);
  return db
    .prepare(
      `SELECT * FROM access_requests
       ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC
       LIMIT ?`,
    )
    .all(Math.min(Math.max(limit, 1), 500)) as AccessRequest[];
}

export function countPending(db: Database.Database): number {
  try {
    expireStale(db);
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM access_requests WHERE status = 'pending'")
      .get() as { n: number };
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}
