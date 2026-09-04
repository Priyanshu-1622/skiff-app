// Runs the desktop IPC tests.
//
// Uses the same cross-platform pattern as the other packages (walk, don't
// glob) and additionally registers the sqlite shim so these tests run in
// sandboxed environments where better-sqlite3 cannot compile.
import { readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function findTests(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...findTests(full));
    else if (entry.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

const tests = findTests(here);
if (tests.length === 0) {
  console.error("No test files found under", here);
  process.exit(1);
}

const tsxLoader = pathToFileURL(require.resolve("tsx/esm")).href;
const shimLoader = pathToFileURL(join(here, "shim-register.mjs")).href;

const useShim = process.env.SKIFF_TEST_REAL_SQLITE !== "1";

const result = spawnSync(process.execPath, ["--test", ...tests], {
  stdio: "inherit",
  env: {
    ...process.env,
    NODE_OPTIONS: [
      process.env.NODE_OPTIONS ?? "",
      `--import ${tsxLoader}`,
      useShim ? `--import ${shimLoader}` : "",
      "--no-warnings",
    ].filter(Boolean).join(" ").trim(),
  },
});
process.exit(result.status ?? 1);
