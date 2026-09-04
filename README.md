# Skiff

**Self-hosted SSH access control and audit — the simple, ownable alternative to Teleport.**

Skiff is a desktop application that sits between your team and your servers. It
manages connections like any SSH client, and adds the two things that stop
mattering only when something goes wrong: **who was allowed to connect**, and
**a record of what happened that can be proved intact**.

Runs entirely on your machine. No cloud, no accounts, no telemetry.

![License](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)
![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)

---

## Why this exists

Most SSH clients are connection managers: a nicer list of servers and a nicer
terminal. That's a real problem worth solving, and it's solved several times
over.

The problem that isn't solved for small teams is governance. Once more than one
person can reach production, three questions start to matter:

- Can someone connect to the payments database at 2am without anyone knowing?
- If something breaks, can you reconstruct who did what?
- If someone edits that record afterwards, would you be able to tell?

The tools that answer these — Teleport, Boundary, StrongDM — are excellent and
built for organisations with a platform team to run them. A fifteen-person
startup gets the choice between deploying a cluster or having no answer at all.

Skiff is the answer at that scale: an application you install, not a system you
operate.

## What it does

**Approval-gated access.** Tag a host as production and connecting requires a
second person to approve. The approval opens a time-boxed window, not an
unlimited one, and the request, the decision and the window are all recorded.
Nobody can approve their own request.

**A tamper-evident audit log.** Every entry stores a hash covering its own
contents and the hash of the entry before it. Change a historical entry and its
hash stops matching. Recompute that hash and the next entry's link breaks
instead. Delete one and there's a hole. Verification is a button in the app, and
it reports what broke and where.

**Session recording.** Terminal sessions are captured in asciicast format and
replay in-app. What was on screen, exactly as it appeared.

**Dangerous-command guardrails.** A short list of irreversible commands —
`rm -rf /`, `mkfs`, `dd` to a disk, piping the internet into a shell — pause and
ask for confirmation. Proceeding anyway is recorded, which is the part that
matters afterwards.

And the things you'd expect from a terminal you live in: tabs, split panes,
find in scrollback, SFTP file transfer, port forwarding, jump hosts, SSH agent
authentication, snippets, and a command palette.

## Security posture

Credentials are encrypted with AES-256-GCM under a key derived from your master
password with argon2id. The password is never stored. The key exists only in
memory while the vault is unlocked, and is zeroed on lock and on idle timeout.

Skiff makes **no outbound network requests** except an update check, which can
be turned off. Fonts and the recording player are bundled rather than fetched.

See [SECURITY.md](SECURITY.md) for the full threat model, including what Skiff
explicitly does *not* protect against.

## Install

Download for macOS, Windows or Linux from the releases page, or build from
source:

```bash
pnpm install
pnpm --filter @skiff/core build
pnpm --filter @skiff/shared build
cd apps/desktop
pnpm exec electron-builder install-app-deps   # native modules for Electron
pnpm dev
```

Requires Node 20+ and pnpm 9.

### Self-hosted server

The original browser-based server is still maintained for people already
running it:

```bash
docker compose up -d --build
```

New installs should prefer the desktop app — it's where development is
happening, and it can do things a browser cannot: OS keychain unlock, SFTP,
port forwarding, and reading your existing `~/.ssh/config`.

## Repository layout

```
packages/
  core/     @skiff/core    engine: SSH sessions, vault, recorder, audit,
                           approvals, guardrails, database. Transport-independent.
  shared/   @skiff/shared  shared TypeScript types
apps/
  desktop/  @skiff/desktop the Electron app — the primary target
  web/      @skiff/web     the React UI, used by both the desktop app (over IPC)
                           and the server (over HTTP)
  api/      @skiff/api     the Fastify server, for existing self-hosters
```

One engine, two doorways. `@skiff/core` knows nothing about HTTP or IPC, which
is what keeps the desktop app and the server from drifting into two products.

## Tests

```bash
pnpm --filter @skiff/core test      # engine
pnpm --filter @skiff/desktop test   # IPC handlers
```

The suites worth knowing about are the adversarial ones: the audit chain tests
attempt to tamper with the log six different ways, and the approvals tests try
to grant access without a second person. Those are assertions about security
properties, not features — if they ever pass when they shouldn't, the claims on
this page are false.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Commits need a `Signed-off-by` line
(`git commit -s`).

Note that `packages/core` is **Apache-2.0** while everything else is
**AGPL-3.0-only** — see [NOTICE](NOTICE) for why.

## License

AGPL-3.0-only, except `packages/core` which is Apache-2.0.

The audit chain, approvals, guardrails and recording are all in the open-source
version and always will be. Nothing that proves what happened on your servers
will ever sit behind a paywall.
