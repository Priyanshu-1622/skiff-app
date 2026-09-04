import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AppShell } from "@/components/shell";
import { apiGet, apiPost } from "@/lib/api";
import { toast } from "@/lib/toast";
import * as I from "@/components/icons";
import "@/styles/tunnels.css";

/**
 * Port forwarding.
 *
 * The two directions confuse almost everyone, so the form explains each one in
 * a sentence rather than showing `-L` and `-R` and assuming. Getting the
 * direction wrong is the single most common mistake with forwarding, and it
 * fails in a way that looks like a network problem.
 */

interface Tunnel {
  id: string;
  hostId: string;
  type: "local" | "remote";
  listenPort: number;
  listenAddress: string;
  destHost: string;
  destPort: number;
  label?: string;
  status: "running" | "stopped" | "error";
  message: string | null;
  connections: number;
  startedAt: string | null;
}

export function TunnelsRoute() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<"local" | "remote">("local");
  const [hostId, setHostId] = useState("");
  const [listenPort, setListenPort] = useState("8080");
  const [destHost, setDestHost] = useState("127.0.0.1");
  const [destPort, setDestPort] = useState("80");
  const [label, setLabel] = useState("");
  const [exposed, setExposed] = useState(false);

  const hosts = useQuery({ queryKey: ["hosts"], queryFn: () => apiGet<any[]>("/api/hosts") });
  const tunnels = useQuery({
    queryKey: ["tunnels"],
    queryFn: () => apiGet<Tunnel[]>("/api/tunnels"),
    refetchInterval: 5_000,
  });

  const start = useMutation({
    mutationFn: () =>
      apiPost("/api/tunnels", {
        hostId,
        type,
        listenPort: portOf(listenPort)!,
        listenAddress: exposed ? "0.0.0.0" : "127.0.0.1",
        destHost,
        destPort: portOf(destPort)!,
        label: label || undefined,
      }),
    onSuccess: () => {
      toast.success("Tunnel open");
      setOpen(false);
      qc.invalidateQueries({ queryKey: ["tunnels"] });
    },
    onError: (e: any) => toast.error("Couldn't open the tunnel", { description: e?.message }),
  });

  const stop = useMutation({
    mutationFn: (id: string) => apiPost("/api/tunnels/stop", { id }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tunnels"] }),
  });

  // Number("") and Number("abc") are 0 and NaN, and both would travel to the
  // engine and fail there with a less useful message than the form can give.
  const portOf = (v: string): number | null => {
    const n = Number(v.trim());
    return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
  };
  const listenValid = portOf(listenPort) !== null;
  const destValid = portOf(destPort) !== null;
  // "Invalid" only once something has been typed — an empty field is
  // unfinished, not wrong, and colouring it red on open is just noise.
  // The destination renders as one box with a colon in the middle, so
  // "127.0.0.1:22" gets typed into the host half and the port half keeps its
  // default. The server then tries to resolve a hostname containing a colon
  // and fails with a DNS error that says nothing about the real mistake.
  // Rather than only rejecting it, the pair is split on the way out of the
  // field — that is what was meant.
  const splitDestHost = () => {
    const m = destHost.trim().match(/^(.+?)\s*:\s*(\d{1,5})$/);
    if (m && portOf(m[2]!) !== null) {
      setDestHost(m[1]!.trim());
      setDestPort(m[2]!);
    } else {
      setDestHost(destHost.trim());
    }
  };
  const destHostBad = !destHost.startsWith("[") && destHost.includes(":");

  const listenBad = listenPort.trim() !== "" && !listenValid;
  const destBad = destPort.trim() !== "" && !destValid;
  const formValid =
    !!hostId && listenValid && destValid && !!destHost.trim() && !destHostBad;

  // Escape closes, matching every other dialog in the app.
  useEffect(() => {
    if (!(open)) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); setOpen(false); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const list = tunnels.data ?? [];
  const hostName = (id: string) => {
    const h = (hosts.data ?? []).find((x: any) => x.id === id);
    return h?.label || h?.hostname || id;
  };

  return (
    <AppShell
      title="skiff — tunnels"
      sidebar={{}}
      toolbar={{
        hideSearch: true,
        actions: (
          <button className="btn btn--primary" onClick={() => setOpen(true)}>
            <I.Plus size={12} />
            New tunnel
          </button>
        ),
      }}
    >
      {list.length === 0 ? (
        <div className="tn-empty">
          <I.Globe size={30} />
          <p>No tunnels open.</p>
          <p className="tn-empty__hint">
            A tunnel forwards a port between this machine and a server you're
            connected to — reaching a database as if it were local, or letting a
            server reach something running here.
          </p>
        </div>
      ) : (
        <div className="tn-table">
          <div className="tn-head">
            <span>Direction</span>
            <span>Route</span>
            <span>Host</span>
            <span className="num">Connections</span>
            <span />
          </div>

          {list.map((t) => (
            <div key={t.id} className="tn-row-wrap">
            <div className={`tn-row is-${t.status}`}>
              <span className="tn-dir">
                <span className={`tn-badge is-${t.type}`}>{t.type}</span>
              </span>

              {/* The route reads left to right in the direction traffic flows,
                  which is the only way this stays legible at a glance. */}
              <span className="tn-route">
                {t.type === "local" ? (
                  <>
                    <code>{t.listenAddress}:{t.listenPort}</code>
                    <I.ArrowRight size={12} />
                    <code>{t.destHost}:{t.destPort}</code>
                    <span className="tn-route__via">on the server</span>
                  </>
                ) : (
                  <>
                    <code>server:{t.listenPort}</code>
                    <I.ArrowRight size={12} />
                    <code>{t.destHost}:{t.destPort}</code>
                    <span className="tn-route__via">here</span>
                  </>
                )}
              </span>

              <span className="tn-host">{hostName(t.hostId)}</span>
              <span className="tn-conns num">{t.connections}</span>

              <span className="tn-actions">
                {t.message && (
                  <span className="tn-msg" title={t.message}><I.Warn size={12} /></span>
                )}
                <button
                  className="btn btn--danger btn--sm"
                  onClick={() => stop.mutate(t.id)}
                  disabled={stop.isPending}
                >
                  Close
                </button>
              </span>
            </div>

            {/* Spelled out under the row rather than left in a tooltip on a
                12px icon. A tunnel that listens but refuses every connection
                gives no clue on its own, and the server's reason is the whole
                diagnosis. */}
            {t.message && (
              <p className="tn-rowmsg">
                <I.Warn size={12} />
                <span>{t.message}</span>
              </p>
            )}
            </div>
          ))}
        </div>
      )}

      {open && (
        <div className="dialog-overlay" onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
          <div className="dialog tn-dialog" role="dialog" aria-label="New tunnel">
            <div className="dialog__head"><h2>New tunnel</h2></div>

            <div className="tn-form">
              <label className="tn-label">Direction</label>
              <div className="tn-choice">
                <button
                  type="button"
                  className={type === "local" ? "is-active" : ""}
                  onClick={() => setType("local")}
                >
                  <strong>Reach the server's network</strong>
                  <span>
                    A port here forwards to something the server can see — its
                    database, an internal admin page.
                  </span>
                </button>
                <button
                  type="button"
                  className={type === "remote" ? "is-active" : ""}
                  onClick={() => setType("remote")}
                >
                  <strong>Expose something from here</strong>
                  <span>
                    A port on the server forwards back to something running on
                    this machine.
                  </span>
                </button>
              </div>

              <label className="tn-label">Host</label>
              <div className="tn-field">
                <select value={hostId} onChange={(e) => setHostId(e.target.value)}>
                  <option value="">Choose a connected host…</option>
                  {(hosts.data ?? []).map((h: any) => (
                    <option key={h.id} value={h.id}>{h.label || h.hostname}</option>
                  ))}
                </select>
              </div>

              <div className="tn-listen">
                <div>
                  <label className="tn-label">
                    {type === "local" ? "Port on this machine" : "Port on the server"}
                  </label>
                  <div className={`tn-field${listenBad ? " is-invalid" : ""}`}>
                    <input
                      className="mono"
                      value={listenPort}
                      onChange={(e) => setListenPort(e.target.value)}
                      inputMode="numeric"
                      aria-invalid={listenBad || undefined}
                    />
                  </div>
                  {/* Rendered whether or not it applies, so appearing does not
                      shove the rest of the dialog downward. */}
                  <p className={`tn-error${listenBad ? " is-shown" : ""}`}>
                    Enter a port from 1 to 65535
                  </p>
                </div>
              </div>

              <div className="tn-split tn-split--dest">
                <div>
                  <label className="tn-label">Destination host</label>
                  <div className={`tn-field${destHostBad ? " is-invalid" : ""}`}>
                    <input
                      className="mono"
                      value={destHost}
                      onChange={(e) => setDestHost(e.target.value)}
                      onBlur={splitDestHost}
                      placeholder="127.0.0.1"
                      aria-label="Destination host"
                      aria-invalid={destHostBad || undefined}
                    />
                  </div>
                  <p className={`tn-error${destHostBad ? " is-shown" : ""}`}>
                    Host only — the port goes in the next box
                  </p>
                </div>
                <div>
                  <label className="tn-label">Destination port</label>
                  <div className={`tn-field${destBad ? " is-invalid" : ""}`}>
                    <input
                      className="mono"
                      value={destPort}
                      onChange={(e) => setDestPort(e.target.value)}
                      inputMode="numeric"
                      placeholder="22"
                      aria-label="Destination port"
                      aria-invalid={destBad || undefined}
                    />
                  </div>
                  <p className={`tn-error${destBad ? " is-shown" : ""}`}>
                    Enter a port from 1 to 65535
                  </p>
                </div>
              </div>

              <label className="tn-label">Label (optional)</label>
              <div className="tn-field">
                <input
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="prod database"
                />
              </div>

              {type === "local" && (
                <label className="tn-expose">
                  <input
                    type="checkbox"
                    checked={exposed}
                    onChange={(e) => setExposed(e.target.checked)}
                  />
                  <span>
                    <strong>Let other machines on my network use this tunnel</strong>
                    <em>
                      Off by default. Leaving it off means only this computer can
                      reach the forwarded port — on shared wifi, that's the
                      difference between a private tunnel and an open one.
                    </em>
                  </span>
                </label>
              )}
            </div>

            <div className="dialog__foot">
              <button className="btn btn--secondary" onClick={() => setOpen(false)}>Cancel</button>
              <button
                className="btn btn--primary"
                disabled={!formValid || start.isPending}
                onClick={() => start.mutate()}
              >
                {start.isPending ? "Opening…" : "Open tunnel"}
              </button>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}
