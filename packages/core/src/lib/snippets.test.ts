/**
 * Snippet tests.
 *
 * The substitution rules carry real consequences — an unfilled variable that
 * silently becomes an empty string turns `rm -rf {{path}}` into `rm -rf `,
 * which is a command that runs. So the "leave it visible" behaviour is
 * asserted rather than assumed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseVariables,
  applyVariables,
  isFullyResolved,
  validateSnippet,
} from "./snippets.js";

test("finds variables in order of appearance", () => {
  assert.deepEqual(
    parseVariables("sudo systemctl restart {{service}} --host {{port}}"),
    ["service", "port"],
  );
});

test("a repeated variable is asked for once", () => {
  assert.deepEqual(parseVariables("cp {{path}}/a {{path}}/b"), ["path"]);
});

test("whitespace inside the braces is tolerated", () => {
  assert.deepEqual(parseVariables("tail -f {{ file }}"), ["file"]);
});

test("a command with no variables has none", () => {
  assert.deepEqual(parseVariables("df -h | sort -k5 -r"), []);
});

test("substitutes every occurrence", () => {
  assert.equal(
    applyVariables("cp {{path}}/a {{path}}/b", { path: "/srv" }),
    "cp /srv/a /srv/b",
  );
});

test("values go in literally, without added quoting", () => {
  // Someone typing several arguments into one variable means several
  // arguments. Quoting would collapse them into one and break the command.
  assert.equal(
    applyVariables("kubectl get pods {{args}}", { args: "-n prod --tail 50" }),
    "kubectl get pods -n prod --tail 50",
  );
});

test("an unfilled variable stays visible rather than becoming empty", () => {
  // `rm -rf ` would run. `rm -rf {{path}}` fails loudly, which is what we want.
  assert.equal(applyVariables("rm -rf {{path}}", {}), "rm -rf {{path}}");
  assert.equal(applyVariables("rm -rf {{path}}", { path: "" }), "rm -rf {{path}}");
});

test("knows when a command is ready to run", () => {
  const cmd = "restart {{service}} on {{host}}";
  assert.equal(isFullyResolved(cmd, { service: "nginx" }), false);
  assert.equal(isFullyResolved(cmd, { service: "nginx", host: "web-01" }), true);
  assert.equal(isFullyResolved("df -h", {}), true);
});

test("validation catches the obvious mistakes", () => {
  assert.match(validateSnippet({ name: "", command: "ls" })!, /name/i);
  assert.match(validateSnippet({ name: "List", command: "  " })!, /empty/i);
  assert.equal(validateSnippet({ name: "List", command: "ls -la" }), null);
});

test("an unclosed variable is caught at save time", () => {
  // It would otherwise run as literal text at the worst possible moment.
  assert.match(
    validateSnippet({ name: "Restart", command: "systemctl restart {{service" })!,
    /closing braces/,
  );
});
