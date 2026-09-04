import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AppShell } from "@/components/shell";
import { apiGet, apiPost } from "@/lib/api";
import { toast } from "@/lib/toast";
import * as I from "@/components/icons";
import "@/styles/approvals.css";

/**
 * Break-glass approvals.
 *
 * Pending requests lead, because they're the only thing on this screen anyone
 * is waiting on. Decided ones stay below as a record rather than disappearing
 * — "who approved that, and when" is half the value of having the gate.
 */

interface AccessRequest {
  id: string;
  host_id: string;
  host_label: string | null;
  requester_id: string | null;
  requester_name: string | null;
  reason: string | null;
  status: "pending" | "approved" | "denied" | "expired";
  approver_name: string | null;
  created_at: string;
  decided_at: string | null;
  expires_at: string;
  grant_expires_at: string | null;
}

interface Policy {
  enabled: boolean;
  tags: string[];
  requestTtlMinutes: number;
  grantMinutes: number;
  supported: boolean;
}

function rel(iso: string | null): string {
  if (!iso) return "—";
  const diff = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(diff);
  const m = Math.round(abs / 60000);
  const text = m < 1 ? "under a minute" : m < 60 ? `${m}m` : `${Math.round(m / 60)}h`;
  return diff >= 0 ? `in ${text}` : `${text} ago`;
}

export function ApprovalsRoute() {
  const qc = useQueryClient();
  const [query, setQuery] = useState("");

  const policy = useQuery({
    queryKey: ["approval-policy"],
    queryFn: () => apiGet<Policy>("/api/approvals/policy"),
  });

  const requests = useQuery({
    queryKey: ["approvals"],
    queryFn: () => apiGet<AccessRequest[]>("/api/approvals"),
    // Someone is waiting on the other side of this, so it shouldn't need a
    // manual refresh to notice a new request.
    refetchInterval: 15_000,
  });

  const decide = useMutation({
    mutationFn: (vars: { requestId: string; approve: boolean }) =>
      apiPost("/api/approvals/decide", vars),
    onSuccess: (_d, vars) => {
      toast.success(vars.approve ? "Access granted" : "Request denied");
      qc.invalidateQueries({ queryKey: ["approvals"] });
      qc.invalidateQueries({ queryKey: ["approvals-pending"] });
    },
    onError: (e: any) => toast.error(e?.message || "Couldn't record that decision"),
  });

  const all = requests.data ?? [];
  const q = query.trim().toLowerCase();
  const match = (r: AccessRequest) =>
    !q ||
    [r.host_label, r.requester_name, r.reason].some((v) => v?.toLowerCase().includes(q));

  const pending = all.filter((r) => r.status === "pending" && match(r));
  const decided = all.filter((r) => r.status !== "pending" && match(r));

  return (
    <AppShell
      title="skiff — approvals"
      toolbar={{
        searchValue: query,
        onSearchChange: setQuery,
        placeholder: "Search requests by host, person, or reason…",
      }}
      sidebar={{}}
    >
      {/* Policy state — without this the screen looks broken when it's simply off */}
      {policy.data && !policy.data.enabled && (
        <div className={`ap-banner${policy.data.supported ? "" : " is-muted"}`}>
          <I.Shield size={16} />
          <span>
            <b>Break-glass approvals are off.</b>{" "}
            {policy.data.supported
              ? "Turn them on in Settings to require a second person's sign-off before anyone reaches a tagged host."
              : "Approvals need a second person to sign off, so they're only available in team vaults."}
          </span>
        </div>
      )}

      {policy.data?.enabled && (
        <div className="ap-banner is-on">
          <I.Shield size={16} />
          <span>
            Hosts tagged{" "}
            {policy.data.tags.map((t) => (
              <code key={t}>{t}</code>
            ))}{" "}
            require approval. Granted access lasts {policy.data.grantMinutes} minutes.
          </span>
        </div>
      )}

      <section className="ap-section">
        <h2 className="ap-section__title">
          Waiting on a decision
          {pending.length > 0 && <span className="ap-count">{pending.length}</span>}
        </h2>

        {pending.length === 0 ? (
          <div className="ap-empty">Nothing is waiting for approval.</div>
        ) : (
          pending.map((r) => (
            <div key={r.id} className="ap-card">
              <div className="ap-card__main">
                <div className="ap-card__head">
                  <span className="ap-who">{r.requester_name ?? "someone"}</span>
                  <span className="ap-verb">wants access to</span>
                  <span className="ap-host">{r.host_label ?? r.host_id}</span>
                </div>
                {r.reason && <p className="ap-reason">“{r.reason}”</p>}
                <div className="ap-meta">
                  <span>asked {rel(r.created_at)}</span>
                  <span className="dot">·</span>
                  <span>expires {rel(r.expires_at)}</span>
                </div>
              </div>
              <div className="ap-card__actions">
                <button
                  className="btn btn--secondary"
                  disabled={decide.isPending}
                  onClick={() => decide.mutate({ requestId: r.id, approve: false })}
                >
                  Deny
                </button>
                <button
                  className="btn btn--primary"
                  disabled={decide.isPending}
                  onClick={() => decide.mutate({ requestId: r.id, approve: true })}
                >
                  Approve
                </button>
              </div>
            </div>
          ))
        )}
      </section>

      <section className="ap-section">
        <h2 className="ap-section__title">Recent decisions</h2>

        {decided.length === 0 ? (
          <div className="ap-empty">No decisions recorded yet.</div>
        ) : (
          <div className="ap-table">
            {decided.map((r) => (
              <div key={r.id} className={`ap-row is-${r.status}`}>
                <span className={`ap-badge is-${r.status}`}>{r.status}</span>
                <span className="ap-row__host">{r.host_label ?? r.host_id}</span>
                <span className="ap-row__who">{r.requester_name ?? "—"}</span>
                <span className="ap-row__by">
                  {r.status === "approved" || r.status === "denied"
                    ? `by ${r.approver_name ?? "—"}`
                    : "no decision"}
                </span>
                <span className="ap-row__when">{rel(r.decided_at ?? r.expires_at)}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </AppShell>
  );
}
