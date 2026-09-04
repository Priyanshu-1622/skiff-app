// Bundle the preload script to CommonJS.
//
// Electron loads preload scripts in a special context that does not support
// ESM import statements, regardless of the package "type". esbuild bundles the
// shared IPC contract in and emits a single .cjs file, so the preload has no
// runtime resolution to do at load time.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

await build({
  entryPoints: [join(root, "src/preload/index.ts")],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: join(root, "dist/preload/index.cjs"),
  external: ["electron"],
  sourcemap: true,
});

console.log("preload bundled -> dist/preload/index.cjs");
