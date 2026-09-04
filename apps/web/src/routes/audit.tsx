import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AppShell } from "@/components/shell";
import { apiGet } from "@/lib/api";
import { toast } from "@/lib/toast";
import * as I from "@/components/icons";
import "@/styles/audit.css";

/**
 * Audit log with chain verification.
 *
 * The banner is the point of this screen. Every SSH tool has a log; the claim
 * that separates Skiff is that the log can be *proved* unmodified. So the
 * verification result leads, before any of the entries, and it reports three
 * states rather than two — an empty log is not "verified", because there is
 * nothing to verify, and a reassuring tick over no data would be exactly the
 * false comfort this feature exists to prevent.
 */

interface AuditEntry {
  id: number;
  user_id: string | null;
  username: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  detail: string | null;
  ip: string | null;
  at: string;
  prev_hash: string | null;
  hash: string | null;
}

interface Integrity {
  status: "verified" | "broken" | "empty";
  count: number;
  head: string | null;
  brokenAt: number | null;
  reason: string | null;
  unchained: number;
  checkedAt: string;
}

/** Colour families for action badges, by what the action does. */
function toneFor(action: string): string {
  const a = action.toLowerCase();
  if (a.includes("block") || a.includes("fail") || a.includes("denied") || a.includes("delete")) return "is-critical";
  if (a.includes("grant") || a.includes("connect") || a.includes("unlock") || a.includes("create")) return "is-ok";
  if (a.includes("request") || a.includes("approval")) return "is-caution";
  if (a.includes("update") || a.includes("modif") || a.includes("change")) return "is-info";
  return "";
}

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function initials(name: string | null): string {
  if (!name) return "··";
  const parts = name.split(/[.\s_-]+/).filter(Boolean);
  const first = parts[0] ?? name;
  const second = parts[1];
  const initials = second ? `${first[0] ?? ""}${second[0] ?? ""}` : name.slice(0, 2);
  return initials.toLowerCase();
}

interface AuditExport {
  exportedAt: string;
  exportedBy: string | null;
  integrity: Integrity;
  entries: AuditEntry[];
}

/** RFC 4180 columns, in the order the chain is written. */
const CSV_COLUMNS = [
  "id", "at", "username", "action", "resource_type", "resource_id",
  "detail", "ip", "prev_hash", "hash",
] as const;

/**
 * Serialise to CSV.
 *
 * Every field is quoted rather than only the ones that need it. `detail` holds
 * JSON — commas, quotes and colons throughout — and a serialiser that decides
 * per-field when to quote is one edge case away from producing a file that
 * parses into the wrong number of columns. For a record whose purpose is being
 * read back later, the uniform version is worth the few extra bytes.
 *
 * The leading BOM is for Excel, which otherwise reads UTF-8 as the local
 * codepage and mangles any non-ASCII username or label.
 */
function toCsv(rows: AuditEntry[]): string {
  const cell = (v: unknown): string => {
    if (v === null || v === undefined) return '""';
    const text = typeof v === "string" ? v : JSON.stringify(v);
    return '"' + text.replace(/"/g, '""') + '"';
  };
  const lines = [CSV_COLUMNS.map(cell).join(",")];
  for (const row of rows) {
    lines.push(CSV_COLUMNS.map((c) => cell((row as any)[c])).join(","));
  }
  return "\uFEFF" + lines.join("\r\n") + "\r\n";
}

export function AuditRoute() {
  const qc = useQueryClient();
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<number | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [exporting, setExporting] = useState<null | "json" | "csv">(null);

  const entries = useQuery({
    queryKey: ["audit-list"],
    queryFn: () => apiGet<AuditEntry[]>("/api/audit?limit=500"),
  });

  const integrity = useQuery({
    queryKey: ["audit-integrity"],
    queryFn: () => apiGet<Integrity>("/api/audit/integrity"),
  });

  const reverify = async () => {
    setVerifying(true);
    try {
      await qc.invalidateQueries({ queryKey: ["audit-integrity"] });
      await qc.invalidateQueries({ queryKey: ["audit-list"] });
    } finally {
      // Brief hold so the button visibly does something even when the check is
      // instant — otherwise it reads as if nothing happened.
      setTimeout(() => setVerifying(false), 400);
    }
  };

  /**
   * Write the log to a file the user keeps.
   *
   * Deliberately not the filtered view on screen: an audit export that quietly
   * omits whatever was typed in the search box is a trap. This is always the
   * complete log, in chain order, hashes included, so it can be re-verified
   * outside Skiff.
   */
  const doExport = async (format: "json" | "csv") => {
    setExporting(format);
    try {
      const data = await apiGet<AuditExport>("/api/audit/export");
      const stamp = new Date().toISOString().slice(0, 10);
      const body =
        format === "json"
          ? JSON.stringify(data, null, 2)
          : toCsv(data.entries);
      const blob = new Blob([body], {
        type: format === "json" ? "application/json" : "text/csv;charset=utf-8",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `skiff-audit-${stamp}.${format}`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(`Exported ${data.entries.length.toLocaleString()} entries`, {
        description:
          data.integrity.status === "verified"
            ? "The chain verified at the moment of export."
            : `Chain status at export: ${data.integrity.status}.`,
      });
    } catch (e: any) {
      toast.error("Export failed", { description: e?.message });
    } finally {
      setExporting(null);
    }
  };

  const all = entries.data ?? [];
  const q = query.trim().toLowerCase();
  const list = q
    ? all.filter((e) =>
        [e.action, e.username, e.resource_id, e.resource_type].some((v) =>
          v?.toLowerCase().includes(q),
        ),
      )
    : all;

  const status = integrity.data?.status;

  return (
    <AppShell
      title="skiff — audit"
      toolbar={{
        searchValue: query,
        onSearchChange: setQuery,
        placeholder: "Search actions, actors, hosts…",
      }}
      sidebar={{}}
    >
      {/* Verification banner */}
      <div className={`chain chain--${status ?? "loading"}`}>
        <span className="chain__icon">
          {status === "broken" ? <I.Warn size={18} /> : <I.Shield size={18} />}
        </span>

        <span className="chain__text">
          <span className="chain__title">
            {status === "verified" && "Chain verified"}
            {status === "broken" && "Chain broken"}
            {status === "empty" && "Nothing recorded yet"}
            {!status && "Checking…"}
          </span>
          <span className="chain__sub">
            {status === "verified" && (
              <>
                All {integrity.data!.count.toLocaleString()} entries hash-linked and intact
                {integrity.data!.unchained > 0 && (
                  <>
                    {" · "}
                    {integrity.data!.unchained} earlier{" "}
                    {integrity.data!.unchained === 1 ? "entry predates" : "entries predate"}{" "}
                    chaining and can't be verified
                  </>
                )}
              </>
            )}
            {status === "broken" && integrity.data?.reason}
            {status === "empty" && "Actions you take will be recorded and hash-linked from here."}
          </span>
        </span>

        {integrity.data && status !== "empty" && (
          <span className="chain__stat">
            <b>{integrity.data.count.toLocaleString()}</b>
            <span>entries checked</span>
          </span>
        )}

        <div className="chain__actions">
        <button className="chain__btn" onClick={reverify} disabled={verifying}>
          {verifying ? "Verifying…" : "Re-verify"}
        </button>
        <button
          className="chain__btn"
          onClick={() => void doExport("json")}
          disabled={exporting !== null}
          title="Every entry, in chain order, with its hashes"
        >
          {exporting === "json" ? "Exporting…" : "Export JSON"}
        </button>
        <button
          className="chain__btn"
          onClick={() => void doExport("csv")}
          disabled={exporting !== null}
          title="Every entry, in chain order, with its hashes"
        >
          {exporting === "csv" ? "Exporting…" : "Export CSV"}
        </button>
        </div>
      </div>

      {/* Chain head — the value worth writing down elsewhere */}
      {status === "verified" && integrity.data?.head && (
        <div className="chain-head">
          <span className="chain-head__label">Chain head</span>
          <code>{integrity.data.head}</code>
          <button
            className="chain-head__copy"
            onClick={() => navigator.clipboard?.writeText(integrity.data!.head!)}
            title="Copy"
          >
            <I.Copy size={12} />
          </button>
          <span className="chain-head__note">
            Record this outside Skiff to detect the log being replaced wholesale.
          </span>
        </div>
      )}

      <div className="audit-table">
        <div className="audit-table__head">
          <span className="c-mark" />
          <span className="c-time">Timestamp</span>
          <span className="c-actor">Actor</span>
          <span className="c-action">Action</span>
          <span className="c-target">Target</span>
          <span className="c-hash">Hash</span>
        </div>

        {entries.isLoading && <div className="audit-empty">Loading…</div>}

        {!entries.isLoading && list.length === 0 && (
          <div className="audit-empty">
            <I.Shield size={28} />
            <p>{q ? "Nothing matches that search." : "No audit entries yet."}</p>
          </div>
        )}

        {list.map((e) => {
          const broken = integrity.data?.brokenAt === e.id;
          const open = expanded === e.id;
          return (
            <div key={e.id} className={`audit-row${broken ? " is-broken" : ""}${open ? " is-open" : ""}`}>
              <div className="audit-row__main" onClick={() => setExpanded(open ? null : e.id)}>
                <span className="c-mark">
                  <span className={`link-dot${e.hash ? "" : " is-unchained"}${broken ? " is-broken" : ""}`} />
                </span>
                <span className="c-time">{fmtWhen(e.at)}</span>
                <span className="c-actor">
                  {e.username ? (
                    <>
                      <span className="avatar">{initials(e.username)}</span>
                      {e.username}
                    </>
                  ) : (
                    <span className="muted">local</span>
                  )}
                </span>
                <span className="c-action">
                  <span className={`action-badge ${toneFor(e.action)}`}>
                    {e.action.replace(/[._]/g, " ")}
                  </span>
                </span>
                <span className="c-target">{e.resource_id ?? e.resource_type ?? "—"}</span>
                <span className="c-hash">
                  {e.hash ? `${e.hash.slice(0, 8)}…` : "unchained"}
                  <I.Chevron size={10} />
                </span>
              </div>

              {open && (
                <div className="audit-detail">
                  <div className="audit-detail__grid">
                    <span>Entry</span><code>#{e.id}</code>
                    <span>Recorded</span><code>{e.at}</code>
                    {e.ip && (<><span>Source</span><code>{e.ip}</code></>)}
                    {e.detail && (<><span>Detail</span><code>{e.detail}</code></>)}
                    <span>Previous</span><code>{e.prev_hash || "— first entry"}</code>
                    <span>This entry</span><code>{e.hash ?? "not hashed"}</code>
                  </div>
                  {broken && integrity.data?.reason && (
                    <div className="audit-detail__warn">
                      <I.Warn size={13} />
                      {integrity.data.reason}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </AppShell>
  );
}
