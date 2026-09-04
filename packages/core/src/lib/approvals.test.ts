/**
 * Break-glass approval tests.
 *
 * The important ones here are the refusals. A gate that can be talked around
 * is worse than no gate, because it produces audit entries implying oversight
 * that never happened — so self-approval, expiry and cross-user reuse each get
 * a test rather than a comment.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  readPolicy,
  writePolicy,
  requiresApproval,
  activeGrant,
  createRequest,
  decideRequest,
  listRequests,
  countPending,
  DEFAULT_POLICY,
} from "./approvals.js";

function freshDb(): any {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE vault_meta (id INTEGER PRIMARY KEY, approval_policy TEXT);
    INSERT INTO vault_meta (id) VALUES (1);
    CREATE TABLE access_requests (
      id TEXT PRIMARY KEY,
      host_id TEXT NOT NULL,
      host_label TEXT,
      requester_id TEXT,
      requester_name TEXT,
      reason TEXT,
      status TEXT NOT NULL CHECK (status IN ('pending','approved','denied','expired')),
      approver_id TEXT,
      approver_name TEXT,
      created_at TEXT NOT NULL,
      decided_at TEXT,
      expires_at TEXT NOT NULL,
      grant_expires_at TEXT
    );
  `);
  return db;
}

function enable(db: any, over: Partial<typeof DEFAULT_POLICY> = {}) {
  writePolicy(db, { ...DEFAULT_POLICY, enabled: true, ...over });
}

const prodHost = { id: "h1", tags: JSON.stringify(["prod", "web"]) };
const devHost = { id: "h2", tags: JSON.stringify(["dev"]) };

function request(db: any, who = "u1", name = "j.doe") {
  return createRequest(db, {
    hostId: "h1", hostLabel: "web-01",
    requesterId: who, requesterName: name, reason: "deploy fix",
  });
}

test("policy is off by default, so nothing is gated", () => {
  const db = freshDb();
  assert.equal(readPolicy(db).enabled, false);
  assert.equal(requiresApproval(db, prodHost), false);
});

test("when enabled, only hosts carrying a policy tag are gated", () => {
  const db = freshDb();
  enable(db);
  assert.equal(requiresApproval(db, prodHost), true);
  assert.equal(requiresApproval(db, devHost), false);
  assert.equal(requiresApproval(db, { id: "h3" }), false);
});

test("tag matching ignores case", () => {
  const db = freshDb();
  enable(db, { tags: ["PROD"] });
  assert.equal(requiresApproval(db, { id: "h1", tags: '["prod"]' }), true);
});

test("a request grants nothing until someone decides", () => {
  const db = freshDb();
  enable(db);
  const req = request(db);
  assert.equal(req.status, "pending");
  assert.equal(activeGrant(db, "h1", "u1"), null);
  assert.equal(countPending(db), 1);
});

test("you cannot approve your own request", () => {
  const db = freshDb();
  enable(db);
  const req = request(db, "u1");

  const result = decideRequest(db, {
    requestId: req.id, approve: true,
    approverId: "u1", approverName: "j.doe",
  });

  assert.equal(result.ok, false);
  assert.equal((result as any).error, "self_approval");
  assert.equal(activeGrant(db, "h1", "u1"), null);
});

test("a second person's approval opens a window", () => {
  const db = freshDb();
  enable(db);
  const req = request(db, "u1");

  const result = decideRequest(db, {
    requestId: req.id, approve: true,
    approverId: "u2", approverName: "a.ops",
  });
  assert.equal(result.ok, true);

  const grant = activeGrant(db, "h1", "u1");
  assert.ok(grant, "requester should now have access");
  assert.equal(grant!.approver_name, "a.ops");
  assert.ok(grant!.grant_expires_at! > new Date().toISOString());
});

test("a grant belongs to the requester, not the whole team", () => {
  const db = freshDb();
  enable(db);
  const req = request(db, "u1");
  decideRequest(db, { requestId: req.id, approve: true, approverId: "u2", approverName: "a.ops" });

  assert.ok(activeGrant(db, "h1", "u1"), "requester has access");
  assert.equal(activeGrant(db, "h1", "u3"), null, "someone else must not inherit it");
});

test("a grant does not leak to other hosts", () => {
  const db = freshDb();
  enable(db);
  const req = request(db, "u1");
  decideRequest(db, { requestId: req.id, approve: true, approverId: "u2", approverName: "a.ops" });

  assert.equal(activeGrant(db, "h2", "u1"), null);
});

test("denial grants nothing", () => {
  const db = freshDb();
  enable(db);
  const req = request(db, "u1");
  decideRequest(db, { requestId: req.id, approve: false, approverId: "u2", approverName: "a.ops" });

  assert.equal(activeGrant(db, "h1", "u1"), null);
  assert.equal(countPending(db), 0);
});

test("a decided request cannot be decided again", () => {
  const db = freshDb();
  enable(db);
  const req = request(db, "u1");
  decideRequest(db, { requestId: req.id, approve: false, approverId: "u2", approverName: "a.ops" });

  const second = decideRequest(db, {
    requestId: req.id, approve: true, approverId: "u2", approverName: "a.ops",
  });
  assert.equal(second.ok, false);
  assert.equal((second as any).error, "already_decided");
});

test("an expired grant stops working", () => {
  const db = freshDb();
  enable(db);
  const req = request(db, "u1");
  decideRequest(db, { requestId: req.id, approve: true, approverId: "u2", approverName: "a.ops" });

  // Wind the window back into the past.
  db.prepare("UPDATE access_requests SET grant_expires_at = ? WHERE id = ?")
    .run(new Date(Date.now() - 1000).toISOString(), req.id);

  assert.equal(activeGrant(db, "h1", "u1"), null);
});

test("an unanswered request expires and can't then be approved", () => {
  const db = freshDb();
  enable(db);
  const req = request(db, "u1");

  db.prepare("UPDATE access_requests SET expires_at = ? WHERE id = ?")
    .run(new Date(Date.now() - 1000).toISOString(), req.id);

  const result = decideRequest(db, {
    requestId: req.id, approve: true, approverId: "u2", approverName: "a.ops",
  });
  assert.equal(result.ok, false);
  assert.equal((result as any).error, "expired");
  assert.equal(activeGrant(db, "h1", "u1"), null);
});

test("clicking connect repeatedly reuses one open request", () => {
  const db = freshDb();
  enable(db);
  const a = request(db, "u1");
  const b = request(db, "u1");

  assert.equal(a.id, b.id, "approvers shouldn't be spammed with duplicates");
  assert.equal(countPending(db), 1);
});

test("pending requests sort ahead of decided ones", () => {
  const db = freshDb();
  enable(db);
  const done = request(db, "u1");
  decideRequest(db, { requestId: done.id, approve: true, approverId: "u2", approverName: "a.ops" });
  createRequest(db, {
    hostId: "h1", hostLabel: "web-01",
    requesterId: "u3", requesterName: "c.dev", reason: null,
  });

  const list = listRequests(db);
  assert.equal(list[0].status, "pending");
});

test("an identity-less request cannot be self-approved", () => {
  // Reachable after a personal→team upgrade: rows written before the upgrade
  // carry no user id. The old check short-circuited on null and let the
  // requester approve their own request.
  const db = freshDb();
  enable(db);
  const req = createRequest(db, {
    hostId: "h1", hostLabel: "web-01",
    requesterId: null, requesterName: "j.doe", reason: null,
  });

  const result = decideRequest(db, {
    requestId: req.id, approve: true,
    approverId: null, approverName: "j.doe",
  });

  assert.equal(result.ok, false);
  assert.equal((result as any).error, "self_approval");
  assert.equal(activeGrant(db, "h1", null), null);
});

test("an approver with no identity at all is refused", () => {
  const db = freshDb();
  enable(db);
  const req = request(db, "u1");

  const result = decideRequest(db, {
    requestId: req.id, approve: true, approverId: null, approverName: null,
  });

  assert.equal(result.ok, false);
});

test("a different person without ids can still approve", () => {
  const db = freshDb();
  enable(db);
  const req = createRequest(db, {
    hostId: "h1", hostLabel: "web-01",
    requesterId: null, requesterName: "j.doe", reason: null,
  });

  const result = decideRequest(db, {
    requestId: req.id, approve: true, approverId: null, approverName: "a.ops",
  });

  assert.equal(result.ok, true);
});
