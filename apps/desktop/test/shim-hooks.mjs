// Redirects `better-sqlite3` to the node:sqlite shim for test runs only.
// Registered via --import so it applies to every module in the graph.
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const shim = pathToFileURL(join(here, "sqlite-shim.mjs")).href;

export async function resolve(specifier, context, next) {
  if (specifier === "better-sqlite3") {
    return { url: shim, shortCircuit: true };
  }
  return next(specifier, context);
}
