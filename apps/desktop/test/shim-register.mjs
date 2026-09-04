// Registers the sqlite shim resolver.
//
// Node 22 requires loader hooks to be installed through module.register()
// rather than by passing the hooks file to --import directly: --import only
// evaluates the module, it does not treat its exports as resolve/load hooks.
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "shim-hooks.mjs")));
