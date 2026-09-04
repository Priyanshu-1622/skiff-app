import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";
import { useVault } from "@/lib/vault";

/**
 * The status rail — Skiff's signature element.
 *
 * A persistent 38px strip along the bottom of every screen carrying live
 * system state: connection, sessions, tunnels, pending approvals, audit-chain
 * integrity, and latency. Built to the exact Instrument Panel spec. It is the
 * one element allowed to be bold; everything else stays quiet around it.
 *
 * Gauges without a live source yet (tunnels, approvals, latency) render as
 * calm zeros/dashes rather than being hidden — the rail reads like an
 * instrument cluster where every gauge is always present, even at rest. As the
 * v0.4 governance features land, these gain real feeds.
 */

interface RailProps {
  sessions?: number;
  live?: boolean;
}

export function StatusRail({ sessions, live = true }: RailProps) {
  // These endpoints require an unlocked vault. Polling them while locked would
  // mean three failed requests every twenty seconds, and an audit entry stream
  // of nothing but rejections — noise in the one log that has to stay readable.
  const vault = useVault((v) => v.status);
  const unlocked = !!vault?.unlocked;

  const tunnelCount = useQuery({
    queryKey: ["tunnels-count"],
    queryFn: () => apiGet<{ count: number }>("/api/tunnels/count"),
    retry: false,
    enabled: unlocked,
    refetchInterval: 20_000,
    throwOnError: false,
  });
  const tunnels = tunnelCount.data?.count ?? 0;

  // Pending approvals are the one number here someone is actively waiting on,
  // so it polls rather than waiting for a navigation to refresh it.
  const approvals = useQuery({
    queryKey: ["approvals-pending"],
    queryFn: () => apiGet<{ count: number }>("/api/approvals/pending"),
    retry: false,
    enabled: unlocked,
    refetchInterval: 20_000,
    throwOnError: false,
  });
  const pending = approvals.data?.count ?? 0;

  const audit = useQuery({
    queryKey: ["audit-integrity"],
    queryFn: () =>
      apiGet<{ status: "verified" | "broken" | "empty"; count: number }>(
        "/api/audit/integrity",
      ),
    retry: false,
    enabled: unlocked,
    staleTime: 30_000,
    throwOnError: false,
  });

  // Three states, not two. An empty log is not "verified" — there is nothing
  // to verify — and showing a reassuring tick over no data would be the exact
  // kind of false comfort this feature exists to avoid.
  const status = audit.data?.status;

  return (
    <footer className="statusrail" role="status" aria-label="System status">
      <span className={`rail-item ${live ? "live" : "off"}`}>
        <span className="rail-dot" />
        {live ? "Live" : "Offline"}
      </span>

      <span className="rail-item">
        Sessions <b>{sessions ?? 0}</b>
      </span>

      <span className="rail-item">
        Tunnels <b>{tunnels}</b>
      </span>

      <span className={`rail-item${pending > 0 ? " pending" : ""}`}>
        {pending > 0 && <span className="rail-dot" />}
        Approvals <b>{pending}</b>
      </span>

      <span
        className={`rail-item ${status === "broken" ? "critical" : status === "verified" ? "ok" : ""}`}
        title={
          status === "broken"
            ? "The audit log fails verification — open Audit for details"
            : status === "verified"
              ? `Audit chain verified across ${audit.data?.count ?? 0} entries`
              : "No audit entries yet"
        }
      >
        Audit{" "}
        <b>
          {status === "broken" ? "⚠ Broken" : status === "verified" ? "✓ Verified" : "—"}
        </b>
      </span>

      <span className="rail-item latency">
        <span className="rail-dot live" />
        Latency <b>—</b>
      </span>
    </footer>
  );
}
