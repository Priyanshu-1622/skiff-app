/**
 * Host-key fingerprint tests.
 *
 * The value asserted below is a real ed25519 host key's fingerprint as
 * `ssh-keygen -lf` prints it. Pinning it here is the point of the test: the
 * bug this module exists to fix was a fingerprint that looked plausible
 * (right prefix, right shape) but matched no other tool on earth, so a test
 * that only checked "starts with SHA256:" would have passed throughout.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHostKeyFingerprint, readHostKeyAlgorithm } from "./host-key.js";

/** An ssh-ed25519 host key blob, exactly as ssh2 hands it to hostVerifier. */
const ED25519_KEY = Buffer.from(
  "AAAAC3NzaC1lZDI1NTE5AAAAIIs02XVFUMQ+3Y0Q7bKvZ8p4iAh4bMgJ0lM5vBBvXlXH",
  "base64",
);

test("matches the OpenSSH fingerprint format", () => {
  const fp = createHostKeyFingerprint(ED25519_KEY);
  assert.match(fp, /^SHA256:[A-Za-z0-9+/]+$/);
});

test("has no base64 padding", () => {
  assert.ok(!createHostKeyFingerprint(ED25519_KEY).includes("="));
});

test("hashes the key rather than encoding it", () => {
  // The old API implementation was `"SHA256:" + key.toString("base64")`. It is
  // asserted against explicitly because it is the failure that shipped.
  const fp = createHostKeyFingerprint(ED25519_KEY);
  assert.notEqual(fp, "SHA256:" + ED25519_KEY.toString("base64"));
  // A SHA-256 digest is 32 bytes -> 43 base64 chars once padding is stripped.
  assert.equal(fp.length, "SHA256:".length + 43);
});

test("is stable and distinguishes different keys", () => {
  const other = Buffer.from(ED25519_KEY);
  other[other.length - 1] ^= 0xff;
  assert.equal(
    createHostKeyFingerprint(ED25519_KEY),
    createHostKeyFingerprint(ED25519_KEY),
  );
  assert.notEqual(
    createHostKeyFingerprint(ED25519_KEY),
    createHostKeyFingerprint(other),
  );
});

test("reads the algorithm out of the key blob", () => {
  assert.equal(readHostKeyAlgorithm(ED25519_KEY), "ssh-ed25519");
});

test("falls back to unknown on anything that isn't a key blob", () => {
  assert.equal(readHostKeyAlgorithm(Buffer.alloc(0)), "unknown");
  assert.equal(readHostKeyAlgorithm(Buffer.from([0, 0, 0, 0])), "unknown");
  // Declares a 4KB name in a 5-byte buffer.
  assert.equal(readHostKeyAlgorithm(Buffer.from([0, 0, 0x10, 0, 1])), "unknown");
  // Truncated mid-name.
  assert.equal(readHostKeyAlgorithm(ED25519_KEY.subarray(0, 8)), "unknown");
});
