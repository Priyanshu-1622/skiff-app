import { useState, useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { BareShell } from "@/components/shell";
import { apiGet, apiPost } from "@/lib/api";
import { useVault } from "@/lib/vault";
import * as I from "@/components/icons";
import "@/styles/unlock.css";

export function UnlockRoute() {
  const navigate = useNavigate();
  const { status, loading, fetchStatus, setup, unlock } = useVault();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [shake, setShake] = useState(false);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);
  useEffect(() => {
    if (loading) return;
    if (!status?.initialized) { navigate({ to: "/setup" }); return; }
    if (status.unlocked) { navigate({ to: "/" }); return; }
    // Team vaults log in by username on a separate screen.
    if (status.mode === "team") navigate({ to: "/login" });
  }, [loading, status, navigate]);

  const isSetup = !status?.initialized;

  const triggerShake = () => {
    setShake(true);
    setTimeout(() => setShake(false), 400);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!password) return;
    if (isSetup && password.length < 8) {
      setError("Use at least 8 characters");
      triggerShake();
      return;
    }
    if (isSetup && password !== confirm) {
      setError("Passwords don't match");
      triggerShake();
      return;
    }
    setBusy(true);
    try {
      if (isSetup) {
        const result = await setup(password);
        if (!result.ok) { setError(result.error || "Setup failed"); triggerShake(); }
      } else {
        const result = await unlock(password);
        if (!result.ok) { setError(result.error || "Incorrect password"); triggerShake(); }
      }
    } finally { setBusy(false); }
  };

  // Offered only when the OS can actually protect a key and the user has
  // opted in — never advertised on a device that can't deliver it.
  const [device, setDevice] = useState<{
    available: boolean; enabled: boolean; biometric: boolean;
  } | null>(null);
  const [deviceBusy, setDeviceBusy] = useState(false);

  useEffect(() => {
    if (isSetup) return;
    apiGet<any>("/api/keychain")
      .then(setDevice)
      .catch(() => setDevice(null));
  }, [isSetup]);

  const unlockWithDevice = async () => {
    setDeviceBusy(true);
    setError("");
    try {
      await apiPost("/api/vault/unlock-device", {});
      await fetchStatus();
      navigate({ to: "/" });
    } catch (e: any) {
      setError(e?.message || "Couldn't unlock on this device");
      // The handler clears a stale key itself, so re-read rather than
      // leaving a button that will keep failing.
      apiGet<any>("/api/keychain").then(setDevice).catch(() => setDevice(null));
    } finally {
      setDeviceBusy(false);
    }
  };

  if (loading) {
    return (
      <BareShell>
        <div className="unlock-stage">
          <div className="unlock-center">
            <div className="unlock-spinner" />
          </div>
        </div>
      </BareShell>
    );
  }

  return (
    <BareShell>
      <div className="unlock-stage">
        <div className="unlock-center">
          <div className="unlock-mark"><I.Skiff size={22} /></div>

          <h1 className="unlock-title">
            {isSetup ? "Create your vault" : "Skiff is locked"}
          </h1>

          {isSetup ? (
            <p className="unlock-sub">
              Choose a strong master password. It encrypts every credential you
              store, and it cannot be recovered if you lose it.
            </p>
          ) : (
            <span className="unlock-vault">local vault</span>
          )}

          {!isSetup && device?.enabled && (
            <>
              <button
                type="button"
                className="unlock-btn unlock-btn--device"
                onClick={unlockWithDevice}
                disabled={deviceBusy}
              >
                <I.Shield size={15} />
                {deviceBusy
                  ? "Unlocking…"
                  : device.biometric
                    ? "Unlock with Touch ID"
                    : "Unlock on this device"}
              </button>
              <div className="unlock-or"><span>or password</span></div>
            </>
          )}

          <form className="unlock-form" onSubmit={handleSubmit}>
            <div className={`unlock-input${error ? " error" : ""}${shake ? " shake" : ""}`}>
              <span className="lead"><I.Lock size={13} /></span>
              <input
                type={showPw ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus
                autoComplete={isSetup ? "new-password" : "current-password"}
                placeholder={isSetup ? "Master password" : "Master password"}
                disabled={busy}
              />
              <button type="button" className="reveal" onClick={() => setShowPw(!showPw)} tabIndex={-1}>
                {showPw ? "hide" : "show"}
              </button>
            </div>

            {isSetup && (
              <div className="unlock-input">
                <span className="lead"><I.Lock size={13} /></span>
                <input
                  type={showPw ? "text" : "password"}
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  autoComplete="new-password"
                  placeholder="Confirm password"
                  disabled={busy}
                />
              </div>
            )}

            {error && (
              <div className="unlock-error" role="alert">
                <span className="dot" />
                {error}
              </div>
            )}

            <button type="submit" className="unlock-btn" disabled={busy || !password}>
              {busy ? "Working…" : isSetup ? "Create vault" : "Unlock"}
              {!busy && <span className="kbd">↵</span>}
            </button>
          </form>
        </div>

        <div className="unlock-foot">
          <span className="dot" />
          Vault encrypted locally · nothing leaves this device
        </div>
      </div>
    </BareShell>
  );
}
