# Security

Skiff stores SSH credentials — passwords and private keys. That's about as sensitive as data gets, so this document explains exactly how Skiff protects it, what it does and doesn't guarantee, and how to report a problem.

## Reporting a vulnerability

If you find a security issue, please email **skiffsshmanager@gmail.com** rather than opening a public issue. Include enough detail to reproduce it. I'll acknowledge as quickly as I can and keep you posted on a fix. Please give me a reasonable window to patch before disclosing publicly.

This is a solo open-source project, not a company with a security team — but I take credential safety seriously and will treat any report with priority.

## The threat model

Skiff is designed to protect your credentials against:

- **Theft of the database file.** If someone copies `skiff.sqlite`, they get ciphertext, not credentials. Decrypting it requires a password that is never stored.
- **A passive look at the disk.** Credentials are encrypted at rest; the encryption key only ever exists in server memory while a vault is unlocked.
- **Casual network interception**, *when deployed correctly* (behind HTTPS — see Deployment).

It does **not** protect against:

- A compromised server while the vault is unlocked. If an attacker has root on the running host, they can read process memory, where the key lives while unlocked. No server-side tool fully solves this; Skiff doesn't claim to.
- A malicious admin in team mode. Admins can reset other members' passwords (that's the recovery mechanism), which means a rogue admin can take over accounts. Trust your admins.
- Forgotten passwords. There is no recovery backdoor. See below.

## Personal mode — how encryption works

The default mode: one master password, one user.

```
master password --argon2id--> 32-byte vault key  (memory only, never stored)
vault key --AES-256-GCM--> each credential, stored as (nonce, ciphertext)
```

- The **master password** is run through **argon2id** (OWASP-recommended parameters) with a per-vault random salt to derive a 32-byte **vault key**.
- That vault key encrypts each credential individually with **AES-256-GCM**, a standard authenticated cipher. Each credential gets a fresh random nonce; the GCM auth tag means tampering is detected on decrypt.
- The password itself is **never stored**. What's stored is an **HMAC verifier** — a keyed hash of the vault key. On unlock, Skiff derives the key from your input, computes the verifier, and compares it to the stored one. A match means the password was right, without the server ever holding the password or being able to reverse the verifier.
- While unlocked, the vault key sits in server memory only, keyed to your session. It is zeroed on lock, on idle timeout, and is never written to disk.

**Encrypted:** SSH passwords, private keys, key passphrases.
**Not encrypted:** labels, hostnames, ports, usernames, folder names, tags. These are metadata, not secrets — keeping them in plaintext is what makes search and listing fast. If your *hostnames* are themselves sensitive, be aware of this.

## Team mode — how encryption works

Team mode lets several people share one vault, each with their own login, without anyone's password being shared.

```
one random 32-byte SHARED KEY --AES-256-GCM--> every credential
each user's password --argon2id--> their key-encrypting key (KEK)
SHARED KEY --AES-256-GCM(user's KEK)--> stored once per user
```

The design:

- There is exactly **one shared key** that encrypts all credentials — just like the personal vault key, so credentials are encrypted once, not per-user.
- Each user has their **own copy of the shared key**, sealed (encrypted) with a KEK derived from *their* password via argon2id. Two users with different passwords therefore have different sealed blobs, but both unseal to the same shared key.
- **Logging in** derives the user's KEK from their password, verifies it against that user's stored HMAC verifier, and unseals the shared key into memory for that session. A wrong password fails the GCM authentication — it's a cryptographic rejection, not just a UI check.
- **Adding a member**: an admin's session already holds the shared key unsealed, so it seals a fresh copy to the new member's temporary password. The admin never learns the member's eventual password.
- **Resetting a member** (the "forgot password" path): an admin re-seals the shared key to a new temporary password and the member's old sessions are invalidated. No data is lost, because credentials are encrypted with the shared key — not with any individual's password.
- **Disabling a member** deletes their session and blocks login. Skiff refuses to disable the last remaining admin, so a team can't lock itself out of administration.

What this design deliberately does **not** provide: per-user or per-host access control. Every member can decrypt every credential in the shared vault. Team mode is "a shared vault with individual accountability and an audit log," not fine-grained RBAC. If you need to restrict which member can see which host, Skiff's open-source team mode is not the right tool.

### Audit log

In team mode, privileged actions are recorded to an audit table: logins and failed logins, host connections (which user connected to which host, as which SSH user), and host/folder/user changes. The log never contains secrets — only metadata like labels, usernames, and IP addresses. Admins review it from the Admin panel. It's stored in the same SQLite database, consistent with the zero-cloud model.

## Personal -> Team upgrade

Upgrading a personal vault to team mode is designed to be safe and lossless:

- Your existing **vault key becomes the shared key**. Because credentials were already encrypted with it, **nothing is re-encrypted** — there's no bulk migration that could corrupt data.
- Your account becomes the first admin; the existing vault key is sealed to your existing password as that admin's key copy.
- The upgrade is **one-way** and requires confirming your current master password. Export a backup first if you want a rollback point.

## Forgotten passwords

There is no recovery backdoor, by design.

- **Personal mode:** if you forget your master password, your credentials are unrecoverable. This is the point — a recovery mechanism would be a backdoor.
- **Team mode:** an admin can reset *another* member's password (re-sealing the shared key to a new one). But if *every* admin loses their password, the vault is unrecoverable. Keep more than one admin, and keep an encrypted backup.

## Deployment hardening

Skiff is only as safe as how you run it:

- **Always put it behind HTTPS** in production (nginx or Caddy as a TLS-terminating reverse proxy). Session cookies are marked `Secure` in production, which means they require HTTPS — over plain HTTP you'll have problems, and credentials in transit would be exposed.
- **Bind to localhost by default.** The provided `docker-compose.yml` binds to `127.0.0.1` unless you explicitly set `HOST_ADDR`. Before the vault is initialized, the setup endpoint is necessarily unauthenticated (the first caller sets the master password / first admin), so don't expose an un-initialized instance to a hostile network. Initialize it first, behind your firewall.
- **Set `SKIFF_COOKIE_SECRET`** to a long random value (`openssl rand -hex 32`). It signs session cookies.
- **Back up `./data/`.** That's where the encrypted vault lives. The backup is still encrypted — but if you lose both the data and the password, there's no recovery.
- **Protect the host.** Anyone with root on the server can read the unlocked key from memory. Standard server hygiene applies.

## Cryptographic primitives, summarized

| Purpose | Primitive |
|---|---|
| Password to key derivation | argon2id (per-vault / per-user salt) |
| Credential encryption | AES-256-GCM (random nonce per credential) |
| Shared-key sealing (team mode) | AES-256-GCM under a password-derived KEK |
| Password verification | HMAC-SHA-256 verifier (no password stored) |
| Session key storage | in-memory only, zeroed on lock/idle |

No credential, password, or key is ever written to disk in plaintext.

---

# The desktop application

The sections above describe the self-hosted server. The desktop app shares the
same vault and cryptography, but its threat model differs in ways worth stating
separately.

## What changes

**There is no server and no network listener.** The engine runs inside the
Electron main process, and the UI talks to it over Electron IPC. There is no
port to attack, no session cookie, and no TLS to misconfigure — a whole class
of deployment mistakes simply doesn't exist.

**The renderer is treated as untrusted.** `contextIsolation` is on,
`nodeIntegration` is off, and the preload exposes a fixed allowlist of channels
rather than a general bridge. Navigation away from the app origin is blocked,
and every window-open request is refused unless it is an `http(s)` URL handed
to the system browser.

That last rule matters more than it looks. Terminal output is turned into
clickable links, and terminal output comes from a machine you may not fully
control. Without a scheme check, a hostile server could print a `file://` link
and have a click launch a local executable. Anything that isn't `http(s)` is
refused.

## Unlocking with the OS keychain

Optional, and off by default. When enabled, Skiff stores your **derived vault
key** — not your password — wrapped by the operating system's secure store:
DPAPI on Windows, Keychain on macOS, libsecret on Linux. On macOS a Touch ID
prompt is required before the key is unwrapped.

The trade is explicit and stated in the app: **anyone who can sign in to your
computer as you can open your vault.** That is a real reduction in security,
accepted deliberately because a vault people lock — because unlocking is quick
— beats one they leave unlocked because typing is tedious.

Two details that matter:

- The wrapped key is stored in a **file in the data directory, not in the
  database**. Backups export the database; if the key lived there, restoring a
  backup would silently grant password-free access to whoever restored it.
- Changing your master password **deletes the stored key**, because the vault
  key changes with it. A key that no longer matches is deleted rather than left
  to fail confusingly.

Team vaults refuse keychain unlock entirely. A team vault must know *who*
unlocked it; a device key carries no identity, so audit entries would be
unattributable.

## The audit chain — what it proves, and what it doesn't

Every audit entry stores a SHA-256 hash over its own fields plus the hash of the
entry before it.

**It proves:** no entry has been edited, deleted or reordered since it was
written. Editing a row breaks its own hash. Fixing that hash breaks the next
entry's link. Deleting a row leaves a gap. There is no edit that leaves the
chain intact, so an attacker with write access to the database can destroy the
log but cannot quietly rewrite it.

**It does not prove:** that the log is complete. Deleting the whole log and
starting a fresh chain produces something internally consistent. Detecting that
requires the head hash to be recorded somewhere outside the database — the app
displays the head hash for exactly this reason, and periodic external
attestation is out of scope for the open-source version.

Entries written before the chain existed carry no hash. They are reported as
"unchained" rather than backfilled: computing hashes over rows nobody can vouch
for would make an unverifiable log *look* verified, which is the failure this
feature exists to prevent.

## Break-glass approvals

Hosts carrying a policy tag (`prod` by default) cannot be connected to until
another user approves. The approval opens a time-boxed window rather than
authorising a single connection.

**Self-approval is refused.** That single rule is what makes an approval mean
"a second person agreed" rather than "someone clicked twice". Requests with no
identity cannot be approved by an approver with no identity, and an approver
with no identity at all is refused outright.

The gate is enforced in the engine, immediately before the SSH connection
opens — not in the UI. A policy enforced only by the interface would be
bypassed by anything that can reach IPC. This applies equally to SFTP and port
forwarding, which run over an existing session rather than dialling out
themselves, precisely so they inherit whatever gated that session.

Approvals require a team vault. A personal vault has no second person, so the
policy cannot be enabled — self-approval would produce audit entries implying
oversight that never happened.

## Command guardrails are not a security control

A short list of irreversible commands pauses for confirmation. **This is a
speed bump for a tired operator at 2am, not a boundary.** It runs on the client
and the user can always confirm — a determined user is on the other side of it
by definition.

Its value is that confirming is recorded. "Someone was warned and proceeded" is
a materially different audit entry from "someone ran a command".

The typed line is used for matching and then discarded. It is never stored or
logged, because the same buffer that sees `rm -rf` also sees whatever is typed
at a `sudo` password prompt.

## Restoring a backup

Backups contain encrypted credentials and the key-derivation parameters — a
stolen backup still requires the master password.

Because those parameters arrive from a file, they are validated on restore. A
crafted backup specifying a trivially weak derivation would restore a vault that
looks entirely normal while being far easier to brute-force offline, and nothing
in the interface would show that anything was wrong. Values outside the accepted
range are refused.

## Additional network posture

The desktop app makes **one** outbound request: a daily update check against the
release feed. It carries no vault data and can be turned off in Settings, which
an air-gapped installation should do. Fonts and the session-recording player are
bundled rather than fetched from a CDN.

## Reporting

The address at the top of this document applies to the desktop app as well.
Please report privately first.
