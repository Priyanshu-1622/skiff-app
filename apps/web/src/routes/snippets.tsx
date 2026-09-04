import { useMemo, useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AppShell } from "@/components/shell";
import { apiGet, apiPost, apiPut } from "@/lib/api";
import { toast } from "@/lib/toast";
import * as I from "@/components/icons";
import "@/styles/snippets.css";

/**
 * Saved commands.
 *
 * Running one types it into an open session rather than executing it out of
 * band, so it lands in the scrollback and in the recording like anything else
 * the person typed. For a tool whose pitch is that it can show what happened,
 * a command that ran invisibly would be the wrong kind of convenience.
 */

interface Snippet {
  id: string;
  name: string;
  command: string;
  tags: string[];
  category: string | null;
  lastUsedAt: string | null;
  variables: string[];
}

interface GuardHit {
  id: string;
  severity: "critical" | "warning";
  title: string;
  detail: string;
  command: string;
}

export function SnippetsRoute() {
  const qc = useQueryClient();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [editing, setEditing] = useState<Snippet | "new" | null>(null);
  const [running, setRunning] = useState<Snippet | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [hostId, setHostId] = useState("");
  const [guard, setGuard] = useState<GuardHit | null>(null);
  // Deleting used to go through window.confirm(): a native OS dialog with no
  // styling, no snippet name in any readable form, and no way to see what the
  // command actually was before agreeing to lose it.
  const [deleting, setDeleting] = useState<Snippet | null>(null);

  const snippets = useQuery({ queryKey: ["snippets"], queryFn: () => apiGet<Snippet[]>("/api/snippets") });
  const hosts = useQuery({ queryKey: ["hosts"], queryFn: () => apiGet<any[]>("/api/hosts") });

  // Escape closes, matching every other dialog in the app.
  useEffect(() => {
    if (!(running || editing)) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); setRunning(null); setEditing(null); setGuard(null); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [running || editing]);

  const list = snippets.data ?? [];
  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of list) if (s.category) counts.set(s.category, (counts.get(s.category) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [list]);

  const q = query.trim().toLowerCase();
  const visible = list.filter(
    (s) =>
      (!category || s.category === category) &&
      (!q || s.name.toLowerCase().includes(q) || s.command.toLowerCase().includes(q)),
  );

  const del = useMutation({
    mutationFn: (id: string) => apiPost("/api/snippets/delete", { id }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["snippets"] });
      setDeleting(null);
    },
    onError: (e: any) =>
      toast.error("Couldn't delete that snippet", { description: e?.message }),
  });

  const run = useMutation({
    mutationFn: (vars: { confirmed?: boolean }) =>
      apiPost<any>("/api/snippets/run", {
        id: running!.id,
        hostId,
        values,
        confirmed: vars.confirmed,
      }),
    onSuccess: (res: any) => {
      if (res?.blocked) { setGuard(res.hit); return; }
      toast.success("Sent to the session");
      setRunning(null);
      setGuard(null);
      setValues({});
      qc.invalidateQueries({ queryKey: ["snippets"] });
    },
    onError: (e: any) => toast.error("Couldn't run that", { description: e?.message }),
  });

  const startRun = (s: Snippet) => {
    setRunning(s);
    setValues({});
    setGuard(null);
    // Deliberately not clearing hostId: running several snippets against the
    // same host is the common case, and re-picking it each time is friction.
    // Values and any guardrail state do reset, since those are per-snippet.
  };

  const ready = running ? running.variables.every((v) => (values[v] ?? "").trim()) : false;

  return (
    <AppShell
      title="skiff — snippets"
      sidebar={{}}
      toolbar={{
        searchValue: query,
        onSearchChange: setQuery,
        placeholder: "Search names and commands…",
        actions: (
          <button className="btn btn--primary" onClick={() => setEditing("new")}>
            <I.Plus size={12} />
            New snippet
          </button>
        ),
      }}
    >
      <div className="sn">
        <aside className="sn-cats">
          <button className={`sn-cat${!category ? " is-active" : ""}`} onClick={() => setCategory(null)}>
            <span>All snippets</span>
            <span className="n">{list.length}</span>
          </button>
          {categories.map(([name, count]) => (
            <button
              key={name}
              className={`sn-cat${category === name ? " is-active" : ""}`}
              onClick={() => setCategory(name)}
            >
              <span>{name}</span>
              <span className="n">{count}</span>
            </button>
          ))}
        </aside>

        <div className="sn-list">
          {visible.length === 0 ? (
            <div className="sn-empty">
              <I.Terminal size={28} />
              <p>{q || category ? "Nothing matches." : "No snippets yet."}</p>
              <p className="sn-empty__hint">
                Save the commands you retype — a log tail, a service restart. Use{" "}
                <code>{"{{name}}"}</code> for the parts that change.
              </p>
            </div>
          ) : (
            visible.map((s) => (
              <div key={s.id} className="sn-card">
                <div className="sn-card__head">
                  <span className="sn-card__name">{s.name}</span>
                  {s.variables.length > 0 && (
                    <span className="sn-vars">
                      {s.variables.length} {s.variables.length === 1 ? "var" : "vars"}
                    </span>
                  )}
                  <span className="sn-card__actions">
                    <button className="sn-icon" title="Edit" onClick={() => setEditing(s)}>
                      <I.Settings size={13} />
                    </button>
                    <button
                      className="sn-icon sn-icon--danger"
                      title="Delete"
                      onClick={() => setDeleting(s)}
                    >
                      <I.Trash size={13} />
                    </button>
                    <button className="btn btn--primary btn--sm" onClick={() => startRun(s)}>
                      <I.Play size={11} />
                      Run
                    </button>
                  </span>
                </div>

                <pre className="sn-cmd">
                  {s.command.split(/(\{\{\s*[A-Za-z0-9_-]+\s*\}\})/g).map((part, i) =>
                    /^\{\{/.test(part)
                      ? <span key={i} className="sn-var">{part}</span>
                      : <span key={i}>{part}</span>,
                  )}
                </pre>

                <div className="sn-card__foot">
                  {s.tags.map((t) => <span key={t} className="sn-tag">{t}</span>)}
                  {s.category && <span className="sn-tag">{s.category}</span>}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* ── Run ── */}
      {running && (
        <div className="dialog-overlay" onClick={(e) => { if (e.target === e.currentTarget) setRunning(null); }}>
          <div className="dialog sn-dialog" role="dialog" aria-label={`Run ${running.name}`}>
            <div className="dialog__head"><h2>Run “{running.name}”</h2></div>

            <div className="sn-run">
              {guard ? (
                <>
                  {/* Same warning as typing it by hand. A snippet is a command
                      people pass around, so this is the one that matters most. */}
                  <div className={`sn-guard is-${guard.severity}`}>
                    <I.Warn size={16} />
                    <div>
                      <strong>{guard.title}</strong>
                      <p>{guard.detail}</p>
                    </div>
                  </div>
                  <pre className="sn-preview">{guard.command}</pre>
                </>
              ) : (
                <>
                  <label className="sn-label">Host</label>
                  <div className="sn-field">
                    <select value={hostId} onChange={(e) => setHostId(e.target.value)}>
                      <option value="">Choose a connected host…</option>
                      {(hosts.data ?? []).map((h: any) => (
                        <option key={h.id} value={h.id}>{h.label || h.hostname}</option>
                      ))}
                    </select>
                  </div>

                  {running.variables.map((v) => (
                    <div key={v}>
                      <label className="sn-label">{v}</label>
                      <div className="sn-field">
                        <input
                          className="mono"
                          value={values[v] ?? ""}
                          onChange={(e) => setValues({ ...values, [v]: e.target.value })}
                          autoFocus={v === running.variables[0]}
                        />
                      </div>
                    </div>
                  ))}

                  <label className="sn-label">Will run</label>
                  <pre className="sn-preview">
                    {running.command.replace(
                      /\{\{\s*([A-Za-z0-9_-]+)\s*\}\}/g,
                      (whole, name) => values[name]?.trim() || whole,
                    )}
                  </pre>
                </>
              )}
            </div>

            <div className="dialog__foot">
              <button className="btn btn--secondary" onClick={() => { setRunning(null); setGuard(null); }}>
                Cancel
              </button>
              <button
                className={`btn ${guard?.severity === "critical" ? "btn--danger" : "btn--primary"}`}
                disabled={!hostId || (!guard && !ready) || run.isPending}
                onClick={() => run.mutate({ confirmed: !!guard })}
              >
                {run.isPending ? "Sending…" : guard ? "Run it anyway" : "Run"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Delete ── */}
      {deleting && (
        <div
          className="dialog-overlay"
          onClick={(e) => { if (e.target === e.currentTarget) setDeleting(null); }}
        >
          <div className="dialog sn-dialog" role="dialog" aria-label={`Delete ${deleting.name}`}>
            <div className="dialog__head"><h2>Delete “{deleting.name}”?</h2></div>

            <div className="sn-run">
              <p className="sn-confirm__text">
                This snippet is removed for good. Nothing that has already run is
                affected — the audit log keeps its own record.
              </p>
              {/* What is actually being lost. A name alone is not enough to
                  decide by when several snippets do similar things. */}
              <label className="sn-label">Command</label>
              <pre className="sn-preview">{deleting.command}</pre>
            </div>

            <div className="dialog__foot">
              <button className="btn btn--secondary" onClick={() => setDeleting(null)}>
                Cancel
              </button>
              <button
                className="btn btn--danger"
                disabled={del.isPending}
                onClick={() => del.mutate(deleting.id)}
              >
                {del.isPending ? "Deleting…" : "Delete snippet"}
              </button>
            </div>
          </div>
        </div>
      )}

      {editing && (
        <SnippetEditor
          snippet={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); qc.invalidateQueries({ queryKey: ["snippets"] }); }}
        />
      )}
    </AppShell>
  );
}

function SnippetEditor({
  snippet,
  onClose,
  onSaved,
}: {
  snippet: Snippet | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(snippet?.name ?? "");
  const [command, setCommand] = useState(snippet?.command ?? "");
  const [category, setCategory] = useState(snippet?.category ?? "");
  const [tags, setTags] = useState((snippet?.tags ?? []).join(", "));

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name,
        command,
        category: category || null,
        tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
      };
      return snippet
        ? apiPut("/api/snippets", { ...body, id: snippet.id })
        : apiPost("/api/snippets", body);
    },
    onSuccess: onSaved,
    onError: (e: any) => toast.error("Couldn't save", { description: e?.message }),
  });

  const vars = [...command.matchAll(/\{\{\s*([A-Za-z0-9_-]+)\s*\}\}/g)].map((m) => m[1]);

  return (
    <div className="dialog-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog sn-dialog" role="dialog">
        <div className="dialog__head"><h2>{snippet ? "Edit snippet" : "New snippet"}</h2></div>

        <div className="sn-run">
          <label className="sn-label">Name</label>
          <div className="sn-field">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Tail app logs" autoFocus />
          </div>

          <label className="sn-label">Command</label>
          <textarea
            className="sn-textarea mono"
            rows={4}
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            placeholder="tail -f /var/log/app/api.log"
          />
          <p className="sn-hint">
            Use <code>{"{{name}}"}</code> for parts that change — you'll be asked
            for them each time.
            {vars.length > 0 && <> Found: {vars.map((v) => <code key={v}>{v}</code>)}</>}
          </p>

          <div className="sn-split">
            <div>
              <label className="sn-label">Category</label>
              <div className="sn-field">
                <input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Ops" />
              </div>
            </div>
            <div>
              <label className="sn-label">Tags</label>
              <div className="sn-field">
                <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="logs, systemd" />
              </div>
            </div>
          </div>
        </div>

        <div className="dialog__foot">
          <button className="btn btn--secondary" onClick={onClose}>Cancel</button>
          <button
            className="btn btn--primary"
            disabled={!name.trim() || !command.trim() || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
