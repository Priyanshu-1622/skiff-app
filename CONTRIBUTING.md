# Contributing to Skiff

Thanks for your interest in Skiff. It's a self-hosted SSH access-governance and
audit application, maintained primarily by one person, and contributions are
genuinely welcome — bug reports, fixes, features, docs, all of it. This guide
explains how to get set up and what to keep in mind so your contribution lands
smoothly.

## Before you start

**For anything bigger than a small fix, open an issue first.** It's much easier
to agree on an approach before code exists than to rework a finished PR. This is
especially true for features — Skiff has a deliberate scope, and a feature that
doesn't fit is a frustrating thing to find out about after you've built it.

Bug reports are always useful. A good one includes what you did, what you
expected, what happened, and your environment (OS, Node version, and whether
you're running the desktop app or the server). If it's a security issue,
**don't** open a public issue — see [SECURITY.md](./SECURITY.md).

## Project layout

Skiff is a pnpm monorepo. The organising rule is **one engine, many doorways**:

```
packages/core     @skiff/core    the engine — SSH sessions, vault, recorder,
                                 audit chain, approvals, guardrails, database.
                                 Transport-independent.
packages/shared   @skiff/shared  TypeScript types shared across the workspace
apps/desktop      @skiff/desktop Electron app. The primary target.
apps/web          @skiff/web     React UI. Runs in both the desktop app (over
                                 IPC) and the browser (over HTTP).
apps/api          @skiff/api     Fastify server, for existing self-hosters
```

**`packages/core` must not know how it is being called.** No HTTP, no IPC, no
Electron, no `process.env`, no assumptions about filesystem layout. Everything
it needs arrives through `CoreConfig`. Breaking that rule forks the engine,
which is the single worst outcome available to this project — every security fix
would then have to be made twice, in codebases that drift apart.

## Getting set up

You'll need **Node 20+** and **pnpm 9 or 10**. Not pnpm 11 — it requires Node
22.13+ and fails confusingly below it.

```bash
git clone https://github.com/Priyanshu-1622/skiff-app.git
cd skiff-app
pnpm install
pnpm --filter @skiff/core build
pnpm --filter @skiff/shared build
cd apps/desktop
pnpm exec electron-builder install-app-deps
pnpm dev
```

Two things that are not optional and will waste your afternoon if you skip them:

- **`electron-builder install-app-deps`.** `better-sqlite3` and `argon2` are
  native modules. The copies pnpm installs are built for your system Node and
  will not load inside Electron. This rebuilds them for Electron's ABI.
- **Building `core` and `shared` first.** On a clean clone the other packages
  won't typecheck until those two have been compiled at least once.

Launch the app from `apps/desktop`, never from the repository root — root
`pnpm dev` starts the legacy API server instead.

**Path with no spaces.** `node-gyp` fails to build the native modules if the
project path contains a space. `C:\dev\skiff-app` is fine; `C:\My Projects\skiff`
is not.

**Windows:** the native modules compile from source. You need Visual Studio
Build Tools with "Desktop development with C++".

### Running the tests

```bash
pnpm --filter @skiff/core test
pnpm --filter @skiff/desktop test
pnpm typecheck
```

If the core tests fail with `better-sqlite3` errors, it's built for Electron
rather than for Node. Run `pnpm rebuild better-sqlite3`, run the tests, then
`pnpm exec electron-builder install-app-deps` again before launching the app.
One compiled binary can only target one runtime at a time.

## Code standards

- **TypeScript strict mode is on.** Please keep it on. If you're fighting the
  types, that's usually the design telling you something — reach for `unknown`
  and narrowing before `any`.
- **Format with Prettier** before committing.
- **Match the existing style.** The codebase favours clear, direct code over
  cleverness, prose comments only where the *why* isn't obvious (not the
  *what*), and minimal abstraction. New code should look like it belongs.
- **Frontend:** components live in `apps/web/src/routes` and
  `apps/web/src/components`. Styling is plain CSS with design tokens
  (`apps/web/src/styles/tokens.css`) — no Tailwind, no CSS-in-JS. Reuse the
  tokens; don't hardcode colours. Machine values (hostnames, IPs, hashes,
  timestamps, ports) are monospace; human labels are not.
- **IPC:** handlers import from `contract.ts`, never `registry.ts`. That's what
  keeps them testable without Electron running.
- **No outbound network requests.** Fonts and the recording player are bundled
  locally on purpose — Skiff is meant to work air-gapped. Don't add a CDN link.

### The bug class to watch for

The desktop app was ported from an HTTP server to IPC, and the recurring failure
has been a **name that doesn't match across the seam**: the renderer sends one
message name, the IPC adapter listens for another, and the message is silently
dropped. Nothing errors; the feature just does nothing.

If something silently does nothing, check the channel or message name on both
sides before assuming the logic is wrong. The translations live in
`apps/web/src/lib/ws-ipc.ts` and `apps/web/src/lib/api-ipc.ts`.

## Working with security-sensitive code

Skiff's whole job is protecting credentials, so changes to anything under
`packages/core/src/crypto`, the auth handlers, the session store, or the audit
chain get extra scrutiny. If your change touches encryption, key handling,
authentication, host-key verification, or the team-mode shared-key logic:

- Explain the security reasoning in the PR description.
- Don't introduce a way for a credential, password, or key to be written to
  disk unencrypted, logged, or sent to the renderer.
- The audit log must never contain secrets — only metadata.
- Don't weaken the audit chain. Its value is that it is provable, and a
  chain that can be quietly rewritten is worse than no chain, because people
  will have trusted it.
- If you're unsure whether something is safe, ask in the issue before building
  it.

Two properties are asserted by tests rather than assumed: stored credentials
must not contain plaintext, and exported backups must not either. A regression
in either is a security bug, not a broken feature.

When in doubt, read [SECURITY.md](./SECURITY.md) — it describes the intended
model, and contributions shouldn't quietly weaken it.

## Commits and pull requests

- **Commit messages:** be specific enough that `git log --oneline` reads like a
  changelog. A `type: summary` style (e.g. `fix: terminal resize race`,
  `feat: team audit log`) is appreciated but not enforced.
- **Keep PRs focused.** One logical change per PR is far easier to review than a
  grab-bag. If you find yourself writing "and also…" in the description,
  consider splitting it.
- **Make sure it builds, typechecks and tests** before opening the PR.
- **Reference the issue** your PR addresses.

## Licensing and the two checks on your PR

Skiff is dual-licensed, and which license applies depends on the files you
touch:

| Path | License |
| --- | --- |
| `packages/core/` | Apache-2.0 |
| everything else | AGPL-3.0-only |

`packages/core` is the engine — SSH sessions, vault, recording, audit,
database. It's permissive so every build of Skiff can import it, including
builds that aren't open source themselves. Everything built on top of it stays
AGPL, which is what prevents Skiff being taken closed-source and run as a
commercial service. See [NOTICE](./NOTICE) at the repository root.

Your pull request runs two automated checks about this. They look similar and
are often confused, so here is what each one actually does:

| Check | Question it answers | What you do |
| --- | --- | --- |
| **DCO** | Did you write this, and do you have the right to submit it? | Add `-s` to your commits |
| **CLA** | May this code also be used in the commercial edition? | Reply once on your first PR |

**They are not interchangeable.** Signing off a commit certifies where the code
came from. It does not grant permission to use that code under a different
license — and because `apps/` is AGPL, that permission has to be given
explicitly or it hasn't been given at all. The CLA is where that happens.

### Sign your commits (DCO)

Every commit needs a `Signed-off-by` line. Add one automatically with `-s`:

```bash
git commit -s -m "Fix reconnect after network change"
```

This is the [Developer Certificate of Origin](https://developercertificate.org/):
you're asserting that you wrote the code, or have the right to submit it, and
that you're contributing it under the license above. There's nothing to sign and
no document to store.

If you forget:

```bash
git commit --amend -s          # most recent commit
git rebase --signoff main      # several commits
```

### Sign the CLA (once)

On your first pull request a bot will ask you to confirm the
[Contributor License Agreement](./CLA.md). You reply on the PR with one
sentence and it records your signature. You are never asked again.

The short version: **you keep the copyright in everything you write.** You are
granting permission, not giving anything away, and you remain free to reuse your
own contribution anywhere else. The permission exists so that a planned
commercial edition — the thing intended to fund this open-source project — can
include contributed code without the maintainer having to track down every past
contributor individually.

**Contributing on behalf of a company?** If you're writing this on company time
or equipment, your employer probably owns the copyright, not you — in which case
your signature alone doesn't grant what the agreement needs. Your employer signs
the [Corporate CLA](./CLA-CORPORATE.md) once, and after that their employees
contribute normally. Open an issue and it can be sorted out.

If you're contributing in your own time, on your own machine, and outside the
scope of your job, the individual agreement is enough.

It doesn't allow anyone to close the open-source editions. Those stay open.

If the agreement worries you, open an issue and ask before contributing. That's
a reasonable thing to want cleared up first, and it won't be held against your
PR.

## A note on scope

Skiff intentionally does a small set of things well rather than everything. The
project's direction is access governance and provable audit, not protocol
breadth — RDP, VNC, Docker management and similar are explicitly out of scope.
That's not a judgment on the idea; it's about keeping the project maintainable
by a small team. If you're not sure whether something fits, the issue thread is
the place to find out.
