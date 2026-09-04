# @skiff/core

**License: Apache-2.0** — note that this differs from the rest of the
repository, which is AGPL-3.0-only. See `LICENSE` in this directory, and
`NOTICE` at the repository root for why the split exists.

The transport-independent Skiff engine.

Everything Skiff does that is **not** HTTP lives here: SSH session management,
terminal recording, the encrypted vault, the database, and audit logging.

## Why this package exists

Skiff ships in more than one shape:

| Host | How it reaches the engine |
| --- | --- |
| `apps/api` (Fastify) | HTTP routes |
| `apps/desktop` (Electron) | IPC handlers, in-process |
| enterprise (private repo) | its own way, its own isolated database |

Without this package, each of those would carry its own copy of the SSH and
vault logic, and they would drift apart. A forked engine is the single worst
outcome available to this project — three codebases, three sets of bugs, three
places to patch a security issue. This package exists to make that impossible.

**One engine, many doorways.**

## The boundary contract

Code in `@skiff/core` may **not**:

- import a web framework (Fastify, Express, Electron, anything)
- read `process.env`
- assume a filesystem layout, a port, a cookie, or a request object
- read files relative to `import.meta.url` (breaks inside an Electron asar bundle)

Configuration and paths are **passed in by the host**:

```ts
import { openDatabase, resolveCoreConfig } from "@skiff/core";

// Electron main process
const cfg = resolveCoreConfig({ dataDir: app.getPath("userData") });

// Fastify server
const cfg = resolveCoreConfig({ dataDir: process.env.SKIFF_DATA_DIR! });

const db = openDatabase({ dataDir: cfg.dataDir });
```

If a change would require breaking one of those rules, the change belongs in
the host, not here.

## What's inside

```
src/
  config/    CoreConfig — dataDir, recordings dir, idle timeout
  crypto/    vault (argon2 + AES-256-GCM), team vault, session store
  db/        SQLite client, schema, column migrations
  lib/       session-manager, recorder, audit, id
```

### Notable design decisions

**The schema is inlined.** `db/schema.ts` exports `SCHEMA_SQL` as a string
constant. It used to be read from `schema.sql` with `readFileSync` at runtime,
which works on a normal filesystem but breaks inside an Electron asar archive
and under bundlers that don't copy `.sql` assets. `schema.sql` is kept in the
repo as the human-readable source of truth; regenerate `schema.ts` after
editing it.

**Config is split.** The old `apps/api/src/config.ts` mixed engine concerns
(`dataDir`) with HTTP concerns (`port`, `cookieSecret`, `trustedOrigins`). The
desktop app has no port and no cookies, so it would have been forced to invent
meaningless values. `CoreConfig` holds only what the engine actually needs; the
HTTP config stays in `apps/api`.

## Build & test

```bash
pnpm --filter @skiff/core build      # tsc -> dist/
pnpm --filter @skiff/core typecheck
pnpm --filter @skiff/core test       # 19 tests, no database required
```

This package is the bottom of the dependency stack — it has no workspace
dependencies, so nothing needs to be built before it.

Note that `better-sqlite3` and `argon2` are native modules. In sandboxed
environments they cannot compile; use `pnpm install --ignore-scripts` there.
Tests that touch the database only run locally. For Electron, these must be
rebuilt against Electron's ABI with `electron-rebuild`.

## Licensing

This package is Apache-2.0. The rest of Skiff — desktop app, web UI, API
server — is AGPL-3.0-only.

The engine is permissive on purpose. It has to be importable by every build of
Skiff, including the enterprise build, and an AGPL library would drag that
obligation along with it. The alternative was writing the SSH stack a second
time, which would mean two engines drifting apart and every security fix
applied twice — the exact outcome this package exists to prevent.

What stays protected is the product. Someone can build on this engine; they
cannot take Skiff itself closed-source and run it as a service.

**If you contribute here**, your contribution is under Apache-2.0. Contributions
to `apps/` remain AGPL-3.0.
