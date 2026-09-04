import { useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMutation } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { StatusRail } from "@/components/shell";
import { useVault } from "@/lib/vault";
import { apiGet, apiPost, apiPut } from "@/lib/api";
import { toast } from "@/lib/toast";
import * as I from "@/components/icons";

/** What `approvals:policy` returns: the stored policy plus whether this vault
    can have one at all. */
interface ApprovalPolicyView {
  enabled: boolean;
  tags: string[];
  requestTtlMinutes: number;
  grantMinutes: number;
  supported: boolean;
}

type Section =
  | "security" | "approvals" | "import" | "backup" | "updates" | "about" | "team";

// Must list every Section. A missing entry silently falls back to
// "security", which is how #import used to land on the wrong pane.
const SECTIONS: Section[] = [
  "security", "approvals", "import", "backup", "updates", "about", "team",
];

function readSectionFromHash(): Section {
  if (typeof window === "undefined") return "security";
  const h = window.location.hash.replace("#", "");
  return (SECTIONS.includes(h as Section) ? h : "security") as Section;
}

export function SettingsRoute() {
  const navigate = useNavigate();
  const { status } = useVault();

  // The router owns the hash. Reading window.location directly races with
  // navigation — navigate() rewrites the URL, so a hash set just before it is
  // gone by the time this mounts, and every deep link fell back to Security.
  const routerHash = useRouterState({
    select: (s) => s.location.hash.replace("#", ""),
  });

  const [section, setSection] = useState<Section>(readSectionFromHash);

  useEffect(() => {
    if (routerHash && SECTIONS.includes(routerHash as Section)) {
      setSection(routerHash as Section);
    }
  }, [routerHash]);

  // Back/forward outside the router still moves the hash.
  useEffect(() => {
    const onHash = () => setSection(readSectionFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // Sync section → hash so the URL reflects the current section
  useEffect(() => {
    if (window.location.hash.replace("#", "") !== section) {
      window.history.replaceState(null, "", `#${section}`);
    }
  }, [section]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") navigate({ to: "/" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);

  const nav = [
    { id: "security" as Section, label: "Security", icon: <I.Lock size={14} /> },
    // Approvals are a team-only feature, and the Approvals screen has always
    // told people to "turn them on in Settings" — where, until now, there was
    // nothing to turn on.
    ...(status?.mode === "team"
      ? [{ id: "approvals" as Section, label: "Approvals", icon: <I.Check size={14} /> }]
      : []),
    { id: "import"   as Section, label: "Import",   icon: <I.ArrowRight size={14} /> },
    { id: "backup"   as Section, label: "Backup",   icon: <I.Server size={14} /> },
    { id: "updates"  as Section, label: "Updates",  icon: <I.Refresh size={14} /> },
    { id: "about"    as Section, label: "About",    icon: <I.Info size={14} /> },
    // Only offer the team upgrade from a personal vault.
    ...(status?.mode === "personal"
      ? [{ id: "team" as Section, label: "Team", icon: <I.Users size={14} /> }]
      : []),
  ];

  return (
    <div className="app settings">
      {/* Settings subnav */}
      <nav className="settings-subnav">
        <button
          type="button"
          className="settings-back"
          onClick={() => navigate({ to: "/" })}
          title="Back to hosts (Esc)"
        >
          <I.ChevronLeft size={13} />
          Back
        </button>
        <div className="settings-subnav__title">Settings</div>
        {nav.map(n => (
          <button
            key={n.id}
            className="subnav-item"
            aria-current={section === n.id ? "true" : undefined}
            onClick={() => setSection(n.id)}
            style={{ background: "none", border: 0, width: "100%", textAlign: "left" }}
          >
            <span className="icon">{n.icon}</span>
            {n.label}
          </button>
        ))}
        <div className="foot">
          <span>v0.3.0</span>
          <span>AGPL-3.0</span>
        </div>
      </nav>

      {/* Content pane */}
      <div className="settings-pane">
        <div className="settings-pane__scroll">
          <div className="settings-pane__inner">
            {section === "security" && <SecuritySection />}
            {section === "approvals" && <ApprovalsSection />}
            {section === "import"   && <ImportSection />}
            {section === "backup"   && <BackupSection />}
            {section === "updates"  && <UpdatesSection />}
            {section === "about"    && <AboutSection />}
            {section === "team"     && <TeamUpgradeSection />}
          </div>
        </div>
      </div>
      <StatusRail />
    </div>
  );
}

function SecuritySection() {
  const { status, fetchStatus } = useVault();
  const [currentPw, setCurrentPw] = useState("");
  const [device, setDevice] = useState<{ available: boolean; enabled: boolean; biometric: boolean } | null>(null);
  const [deviceBusy, setDeviceBusy] = useState(false);

  useEffect(() => {
    apiGet<any>("/api/keychain").then(setDevice).catch(() => setDevice(null));
  }, []);

  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  // Seeded from the stored value, not a literal. This was `useState("15")`, so
  // the field showed 15 on every mount no matter what was actually saved — a
  // vault set to lock after 1 minute reported 15. The toggle directly below
  // reads `status.recordingEnabled`; this was the one control not doing it.
  //
  // Re-seeded whenever the *stored* number changes, which covers arriving
  // after status has loaded and refreshing after a save. Typing does not move
  // the stored value, so it cannot fight the field mid-edit.
  const storedTimeout = status?.idleTimeoutMinutes;
  const [timeout, setTimeout_] = useState(() => String(storedTimeout ?? 15));
  useEffect(() => {
    if (storedTimeout != null) setTimeout_(String(storedTimeout));
  }, [storedTimeout]);

  const recordingOn = !!status?.recordingEnabled;
  const toggleRecording = useMutation({
    mutationFn: (enabled: boolean) => apiPut("/api/settings/recording", { enabled }),
    onSuccess: (_d, enabled) => {
      toast.success(enabled ? "Session recording enabled" : "Session recording disabled");
      fetchStatus();
    },
    onError: (e: any) => toast.error("Couldn't update recording", { description: e.message }),
  });

  const guardrailsOn = !!(status as any)?.guardrailsEnabled;
  const toggleGuardrails = useMutation({
    mutationFn: (enabled: boolean) => apiPut("/api/settings/guardrails", { enabled }),
    onSuccess: (_d, enabled) => {
      toast.success(enabled ? "Guardrails enabled" : "Guardrails disabled");
      fetchStatus();
    },
    onError: (e: any) => toast.error("Couldn't update guardrails", { description: e.message }),
  });

  const trayOn = (status as any)?.trayEnabled !== false;
  const toggleTray = useMutation({
    mutationFn: (enabled: boolean) => apiPut("/api/settings/tray", { enabled }),
    onSuccess: (_d, enabled) => {
      toast.success(enabled ? "Tray enabled" : "Tray disabled", {
        description: "Restart Skiff for this to take effect.",
      });
      fetchStatus();
    },
    onError: (e: any) => toast.error("Couldn't update that", { description: e.message }),
  });

  const changePw = useMutation({
    mutationFn: () => apiPut("/api/settings/password", { currentPassword: currentPw, newPassword: newPw }),
    onSuccess: () => {
      toast.success("Password changed", { description: "All credentials have been re-encrypted." });
      setCurrentPw(""); setNewPw(""); setConfirmPw("");
    },
    onError: (e: any) => toast.error("Couldn't change password", { description: e.message }),
  });

  const timeoutNum = parseInt(timeout, 10);
  const timeoutValid = Number.isFinite(timeoutNum) && timeoutNum >= 1 && timeoutNum <= 1440;

  const saveTimeout = useMutation({
    mutationFn: () => apiPut("/api/settings/idle-timeout", { minutes: timeoutNum }),
    onSuccess: () => {
      toast.success(`Idle timeout set to ${timeoutNum} min`);
      // So the field is showing the stored value, not merely what was typed.
      void fetchStatus();
    },
    onError: (e: any) => toast.error("Couldn't save timeout", { description: e.message }),
  });

  return (
    <>
      <div className="settings-pane__head">
        <h1 className="settings-pane__h1">Security</h1>
        <p className="settings-pane__sub">Manage your master password and automatic lock behaviour.</p>
      </div>

      <div className="s-section">
        <div className="s-section__head">
          <div className="s-section__title">System tray</div>
        </div>
        <div className="s-section__body">
          <div className="s-row">
            <div>
              <div className="s-row__label">Keep running when the window closes</div>
              <div className="s-row__desc">
                Skiff stays in the tray so your sessions survive. Closing the
                window mid-command would otherwise end that command. Quit from
                the tray icon to close it properly. Takes effect next launch.
              </div>
            </div>
            <button
              className={`btn ${trayOn ? "btn--danger" : "btn--secondary"}`}
              disabled={toggleTray.isPending}
              onClick={() => toggleTray.mutate(!trayOn)}
            >
              {trayOn ? "Turn off" : "Turn on"}
            </button>
          </div>
        </div>
      </div>

      <div className="s-section">
        <div className="s-section__head">
          <div className="s-section__title">Command guardrails</div>
        </div>
        <div className="s-section__body">
          <div className="s-row">
            <div>
              <div className="s-row__label">Confirm dangerous commands</div>
              <div className="s-row__desc">
                Pauses a short list of irreversible commands — recursive deletes
                from root, formatting a disk, fork bombs, piping the internet
                into a shell — and asks you to confirm. It's a speed bump, not a
                block: you can always run the command, and the decision is
                recorded in the audit log.
              </div>
            </div>
            <button
              className={`btn ${guardrailsOn ? "btn--danger" : "btn--secondary"}`}
              disabled={toggleGuardrails.isPending}
              onClick={() => toggleGuardrails.mutate(!guardrailsOn)}
            >
              {guardrailsOn ? "Turn off" : "Turn on"}
            </button>
          </div>
        </div>
      </div>

      <div className="s-section">
        <div className="s-section__head">
          <div className="s-section__title">Unlock on this device</div>
        </div>
        <div className="s-section__body">
          <div className="s-row">
            <div>
              <div className="s-row__label">
                {device?.biometric ? "Unlock with Touch ID" : "Skip the password on this device"}
              </div>
              <div className="s-row__desc">
                {device && !device.available
                  ? "This device has no secure store available, so the key can't be protected."
                  : device?.enabled
                    ? "Your vault key is stored by the operating system. Anyone who can sign in to this computer as you can open the vault."
                    : "Stores your vault key in the operating system's secure store so you don't retype your password. It trades some security for convenience — the OS account becomes the lock."}
              </div>
            </div>
            <button
              className={`btn ${device?.enabled ? "btn--danger" : "btn--secondary"}`}
              disabled={!device?.available || deviceBusy}
              onClick={async () => {
                setDeviceBusy(true);
                try {
                  await apiPost(device?.enabled ? "/api/keychain/disable" : "/api/keychain/enable", {});
                  const next = await apiGet<any>("/api/keychain");
                  setDevice(next);
                  toast.success(next.enabled ? "Password-free unlock enabled" : "Stored key removed");
                } catch (e: any) {
                  toast.error(e?.message || "Couldn't change this setting");
                } finally {
                  setDeviceBusy(false);
                }
              }}
            >
              {deviceBusy ? "Working…" : device?.enabled ? "Turn off" : "Turn on"}
            </button>
          </div>
        </div>
      </div>

      <div className="s-section">
        <div className="s-section__head">
          <div className="s-section__title">Master password</div>
        </div>
        <div className="s-section__body">
          <div className="s-row stacked">
            <div>
              <div className="s-row__label">Change password</div>
              <div className="s-row__desc">Re-encrypts all stored credentials with your new password.</div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 400 }}>
              <input className="field input" type="password" placeholder="Current password" value={currentPw} onChange={e => setCurrentPw(e.target.value)}
                style={{ background: "var(--bg-2)", border: "1px solid var(--border-strong)", borderRadius: 6, padding: "7px 10px", color: "var(--fg-0)", font: "400 13px/1 var(--font-sans)", outline: "none" }} />
              <input className="field input" type="password" placeholder="New password" value={newPw} onChange={e => setNewPw(e.target.value)}
                style={{ background: "var(--bg-2)", border: "1px solid var(--border-strong)", borderRadius: 6, padding: "7px 10px", color: "var(--fg-0)", font: "400 13px/1 var(--font-sans)", outline: "none" }} />
              <input className="field input" type="password" placeholder="Confirm new password" value={confirmPw} onChange={e => setConfirmPw(e.target.value)}
                style={{ background: "var(--bg-2)", border: "1px solid var(--border-strong)", borderRadius: 6, padding: "7px 10px", color: "var(--fg-0)", font: "400 13px/1 var(--font-sans)", outline: "none" }} />
              <button className="btn btn--primary" style={{ alignSelf: "flex-start" }}
                onClick={() => {
                  if (newPw !== confirmPw) { toast.error("Passwords don't match"); return; }
                  if (newPw.length < 8) { toast.error("Use at least 8 characters"); return; }
                  changePw.mutate();
                }}
                disabled={changePw.isPending || !currentPw || !newPw}
              >
                {changePw.isPending ? "Changing…" : "Change password"}
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="s-section" style={{ marginTop: 14 }}>
        <div className="s-section__head">
          <div className="s-section__title">Auto-lock</div>
        </div>
        <div className="s-section__body">
          <div className="s-row">
            <div>
              <div className="s-row__label">Idle timeout</div>
              <div className="s-row__desc">Lock the vault automatically after this many minutes of inactivity.</div>
            </div>
            <div className="s-row__control" style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input type="number" min={1} max={1440} value={timeout} onChange={e => setTimeout_(e.target.value)}
                style={{ width: 64, background: "var(--bg-2)", border: "1px solid var(--border-strong)", borderRadius: 6, padding: "5px 8px", color: "var(--fg-0)", fontFamily: "var(--font-mono)", fontSize: 13, outline: "none", textAlign: "right" }} />
              <span style={{ fontSize: 12, color: "var(--fg-2)" }}>min</span>
              <button className="btn btn--secondary" style={{ height: 28, padding: "0 10px", fontSize: 12 }} disabled={!timeoutValid || saveTimeout.isPending} onClick={() => saveTimeout.mutate()}>Save</button>
            </div>
          </div>
        </div>
      </div>

      <div className="s-section" style={{ marginTop: 14 }}>
        <div className="s-section__head">
          <div className="s-section__title">Session recording</div>
        </div>
        <div className="s-section__body">
          <div className="s-row">
            <div>
              <div className="s-row__label">Record terminal sessions</div>
              <div className="s-row__desc">
                Save a replayable recording of each SSH session to your server, in the
                open asciicast format.{status?.mode === "team" ? " In team mode, admins can review any member's sessions." : ""} View them under Recordings.
              </div>
            </div>
            <div className="s-row__control">
              <button
                role="switch"
                aria-checked={recordingOn}
                className={"s-toggle" + (recordingOn ? " s-toggle--on" : "")}
                disabled={toggleRecording.isPending}
                onClick={() => toggleRecording.mutate(!recordingOn)}
              >
                <span className="s-toggle__knob" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

/**
 * Break-glass approvals.
 *
 * The engine, the IPC channel and `PUT /api/approvals/policy` all existed; no
 * screen ever called them, so the policy could not be turned on from the app at
 * all — while the Approvals screen told people to "turn them on in Settings".
 * This is that control.
 *
 * Admin-gated and team-only, matching `approvals:setPolicy`, which refuses both
 * cases server-side anyway. The pane says why rather than showing a dead switch.
 */
function ApprovalsSection() {
  const qc = useQueryClient();
  const { status } = useVault();
  const isAdmin = !!status?.user?.isAdmin;
  const [tagDraft, setTagDraft] = useState("");

  const policy = useQuery({
    queryKey: ["approvals", "policy"],
    queryFn: () => apiGet<ApprovalPolicyView>("/api/approvals/policy"),
  });
  const current = policy.data;
  const tags = current?.tags ?? [];

  const save = useMutation({
    mutationFn: (next: Partial<ApprovalPolicyView>) =>
      apiPut("/api/approvals/policy", {
        enabled: current?.enabled ?? false,
        tags: current?.tags ?? [],
        requestTtlMinutes: current?.requestTtlMinutes ?? 15,
        grantMinutes: current?.grantMinutes ?? 30,
        ...next,
      }),
    // The sidebar badge and the Approvals screen both read this.
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["approvals"] });
      toast.success("Approval policy saved");
    },
    onError: (e: any) => toast.error("Couldn't save policy", { description: e.message }),
  });

  if (policy.isLoading) {
    return (
      <div className="s-section">
        <div className="s-section__body" style={{ color: "var(--fg-2)" }}>Loading…</div>
      </div>
    );
  }
  if (policy.isError) {
    return (
      <div className="s-section">
        <div className="s-section__body" style={{ color: "var(--status-error)" }}>
          Couldn't load the approval policy:{" "}
          {(policy.error as any)?.message ?? "unknown error"}
        </div>
      </div>
    );
  }

  const locked = !current?.supported || !isAdmin;
  const lockReason = !current?.supported
    ? "Approvals need a second person to sign off, so they're only available in team vaults."
    : "Only admins can change the approval policy.";

  return (
    <>
      <div className="settings-pane__head">
        <h1 className="settings-pane__h1">Approvals</h1>
        <p className="settings-pane__sub">
          Require a second person to sign off before anyone reaches a tagged host. The
          request, the decision, and the window it opens are all recorded.
        </p>
      </div>

      {locked && (
        <div className="s-section" style={{ marginBottom: 14 }}>
          <div className="s-section__body" style={{ fontSize: 13, color: "var(--fg-1)" }}>
            {lockReason}
          </div>
        </div>
      )}

      <div className="s-section">
        <div className="s-section__head">
          <div className="s-section__title">Break-glass approvals</div>
        </div>
        <div className="s-section__body">
          <div className="s-row">
            <div>
              <div className="s-row__label">Require approval for tagged hosts</div>
              <div className="s-row__desc">
                Connecting to a host carrying one of the tags below blocks and raises a
                request. Nobody can approve their own.
              </div>
            </div>
            <div className="s-row__control">
              <button
                role="switch"
                aria-checked={!!current?.enabled}
                className={"s-toggle" + (current?.enabled ? " s-toggle--on" : "")}
                disabled={locked || save.isPending}
                onClick={() => save.mutate({ enabled: !current?.enabled })}
              >
                <span className="s-toggle__knob" />
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="s-section" style={{ marginTop: 14 }}>
        <div className="s-section__head">
          <div className="s-section__title">Gated tags</div>
        </div>
        <div className="s-section__body">
          <div className="s-row__desc" style={{ marginBottom: 10 }}>
            Gating on tags rather than a per-host flag means the rule survives hosts being
            added later — import twenty machines tagged <code>prod</code> and they are all
            covered without anyone remembering to tick a box.
          </div>
          <div className="hf-tags">
            {tags.map((t) => (
              <span
                className={`hf-tag${t.toLowerCase() === "prod" ? " is-prod" : ""}`}
                key={t}
              >
                {t}
                <button
                  type="button"
                  aria-label={`Remove ${t}`}
                  disabled={locked}
                  onClick={() => save.mutate({ tags: tags.filter((x) => x !== t) })}
                >
                  <I.Close size={9} />
                </button>
              </span>
            ))}
            <input
              className="hf-tag-input mono"
              value={tagDraft}
              disabled={locked}
              placeholder={tags.length ? "Add tag…" : "prod"}
              spellCheck={false}
              onChange={(e) => setTagDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === ",") {
                  e.preventDefault();
                  const v = tagDraft.trim().toLowerCase();
                  setTagDraft("");
                  if (v && !tags.includes(v)) save.mutate({ tags: [...tags, v] });
                } else if (e.key === "Backspace" && !tagDraft && tags.length) {
                  save.mutate({ tags: tags.slice(0, -1) });
                }
              }}
            />
          </div>
        </div>
      </div>

      <div className="s-section" style={{ marginTop: 14 }}>
        <div className="s-section__head">
          <div className="s-section__title">Timings</div>
        </div>
        <div className="s-section__body">
          <div className="s-row">
            <div>
              <div className="s-row__label">Request stays open</div>
              <div className="s-row__desc">
                How long an unanswered request can still be answered for.
              </div>
            </div>
            <div className="s-row__control">
              <MinutesBox
                value={current?.requestTtlMinutes ?? 15}
                disabled={locked}
                onCommit={(v) => save.mutate({ requestTtlMinutes: v })}
              />
            </div>
          </div>
          <div className="s-row">
            <div>
              <div className="s-row__label">Granted access lasts</div>
              <div className="s-row__desc">
                An approval opens a window, not a single connection — reconnecting after a
                dropped link inside it does not need a fresh signature.
              </div>
            </div>
            <div className="s-row__control">
              <MinutesBox
                value={current?.grantMinutes ?? 30}
                disabled={locked}
                onCommit={(v) => save.mutate({ grantMinutes: v })}
              />
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

/** A minutes field that commits only a valid number, on blur or Enter. */
function MinutesBox({
  value,
  disabled,
  onCommit,
}: {
  value: number;
  disabled?: boolean;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);

  const commit = () => {
    const n = Number(draft);
    // Out of range puts back what was there rather than saving nonsense.
    if (!Number.isInteger(n) || n < 1 || n > 1440) {
      setDraft(String(value));
      return;
    }
    if (n !== value) onCommit(n);
  };

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <input
        className="mono"
        inputMode="numeric"
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        style={{
          width: 64,
          background: "var(--bg-2)",
          border: "1px solid var(--border-strong)",
          borderRadius: 6,
          padding: "6px 8px",
          color: "var(--fg-0)",
          fontFamily: "var(--font-mono)",
          fontSize: 13,
          textAlign: "right",
        }}
      />
      <span style={{ fontSize: 12, color: "var(--fg-2)" }}>min</span>
    </span>
  );
}

function ImportSection() {
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<any[]>([]);
  const [parseMsg, setParseMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const parse = async () => {
    try {
      const d = await apiPost<{ hosts: any[] }>("/api/import/parse", { configText: text });
      setPreview(d.hosts);
      setParseMsg(`Found ${d.hosts.length} host${d.hosts.length !== 1 ? "s" : ""}`);
      if (d.hosts.length === 0) {
        toast.warning("No hosts found", { description: "Check that your config has Host entries." });
      }
    } catch (e: any) {
      setParseMsg("");
      toast.error("Couldn't parse config", { description: e.message });
    }
  };

  const apply = async () => {
    setBusy(true);
    try {
      const d = await apiPost<{ imported: number }>("/api/import/apply", {
        configText: text,
        selectedHosts: preview.map(h => h.alias),
      });
      toast.success(`Imported ${d.imported} host${d.imported !== 1 ? "s" : ""}`, {
        description: "They're in your host list now.",
      });
      setPreview([]); setText(""); setParseMsg("");
    } catch (e: any) {
      toast.error("Import failed", { description: e.message });
    }
    finally { setBusy(false); }
  };

  return (
    <>
      <div className="settings-pane__head">
        <h1 className="settings-pane__h1">Import hosts</h1>
        <p className="settings-pane__sub">Paste the contents of your <span style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>~/.ssh/config</span> below. Skiff will parse it and create hosts for each entry.</p>
      </div>

      <div className="s-section">
        <div className="s-section__head"><div className="s-section__title">SSH config</div></div>
        <div className="s-section__body">
          <textarea value={text} onChange={e => setText(e.target.value)} rows={12}
            placeholder={"Host production\n  HostName 10.0.0.5\n  User deploy\n  Port 22\n\nHost staging\n  HostName staging.example.com\n  User ubuntu"}
            style={{ width: "100%", boxSizing: "border-box", background: "var(--bg-2)", border: "1px solid var(--border-strong)", borderRadius: 7, padding: "10px 12px", color: "var(--fg-0)", fontFamily: "var(--font-mono)", fontSize: 12, lineHeight: 1.6, outline: "none", resize: "vertical" }}
          />
          <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "center" }}>
            <button className="btn btn--primary" onClick={parse} disabled={!text.trim()}>Parse config</button>
            {parseMsg && <span style={{ fontSize: 12, color: "var(--fg-2)" }}>{parseMsg}</span>}
          </div>

          {preview.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <div style={{ marginBottom: 8, fontSize: 12, color: "var(--fg-1)" }}>Hosts to import:</div>
              <div style={{ border: "1px solid var(--border)", borderRadius: 7, overflow: "hidden" }}>
                {preview.map((h, i) => (
                  <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 1fr 80px", gap: 16, padding: "10px 14px", borderTop: i ? "1px solid var(--border)" : undefined, fontSize: 12, fontFamily: "var(--font-mono)" }}>
                    <span style={{ color: "var(--fg-0)" }}>{h.alias}</span>
                    <span style={{ color: "var(--fg-1)" }}>{h.hostname || h.alias}:{h.port || 22}</span>
                    <span style={{ color: "var(--fg-2)" }}>{h.user || "root"}</span>
                  </div>
                ))}
              </div>
              <button className="btn btn--primary" style={{ marginTop: 10 }} onClick={apply} disabled={busy}>
                {busy ? "Importing…" : `Import all ${preview.length} hosts`}
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function BackupSection() {
  const download = async () => {
    try {
      const data = await apiGet("/api/settings/backup");
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `skiff-backup-${new Date().toISOString().split("T")[0]}.json`;
      a.click(); URL.revokeObjectURL(url);
      toast.success("Backup downloaded", { description: "Store it somewhere safe — it's encrypted but it's all you've got if you forget your password." });
    } catch (e: any) {
      toast.error("Backup failed", { description: e.message });
    }
  };

  return (
    <>
      <div className="settings-pane__head">
        <h1 className="settings-pane__h1">Backup & Export</h1>
        <p className="settings-pane__sub">Download an encrypted backup of your entire vault. Credentials remain encrypted — only decryptable with your master password.</p>
      </div>
      <div className="s-section">
        <div className="s-section__body" style={{ paddingTop: 14 }}>
          <div className="s-row">
            <div>
              <div className="s-row__label">Download vault backup</div>
              <div className="s-row__desc">Exports hosts, folders, and encrypted credentials as a JSON file.</div>
            </div>
            <div className="s-row__control">
              <button className="btn btn--primary" onClick={download}>Download backup</button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function AboutSection() {
  return (
    <>
      <div className="settings-pane__head">
        <h1 className="settings-pane__h1">About Skiff</h1>
        <p className="settings-pane__sub">Self-hosted SSH connection manager. Open-source Termius alternative.</p>
      </div>
      <div className="s-section">
        <div className="s-section__body" style={{ paddingTop: 14 }}>
          {[
            ["Version", "0.3.0"],
            ["License", "AGPL-3.0"],
            ["Stack", "React + Fastify + SQLite"],
            ["Encryption", "AES-256-GCM + argon2id"],
          ].map(([k, v]) => (
            <div key={k} className="s-row">
              <div className="s-row__label">{k}</div>
              <div className="s-row__control" style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg-1)" }}>{v}</div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function TeamUpgradeSection() {
  const navigate = useNavigate();
  const { fetchStatus } = useVault();
  const [currentPassword, setCurrentPassword] = useState("");
  const [adminUsername, setAdminUsername] = useState("");
  const [confirm, setConfirm] = useState(false);

  const upgrade = useMutation({
    mutationFn: () => apiPost("/api/settings/upgrade-team", { currentPassword, adminUsername }),
    onSuccess: async () => {
      toast.success("Upgraded to team mode");
      await fetchStatus();
      navigate({ to: "/admin" });
    },
    onError: (e: any) => toast.error("Upgrade failed", { description: e.message }),
  });

  return (
    <>
      <div className="settings-pane__head">
        <h1 className="settings-pane__h1">Upgrade to Team</h1>
        <p className="settings-pane__sub">Convert this personal vault into a multi-user team vault. Your hosts and credentials are kept exactly as they are.</p>
      </div>

      <div className="s-section">
        <div className="s-section__head">
          <div className="s-section__title">What happens</div>
        </div>
        <div className="s-section__body" style={{ paddingTop: 12, fontSize: 13, color: "var(--fg-1)", lineHeight: 1.6 }}>
          Your current account becomes the first admin. You'll sign in with a username and your existing password from now on. You can then invite team members, who each get their own login, and review an audit log of all activity. This can't be undone, so export a backup first if you want one.
        </div>
      </div>

      <div className="s-section" style={{ marginTop: 14 }}>
        <div className="s-section__head">
          <div className="s-section__title">Create the first admin</div>
        </div>
        <div className="s-section__body" style={{ paddingTop: 12 }}>
          <div className="field" style={{ marginBottom: 12 }}>
            <label style={{ display: "block", fontSize: 12, color: "var(--fg-2)", marginBottom: 6 }}>Admin username</label>
            <input
              className="mono"
              value={adminUsername}
              onChange={(e) => setAdminUsername(e.target.value)}
              placeholder="admin"
              spellCheck={false}
              style={{ width: "100%", maxWidth: 280, background: "var(--bg-2)", border: "1px solid var(--border-strong)", borderRadius: 6, padding: "8px 10px", color: "var(--fg-0)", fontFamily: "var(--font-mono)", fontSize: 13 }}
            />
          </div>
          <div className="field" style={{ marginBottom: 12 }}>
            <label style={{ display: "block", fontSize: 12, color: "var(--fg-2)", marginBottom: 6 }}>Confirm with your current master password</label>
            <input
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              placeholder="Current password"
              style={{ width: "100%", maxWidth: 280, background: "var(--bg-2)", border: "1px solid var(--border-strong)", borderRadius: 6, padding: "8px 10px", color: "var(--fg-0)", fontSize: 13 }}
            />
          </div>

          <label style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 12.5, color: "var(--fg-1)", cursor: "pointer", marginBottom: 14, maxWidth: 420 }}>
            <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} style={{ marginTop: 2 }} />
            <span>I understand this converts the vault to team mode and can't be undone.</span>
          </label>

          <button
            className="btn btn--primary"
            disabled={!adminUsername || !currentPassword || !confirm || upgrade.isPending}
            onClick={() => upgrade.mutate()}
          >
            {upgrade.isPending ? "Upgrading…" : "Upgrade to team mode"}
          </button>
        </div>
      </div>
    </>
  );
}

/**
 * Updates.
 *
 * Shows the real state rather than a button that always says "Check". In a dev
 * build there's no update feed at all, and saying so is more useful than a
 * check that silently does nothing.
 */
function UpdatesSection() {
  const [info, setInfo] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  const refresh = () => apiGet<any>("/api/updates").then(setInfo).catch(() => setInfo(null));
  useEffect(() => {
    void refresh();
    const unsub = (window as any).skiff?.on?.("app:updateStatus", (s: any) =>
      setInfo((prev: any) => ({ ...(prev ?? {}), ...s })),
    );
    return () => unsub?.();
  }, []);

  const state = info?.state ?? "idle";
  const label =
    state === "checking" ? "Checking…"
    : state === "downloading" ? `Downloading… ${info?.progress ?? 0}%`
    : state === "ready" ? `Version ${info?.version} is ready to install`
    : state === "available" ? `Version ${info?.version} found`
    : state === "current" ? "Skiff is up to date"
    : state === "disabled" ? "Update checks are turned off"
    : info?.message ?? "Not checked yet";

  return (
    <>
      <div className="s-section">
        <div className="s-section__head">
          <div className="s-section__title">Updates</div>
        </div>
        <div className="s-section__body">
          <div className="s-row">
            <div>
              <div className="s-row__label">{label}</div>
              <div className="s-row__desc">
                You're running version {info?.currentVersion ?? "—"}. Updates are
                downloaded in the background and installed when you quit — never
                mid-session, because restarting would end your live connections.
              </div>
            </div>
            {state === "ready" ? (
              <button
                className="btn btn--primary"
                onClick={() => apiPost("/api/updates/install", {})}
              >
                Restart and install
              </button>
            ) : (
              <button
                className="btn btn--secondary"
                disabled={busy || state === "checking" || state === "downloading"}
                onClick={async () => {
                  setBusy(true);
                  try { await apiPost("/api/updates/check", {}); await refresh(); }
                  finally { setBusy(false); }
                }}
              >
                Check now
              </button>
            )}
          </div>

          <div className="s-row">
            <div>
              <div className="s-row__label">Check automatically</div>
              <div className="s-row__desc">
                Skiff checks GitHub once a day. This is the only network request
                the app makes — it carries no vault data, and turning it off
                stops it completely, which is what an air-gapped install needs.
              </div>
            </div>
            <button
              className={`btn ${info?.enabled === false ? "btn--secondary" : "btn--danger"}`}
              onClick={async () => {
                await apiPut("/api/updates/enabled", { enabled: info?.enabled === false });
                await refresh();
              }}
            >
              {info?.enabled === false ? "Turn on" : "Turn off"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
