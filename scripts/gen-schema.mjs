// Regenerates packages/core/src/db/schema.ts from schema.sql.
// Run after editing the SQL: node scripts/gen-schema.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "packages/core/src/db/schema.sql");
const out = join(root, "packages/core/src/db/schema.ts");

const sql = readFileSync(src, "utf-8");
const esc = sql.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");

writeFileSync(out, `/**
 * Database schema, inlined as a string constant.
 *
 * GENERATED FILE — do not edit by hand.
 * Edit schema.sql and run: node scripts/gen-schema.mjs
 *
 * Inlined rather than read with readFileSync so the package works inside an
 * Electron asar archive and under bundlers that don't copy .sql assets.
 */

export const SCHEMA_SQL = String.raw\`${esc}\`;
`);
console.log("Wrote", out);
