import { createHash } from "node:crypto";

/**
 * Host-key fingerprints, in the one format every doorway must agree on.
 *
 * This lives in core rather than in each host because the two builds had
 * drifted: the desktop app hashed the key, and the API base64-encoded the raw
 * key under a "SHA256:" label that was never a SHA-256 of anything. Both wrote
 * their result into the same `known_hosts.fingerprint` column, so a host
 * pinned by one build was unrecognised by the other — it re-prompted as if the
 * key had never been seen, which is precisely the prompt users learn to click
 * through. The API's value also could not be checked against `ssh-keyscan`,
 * so nobody could verify it by eye either.
 *
 * The format matches OpenSSH's: base64 of the SHA-256 digest of the raw key
 * blob, no `=` padding, prefixed `SHA256:`. That is what `ssh-keyscan -t ...
 * host | ssh-keygen -lf -` prints, which is the whole point — a fingerprint
 * you cannot compare against another tool is not a security control.
 */
export function createHostKeyFingerprint(key: Buffer): string {
  return (
    "SHA256:" + createHash("sha256").update(key).digest("base64").replace(/=+$/, "")
  );
}

/**
 * The algorithm name carried inside an SSH host key blob.
 *
 * Every key blob begins with its own algorithm as an SSH string: a 4-byte
 * big-endian length followed by that many bytes of ASCII ("ssh-ed25519",
 * "rsa-sha2-512", and so on). Reading it costs nothing and beats storing
 * "unknown" in a NOT NULL column — the value is shown next to the fingerprint
 * when a user is asked to trust a host, and "unknown" tells them nothing about
 * what they are trusting.
 *
 * Returns "unknown" only when the blob is too short or the declared length is
 * implausible, which means it was not a key blob in the first place.
 */
export function readHostKeyAlgorithm(key: Buffer): string {
  if (key.length < 4) return "unknown";
  const len = key.readUInt32BE(0);
  if (len === 0 || len > 64 || key.length < 4 + len) return "unknown";
  const name = key.subarray(4, 4 + len).toString("ascii");
  return /^[\x21-\x7e]+$/.test(name) ? name : "unknown";
}
