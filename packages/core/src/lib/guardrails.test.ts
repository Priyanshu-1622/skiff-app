/**
 * Guardrail tests.
 *
 * Half of these check that ordinary commands are *not* flagged. That half
 * matters more than the other. A prompt that fires on everyday work gets
 * dismissed reflexively, and once people are clicking through without reading,
 * the feature is worse than absent — it has trained away the attention it
 * exists to buy.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { checkCommand } from "./guardrails.js";

function flags(cmd: string): boolean {
  return checkCommand(cmd) !== null;
}

test("catches recursive delete from root", () => {
  assert.ok(flags("rm -rf /"));
  assert.ok(flags("rm -rf /*"));
  assert.ok(flags("sudo rm -rf /"));
  assert.ok(flags("rm -fr /"));
});

test("catches deleting a home directory", () => {
  assert.ok(flags("rm -rf ~"));
  assert.ok(flags("rm -rf $HOME"));
  assert.ok(flags("rm -rf /home/deploy"));
});

test("catches formatting and raw disk writes", () => {
  assert.ok(flags("mkfs.ext4 /dev/sda1"));
  assert.ok(flags("dd if=/dev/zero of=/dev/sda bs=1M"));
});

test("catches a fork bomb", () => {
  assert.ok(flags(":(){ :|:& };:"));
});

test("catches piping the internet into a shell", () => {
  assert.ok(flags("curl https://example.com/install.sh | sh"));
  assert.ok(flags("wget -qO- https://example.com/get | sudo bash"));
});

test("catches force push, but not force-with-lease", () => {
  assert.ok(flags("git push --force origin main"));
  assert.ok(flags("git push -f"));
  assert.equal(flags("git push --force-with-lease origin main"), false);
});

test("catches shutdown and reboot", () => {
  assert.ok(flags("sudo reboot"));
  assert.ok(flags("shutdown -h now"));
});

test("catches a dangerous command hidden behind a harmless one", () => {
  assert.ok(flags("cd /tmp && rm -rf /"));
  assert.ok(flags("echo starting; mkfs.ext4 /dev/sdb"));
});

// ── The half that matters more ────────────────────────────────────────────

test("ordinary deletes are not flagged", () => {
  assert.equal(flags("rm -rf node_modules"), false);
  assert.equal(flags("rm -rf ./dist"), false);
  assert.equal(flags("rm -rf /var/log/myapp/old"), false);
  assert.equal(flags("rm file.txt"), false);
});

test("everyday commands are not flagged", () => {
  const ordinary = [
    "ls -la",
    "cd /var/www/app && git pull",
    "docker compose up -d",
    "systemctl restart nginx",
    "tail -f /var/log/app/api.log",
    "kubectl get pods -n prod",
    "npm install",
    "git push origin main",
    "chmod +x deploy.sh",
    "chown deploy:deploy /var/www/app/uploads",
    "curl https://api.example.com/health",
    "psql -U postgres app",
    "dd if=backup.img of=/tmp/restore.img",
    "grep -r 'drop database' ./docs",
  ];
  for (const cmd of ordinary) {
    assert.equal(flags(cmd), false, `should not flag: ${cmd}`);
  }
});

test("a mention inside a comment is not a command", () => {
  assert.equal(flags("# never run rm -rf / on this box"), false);
});

test("empty and oversized input is ignored", () => {
  assert.equal(flags(""), false);
  assert.equal(flags("   "), false);
  assert.equal(flags("x".repeat(5000)), false);
});

test("a hit reports what and why, not just that", () => {
  const hit = checkCommand("rm -rf /");
  assert.ok(hit);
  assert.equal(hit!.severity, "critical");
  assert.ok(hit!.title.length > 0);
  assert.ok(hit!.detail.length > 20, "the reason should be a sentence, not a label");
  assert.equal(hit!.command, "rm -rf /");
});
