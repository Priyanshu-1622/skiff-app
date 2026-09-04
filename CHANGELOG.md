# Changelog

All notable changes to Skiff are recorded here. Versions follow
[semantic versioning](https://semver.org/).

Skiff moved from GitHub Releases to distributing from skiffssh.me, so this file
is the release notes — worth keeping current, because it is the page people
check before updating.

## [1.0.0] — unreleased

The first desktop release. Skiff was a browser application served by a local
server; it is now a desktop app with the engine running in-process. The server
build is still maintained for people already running it.

### Governance

- **Tamper-evident audit log.** Every entry is hash-linked to the one before
  it. Editing, deleting or reordering an entry breaks verification, and the
  Audit screen reports what broke and where. The chain head is displayed so it
  can be recorded outside Skiff.
- **Break-glass approvals.** Hosts carrying a policy tag require a second
  person to approve before anyone can connect. Approval opens a time-boxed
  window rather than a single connection. Self-approval is refused.
- **Dangerous-command guardrails.** A short list of irreversible commands
  pauses for confirmation. Proceeding anyway is recorded.
- **Host tags drive policy**, so importing a group of production machines
  covers them all without per-host configuration.

### Desktop

- **Unlock with the OS keychain**, including Touch ID on macOS. The derived
  vault key is stored — never the password. Off by default.
- **SFTP file manager**, dual-pane, with streamed transfers and progress.
- **Port forwarding**, local and remote, over the session you already have.
- **Jump hosts (ProxyJump)** and **SSH agent authentication**.
- **Terminal tabs, split panes, and find in scrollback.**
- **System tray**, with the app staying alive when the window closes so
  sessions survive.
- **Auto-update**, checking daily and installing on quit — never mid-session.
- **First-run import** reads `~/.ssh/config` directly from disk.
- **Snippets**: saved commands with `{{variables}}`, guardrail-checked.
- **Command palette** (Ctrl/Cmd-K) with recent sessions.

### Security

- Skiff makes no outbound requests except the update check, which can be
  switched off. Fonts and the recording player are bundled rather than fetched.
- Terminal links are restricted to `http(s)`. Terminal output comes from
  machines you may not control, and a `file://` link would otherwise reach the
  OS.
- Backup restore validates key-derivation parameters, so a crafted backup
  cannot silently weaken a restored vault.
- Password verification uses constant-time comparison.
- Local file operations, tunnels and approvals all require an unlocked vault.

### Notes for existing self-hosters

- The engine moved into `@skiff/core`, shared by the desktop app and the
  server. The Docker build was updated accordingly — rebuild rather than
  reusing a cached image.
- Your vault format is unchanged. The desktop app reads an existing database.
- `packages/core` is now Apache-2.0; the rest of Skiff remains AGPL-3.0-only.
