import { useState, useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { BareShell } from "@/components/shell";
import { useVault } from "@/lib/vault";
import { apiPost } from "@/lib/api";
import * as I from "@/components/icons";
import type { VaultMode } from "@skiff/shared";
import "@/styles/firstrun.css";

/**
 * First run — four steps, matching the Instrument Panel design:
 *
 *   1. Welcome   what Skiff is, and that it stays on this machine
 *   2. Vault     master password (and mode, for teams)
 *   3. Import    read ~/.ssh/config and offer the hosts found there
 *   4. Ready     confirmation
 *
 * Step 3 is the one that matters most. Typing twenty hosts by hand is where
 * people give up; "we found 6 hosts, import them?" is the difference between
 * a user and a bounce. The parsing already exists in the engine — this screen
 * is only the doorway to it.
 *
 * Redirects away if a vault already exists.
 */

type Step = 1 | 2 | 3 | 4;

interface ParsedHost {
  alias: string;
  hostname: string | null;
  port: number | null;
  user: string | null;
  identityFile: string | null;
}

const STEPS: { n: Step; label: string }[] = [
  { n: 1, label: "Welcome" },
  { n: 2, label: "Vault" },
  { n: 3, label: "Import" },
  { n: 4, label: "Ready" },
];

export function SetupRoute() {
  const navigate = useNavigate();
  const { status, loading, fetchStatus, setup } = useVault();

  const [step, setStep] = useState<Step>(1);
  const [mode, setMode] = useState<VaultMode>("personal");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [reveal, setReveal] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Import step
  const [scanning, setScanning] = useState(false);
  const [found, setFound] = useState<ParsedHost[] | null>(null);
  const [scanError, setScanError] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [imported, setImported] = useState(0);
  const [restoring, setRestoring] = useState(false);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);
  useEffect(() => {
    if (loading) return;
    // Already initialized → don't allow re-setup.
    if (status?.initialized && step === 1) navigate({ to: "/" });
  }, [loading, status, navigate, step]);

  /**
   * Restore from a backup instead of creating a fresh vault. The previous
   * version called fetch("/api/settings/restore") directly, which only works
   * against the Fastify server — in the desktop app there is no HTTP layer, so
   * it silently failed. Going through apiPost picks the right transport.
   */
  const restoreFromFile = async (file: File) => {
    setError("");
    setRestoring(true);
    try {
      const backup = JSON.parse(await file.text());
      await apiPost("/api/settings/restore", backup);
      await fetchStatus();
      navigate({ to: "/unlock" });
    } catch (e: any) {
      setError(e?.message || "Couldn't read that backup file");
    } finally {
      setRestoring(false);
    }
  };

  /** Step 2 → creates the vault, then moves on to import. */
  const createVault = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (password.length < 8) { setError("Use at least 8 characters"); return; }
    if (password !== confirm) { setError("Passwords don't match"); return; }
    if (mode === "team" && !username.trim()) { setError("Choose an admin username"); return; }

    setBusy(true);
    try {
      const result = await setup(
        password,
        mode === "team" ? { mode, username: username.trim() } : { mode },
      );
      if (!result.ok) { setError(result.error || "Setup failed"); return; }
      setStep(3);
      void scanConfig();
    } finally {
      setBusy(false);
    }
  };

  /** Reads ~/.ssh/config through the engine. Absence is normal, not an error. */
  const scanConfig = async () => {
    setScanning(true);
    setScanError("");
    try {
      const res = await apiPost<{ hosts: ParsedHost[] }>("/api/import/parse", {});
      const hosts = res.hosts ?? [];
      setFound(hosts);
      setSelected(new Set(hosts.map((h) => h.alias)));
    } catch (e: any) {
      setFound([]);
      setScanError(e?.message || "Couldn't read ~/.ssh/config");
    } finally {
      setScanning(false);
    }
  };

  const toggle = (alias: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(alias) ? next.delete(alias) : next.add(alias);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected((prev) =>
      prev.size === (found?.length ?? 0) ? new Set() : new Set((found ?? []).map((h) => h.alias)),
    );
  };

  const runImport = async () => {
    if (!found || selected.size === 0) { setStep(4); return; }
    setBusy(true);
    setError("");
    try {
      await apiPost("/api/import/apply", { selectedHosts: [...selected] });
      setImported(selected.size);
      setStep(4);
    } catch (e: any) {
      setError(e?.message || "Import failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <BareShell>
      <div className="fr">
        {/* Step rail */}
        <div className="fr-steps">
          {STEPS.map((s, i) => (
            <div key={s.n} className="fr-steps__item">
              <span
                className={`fr-step${step === s.n ? " is-current" : ""}${step > s.n ? " is-done" : ""}`}
              >
                <span className="fr-step__num">{step > s.n ? <I.Check size={11} /> : s.n}</span>
                <span className="fr-step__label">{s.label}</span>
              </span>
              {i < STEPS.length - 1 && (
                <span className={`fr-steps__line${step > s.n ? " is-done" : ""}`} />
              )}
            </div>
          ))}
        </div>

        <div className="fr-body">
          {step === 1 && (
            <div className="fr-welcome">
              <div className="fr-mark"><I.Skiff size={26} /></div>
              <h1 className="fr-h1">Welcome to Skiff</h1>
              <p className="fr-lede">
                A connection manager and access-governance tool for the servers you
                already run.
              </p>
              <div className="fr-assure">
                <I.Shield size={14} />
                Fully local — nothing ever leaves this machine.
              </div>
              <button className="fr-btn fr-btn--primary" onClick={() => setStep(2)}>
                Get started
              </button>
              <span className="fr-note">Takes about a minute</span>
              <label className="fr-restore">
                {restoring ? "Restoring…" : "Or restore from a backup file"}
                <input
                  type="file"
                  accept="application/json,.json"
                  disabled={restoring}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void restoreFromFile(f);
                  }}
                />
              </label>
              {error && (
                <div className="fr-error" role="alert">
                  <span className="dot" />
                  {error}
                </div>
              )}
            </div>
          )}

          {step === 2 && (
            <form className="fr-panel" onSubmit={createVault}>
              <h1 className="fr-h2">Create your vault</h1>
              <p className="fr-sub">
                Your password encrypts every stored credential and private key on
                this device.
              </p>

              <div className="fr-modes" role="group" aria-label="Vault mode">
                <button
                  type="button"
                  className={`fr-mode${mode === "personal" ? " is-active" : ""}`}
                  onClick={() => setMode("personal")}
                >
                  <span className="fr-mode__name">Just me</span>
                  <span className="fr-mode__desc">One password, one vault</span>
                </button>
                <button
                  type="button"
                  className={`fr-mode${mode === "team" ? " is-active" : ""}`}
                  onClick={() => setMode("team")}
                >
                  <span className="fr-mode__name">A team</span>
                  <span className="fr-mode__desc">Accounts, roles, shared hosts</span>
                </button>
              </div>

              {mode === "team" && (
                <>
                  <label className="fr-label">Admin username</label>
                  <div className="fr-input">
                    <span className="lead"><I.User size={13} /></span>
                    <input
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      placeholder="admin"
                      autoComplete="username"
                      disabled={busy}
                    />
                  </div>
                </>
              )}

              <label className="fr-label">Master password</label>
              <div className="fr-input">
                <input
                  type={reveal ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoFocus
                  autoComplete="new-password"
                  disabled={busy}
                />
                <button type="button" className="reveal" tabIndex={-1} onClick={() => setReveal((r) => !r)}>
                  {reveal ? "hide" : "show"}
                </button>
              </div>

              <PasswordMeter value={password} />

              <label className="fr-label">Confirm password</label>
              <div className="fr-input">
                <input
                  type={reveal ? "text" : "password"}
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  autoComplete="new-password"
                  disabled={busy}
                />
              </div>

              <div className="fr-warn">
                <span className="ic"><I.Warn size={13} /></span>
                <span>
                  <strong>There is no recovery.</strong> Skiff can't reset this for
                  you. If you lose the password, the vault stays encrypted for
                  good. Store it in your password manager.
                </span>
              </div>

              {error && (
                <div className="fr-error" role="alert">
                  <span className="dot" />
                  {error}
                </div>
              )}

              <div className="fr-actions">
                <button type="button" className="fr-btn" onClick={() => setStep(1)} disabled={busy}>
                  Back
                </button>
                <button type="submit" className="fr-btn fr-btn--primary" disabled={busy || !password}>
                  {busy ? "Creating…" : "Create vault"}
                </button>
              </div>
            </form>
          )}

          {step === 3 && (
            <div className="fr-panel fr-panel--wide">
              <h1 className="fr-h2">Import your hosts</h1>

              {scanning ? (
                <p className="fr-sub">Looking for <code>~/.ssh/config</code>…</p>
              ) : found && found.length > 0 ? (
                <p className="fr-sub">
                  Found <code>~/.ssh/config</code> with {found.length}{" "}
                  {found.length === 1 ? "host" : "hosts"}. Review and import.
                </p>
              ) : (
                <p className="fr-sub">
                  {scanError
                    ? "No SSH config found on this machine."
                    : "No hosts found in your SSH config."}{" "}
                  You can add hosts by hand once you're in.
                </p>
              )}

              {found && found.length > 0 && (
                <div className="fr-list">
                  <div className="fr-list__head">
                    <label className="fr-check">
                      <input
                        type="checkbox"
                        checked={selected.size === found.length}
                        onChange={toggleAll}
                      />
                      <span>Select all</span>
                    </label>
                    <span className="fr-list__count">
                      {selected.size} of {found.length} selected
                    </span>
                    <span className="fr-list__col">Identity</span>
                  </div>

                  <div className="fr-list__body">
                    {found.map((h) => (
                      <label key={h.alias} className="fr-row">
                        <input
                          type="checkbox"
                          checked={selected.has(h.alias)}
                          onChange={() => toggle(h.alias)}
                        />
                        <span className="fr-row__main">
                          <span className="fr-row__alias">{h.alias}</span>
                          <span className="fr-row__addr">
                            {h.user ? `${h.user}@` : ""}
                            {h.hostname ?? h.alias}:{h.port ?? 22}
                          </span>
                        </span>
                        {h.identityFile && (
                          <span className="fr-row__identity">
                            <I.Key size={11} />
                            {h.identityFile.split(/[\\/]/).pop()}
                          </span>
                        )}
                      </label>
                    ))}
                  </div>
                </div>
              )}

              <p className="fr-note fr-note--left">
                Parsed locally · nothing leaves this device
              </p>

              {error && (
                <div className="fr-error" role="alert">
                  <span className="dot" />
                  {error}
                </div>
              )}

              <div className="fr-actions">
                <button type="button" className="fr-btn" onClick={() => setStep(4)} disabled={busy}>
                  Skip, I'll add hosts manually
                </button>
                <button
                  type="button"
                  className="fr-btn fr-btn--primary"
                  onClick={runImport}
                  disabled={busy || scanning || !found || selected.size === 0}
                >
                  {busy
                    ? "Importing…"
                    : selected.size > 0
                      ? `Import ${selected.size} ${selected.size === 1 ? "host" : "hosts"}`
                      : "Import"}
                </button>
              </div>
            </div>
          )}

          {step === 4 && (
            <div className="fr-welcome">
              <div className="fr-mark fr-mark--ok"><I.Check size={26} /></div>
              <h1 className="fr-h1">You're ready</h1>
              <p className="fr-lede">
                {imported > 0
                  ? `${imported} ${imported === 1 ? "host is" : "hosts are"} in your vault, encrypted on this machine.`
                  : "Your vault is created and encrypted on this machine."}
              </p>
              <button className="fr-btn fr-btn--primary" onClick={() => navigate({ to: "/" })}>
                Open Skiff
              </button>
              <span className="fr-note">Press Ctrl+K any time to jump to a host</span>
            </div>
          )}
        </div>
      </div>
    </BareShell>
  );
}

/**
 * Four bars rather than a word. A label like "weak" invites arguing with the
 * meter; bars just show there's room to improve without blocking anyone.
 */
function PasswordMeter({ value }: { value: string }) {
  let score = 0;
  if (value.length >= 8) score++;
  if (value.length >= 14) score++;
  if (/[^A-Za-z0-9]/.test(value)) score++;
  if (/[0-9]/.test(value) && /[A-Za-z]/.test(value)) score++;

  return (
    <div className="fr-meter" aria-hidden="true">
      {[0, 1, 2, 3].map((i) => (
        <span key={i} className={`fr-meter__bar${i < score ? " is-on" : ""}`} />
      ))}
    </div>
  );
}
