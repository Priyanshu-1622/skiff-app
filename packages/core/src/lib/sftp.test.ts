/**
 * SFTP helper tests.
 *
 * These cover the two pure functions, which is where the bugs that matter
 * actually live. Path joining is the one worth being strict about: a Windows
 * client browsing a Linux server is the normal case, and `path.join` there
 * produces backslashes the server rejects — a bug that only appears for half
 * your users and never on the machine it was written on.
 *
 * Transfers aren't unit-tested; they need a real SFTP server. That's honest
 * rather than convenient — a mock would test the mock.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { remoteJoin, formatMode } from "./sftp.js";

test("joins remote paths with forward slashes", () => {
  assert.equal(remoteJoin("/var/www", "app"), "/var/www/app");
  assert.equal(remoteJoin("/var/www/", "app"), "/var/www/app");
  assert.equal(remoteJoin("/", "etc"), "/etc");
});

test("never produces a backslash, whatever the client OS", () => {
  const joined = remoteJoin("/var/www/app", "config.prod.yaml");
  assert.ok(!joined.includes("\\"), "remote paths must stay POSIX");
});

test("'..' walks up one level", () => {
  assert.equal(remoteJoin("/var/www/app", ".."), "/var/www");
  assert.equal(remoteJoin("/var/www/app/", ".."), "/var/www");
  assert.equal(remoteJoin("/var", ".."), "/");
});

test("'..' at the root stays at the root", () => {
  assert.equal(remoteJoin("/", ".."), "/");
});

test("renders permissions the way ls does", () => {
  // 0o40755 — a directory, rwxr-xr-x
  assert.equal(formatMode(0o040755), "drwxr-xr-x");
  // 0o100644 — a regular file, rw-r--r--
  assert.equal(formatMode(0o100644), "-rw-r--r--");
  // 0o100600 — a private file, rw-------
  assert.equal(formatMode(0o100600), "-rw-------");
  // 0o120777 — a symlink
  assert.equal(formatMode(0o120777), "lrwxrwxrwx");
});

test("an executable script reads as executable", () => {
  assert.equal(formatMode(0o100755), "-rwxr-xr-x");
});
