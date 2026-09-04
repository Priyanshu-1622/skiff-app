# @skiff/desktop

The Skiff desktop application — Windows, macOS, and Linux.

## What this is

Skiff running as a real application, not a web page in a wrapper. The SSH
engine runs natively inside the Electron main process. There is **no HTTP
server, no localhost port, and no cookie**. The app works entirely offline and
never contacts the network except for update checks.

That last point is a security property, not just a simplification. The server
build had to expose `127.0.0.1:8080`, which any other local process — or any
web page in your browser via DNS rebinding — could attempt to reach. For an
application holding SSH private keys, that was the wrong trade. Removing the
listener removes the entire class of attack.

## Architecture

```
┌─────────────────────────── Electron main process ───────────────────────────┐
│                                                                             │
│   @skiff/core          ← SSH sessions, vault, recorder, audit, SQLite       │
│        ↑                                                                    │
│   ipc/auth.ts          ← vault lifecycle          ┐                         │
│   ipc/data.ts          ← hosts, folders, settings ├─ Electron-free,        │
│   ipc/terminal.ts      ← SSH streaming            ┘  unit-testable          │
│        ↑                                                                    │
│   ipc/registry.ts      ← the ONLY file that imports ipcMain                 │
└─────────────────────────────────┬───────────────────────────────────────────┘
                                  │  contextBridge (allowlisted channels)
┌─────────────────────────────────┴───────────────────────────────────────────┐
│  Renderer — the existing React UI, sandboxed                                │
│  contextIsolation: true · nodeIntegration: false                            │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Key decisions

**Handlers are Electron-free.** `auth.ts`, `data.ts`, and `terminal.ts` import
from `contract.ts` (plain types and error helpers), never from `registry.ts`
(which owns the `ipcMain` wiring). This is what makes the handler logic
testable in a plain Node process with no display server — see `test/`.

**One session, no cookies.** The server kept session state in a signed cookie
because many browsers could talk to one API. A desktop app has one user in
front of one window, so the desktop holds a single `currentSessionId` in
module scope. There is no cookie to forge, no CSRF surface, and no
"cookie attributes didn't match on clear" failure mode — which is precisely
the bug class behind the v0.3 logout regression. Locking is now dropping a
variable; it cannot half-succeed.

**Channels mirror the old REST paths.** `GET /api/vault/status` became
`vault:status`. `apps/web/src/lib/api-ipc.ts` maps one to the other, keeping
the exact same exported surface as `api.ts` — so every existing TanStack Query
hook works untouched.

**Terminal events are multiplexed.** The WebSocket build had one socket per
terminal, so routing was implicit. Here every event carries a `sessionId` and
the renderer demultiplexes, because tabs and split panes share one bridge.
Closing a tab still **detaches** rather than ends, so reopening a host replays
scrollback into the same live shell.

## Local development

```bash
# from the repo root
pnpm install
pnpm --filter @skiff/core build
pnpm --filter @skiff/shared build

# rebuild native modules against Electron's ABI (REQUIRED, see below)
cd apps/desktop
pnpm exec electron-builder install-app-deps

pnpm dev          # vite renderer + electron main, together
```

### Native modules

`better-sqlite3` and `argon2` are native addons. Electron ships its own Node
ABI, so modules built for system Node **will not load** — you'll get
"Could not locate the bindings file" or a version mismatch. Run
`electron-builder install-app-deps` after any install that touches them.

In sandboxed environments `better-sqlite3` cannot compile at all. The test
runner substitutes Node 22's built-in `node:sqlite` so the suite still runs
there; set `SKIFF_TEST_REAL_SQLITE=1` to force the real driver locally.

## Tests

```bash
pnpm test    # 27 handler tests, no Electron, no display server
```

They cover vault setup/lock/unlock for both modes, lockout behaviour
(including the PR #4 regression), team login and user management, host and
folder CRUD, encryption at rest, ssh-config import, password change with
credential re-encryption, backup/restore guards, settings persistence, and
audit writes.

Two properties are asserted rather than assumed, because a silent regression
in either would be a security bug rather than a broken feature: stored
credentials must not contain their plaintext, and an exported backup must not
either.

## Packaging

```bash
pnpm package:win     # NSIS installer
pnpm package:mac     # DMG (x64 + arm64)
pnpm package:linux   # AppImage + deb
```

Cross-compilation is not possible — native modules must be built on the
target OS. CI runs a three-runner matrix; see
`.github/workflows/desktop-release.yml`.

### Signing

Unsigned builds work but show warnings: SmartScreen on Windows,
"unidentified developer" on macOS. macOS additionally requires notarization
via an Apple Developer account ($99/yr). Linux needs neither.

The recommended launch order is **Windows + Linux first**, adding macOS once
the Apple Developer spend is decided — this keeps notarization off the
critical path.

## Status

**All 40 invoke channels are implemented** (plus 2 push channels for terminal
output and update status). Built and verified: engine context, IPC contract
and registry, preload bridge, vault/data/terminal/team/settings handlers,
renderer transport, window lifecycle with CSP and navigation guards,
electron-builder config, CI matrix.

The desktop adds one capability the server could not have: `import:parse`
accepts a `path` and reads `~/.ssh/config` off local disk directly, so first
run can offer "we found 23 hosts, import them?" instead of asking for a paste.

**Not yet done:** the app has never been launched in a window — Electron
cannot run in a sandboxed environment, so first-run on real hardware is the
next milestone. Everything here is verified by tests and the compiler, not by
a running window.

After that: the remaining Tier 1 native features — OS keychain and biometric
unlock, tabs and split panes, SFTP file manager, command palette, and
auto-update.
