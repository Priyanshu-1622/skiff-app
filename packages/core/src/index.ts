/**
 * @skiff/core — the transport-independent Skiff engine.
 *
 * This package holds everything Skiff does that is not HTTP: SSH session
 * management, terminal recording, the encrypted vault, the database, and
 * audit logging. It has no knowledge of Fastify, Express, IPC, cookies, or
 * any request/response object.
 *
 * The rule that keeps this useful:
 *
 *   ONE ENGINE, MANY DOORWAYS.
 *
 *   apps/api      (Fastify)         -> calls this over HTTP routes
 *   apps/desktop  (Electron)        -> calls this over IPC handlers
 *   enterprise    (private repo)    -> calls this its own way, own database
 *
 * Nothing in here may import a web framework, read process.env, or assume a
 * filesystem layout. Configuration and paths are passed in by the host.
 * Breaking that rule forks the engine, and a forked engine is the one
 * outcome this package exists to prevent.
 */

// ── Configuration ────────────────────────────────────────────────────────
export {
  type CoreConfig,
  resolveCoreConfig,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_DB_FILENAME,
} from "./config/index.js";

// ── Database ─────────────────────────────────────────────────────────────
export {
  openDatabase,
  runColumnMigrations,
  SCHEMA_VERSION,
  type DbConfig,
  type SkiffDb,
} from "./db/client.js";
export { SCHEMA_SQL } from "./db/schema.js";

// ── Crypto / vault ───────────────────────────────────────────────────────
export * from "./crypto/vault.js";
export * from "./crypto/team-vault.js";
export * from "./crypto/session-store.js";

// ── SSH sessions ─────────────────────────────────────────────────────────
export * from "./lib/session-manager.js";

// ── Recording ────────────────────────────────────────────────────────────
export * from "./lib/recorder.js";

// ── Audit ────────────────────────────────────────────────────────────────
export {
  writeAudit,
  verifyAuditChain,
  type AuditEvent,
  type AuditRow,
  type IntegrityReport,
  type IntegrityStatus,
} from "./lib/audit.js";
export {
  readPolicy,
  writePolicy,
  requiresApproval,
  activeGrant,
  createRequest,
  decideRequest,
  listRequests,
  countPending,
  expireStale,
  DEFAULT_POLICY,
  type ApprovalPolicy,
  type AccessRequest,
  type RequestStatus,
} from "./lib/approvals.js";
export {
  TerminalLineBuffer,
  type LineFeedResult,
} from "./lib/line-buffer.js";
export {
  checkCommand,
  RULES,
  type GuardrailHit,
  type GuardrailRule,
  type Severity,
} from "./lib/guardrails.js";
export {
  listDirectory,
  makeDirectory,
  rename,
  remove,
  download,
  upload,
  remoteJoin,
  formatMode,
  type RemoteEntry,
  type TransferProgress,
} from "./lib/sftp.js";
export {
  TunnelManager,
  validateTunnel,
  type TunnelSpec,
  type TunnelState,
  type TunnelType,
} from "./lib/tunnels.js";
export {
  parseVariables,
  applyVariables,
  isFullyResolved,
  validateSnippet,
  type Snippet,
} from "./lib/snippets.js";

// ── Host keys ────────────────────────────────────────────────────────────
export { createHostKeyFingerprint, readHostKeyAlgorithm } from "./lib/host-key.js";
export {
  connectTcp,
  describeTcpFailure,
  TCP_CONNECT_TIMEOUT_MS,
} from "./lib/tcp-connect.js";

// ── SSH config parsing ───────────────────────────────────────────────────
export { parseSSHConfig, type ParsedHost } from "./lib/ssh-config.js";

// ── Utilities ────────────────────────────────────────────────────────────
export * from "./lib/id.js";
