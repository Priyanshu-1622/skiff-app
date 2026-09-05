#!/usr/bin/env node
/**
 * Make the Vite renderer bundle safe to load from disk, then lock it down.
 *
 * A packaged build opens its renderer over file://, and Vite's output assumes
 * an HTTP origin in two ways that both fail there. This runs once after the
 * renderer build and fixes both, then bakes in the CSP.
 *
 * 1. `crossorigin` on the module script and stylesheet.
 *    Vite emits these for HTTP subresource integrity. On file:// the origin is
 *    opaque, so the CORS check they trigger has nothing to succeed against and
 *    the bundle may never load. Removed here; they earn nothing when the files
 *    sit inside the asar next to the document.
 *
 * 2. The Content-Security-Policy.
 *    The policy used to be applied as a response header for every request.
 *    file:// responses carry no headers, and returning a synthesized header
 *    object for them fails the request outright with ERR_FAILED — the window
 *    opened empty, which is what shipped in the first v1.0.0 build. The header
 *    path now covers http(s) only (applyContentSecurityPolicy in
 *    src/main/index.ts) and file:// gets a <meta http-equiv> instead, which is
 *    what Electron's security guidance recommends for renderers loaded from
 *    disk.
 *
 *    index.html carries an inline script that sets the theme before React
 *    mounts. `script-src 'self'` blocks inline scripts, so it is hashed and
 *    the hash added to the policy — rather than opening the door with
 *    'unsafe-inline', which would defeat most of the point of having a policy
 *    in a tool that renders hostnames and recorded terminal output.
 *
 *    `file:` sits alongside `'self'` in the source lists deliberately.
 *    Chromium's handling of `'self'` on an opaque file:// origin is not
 *    something to bet a release on, and allowing the scheme costs nothing:
 *    everything it permits is the app's own bundle, already inside the asar.
 *    Remote script and remote connections stay blocked, which is the point.
 *
 * The tag is injected at build time rather than committed into
 * apps/web/index.html because that file also serves the web app through Vite's
 * dev server, where HMR needs 'unsafe-eval' and a websocket. A committed tag
 * would apply everywhere and break development.
 *
 * Keep the policy here in step with the non-dev branch in src/main/index.ts.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const indexHtml = join(here, "..", "dist", "renderer", "index.html");

if (!existsSync(indexHtml)) {
  console.error(
    `\n  finalize-renderer: ${indexHtml} does not exist.\n` +
      `  The renderer build must run first — check build:renderer in\n` +
      `  apps/desktop/package.json.\n`,
  );
  process.exit(1);
}

let html = readFileSync(indexHtml, "utf8");

/* --- 1. crossorigin ------------------------------------------------------ */

const crossoriginCount = (html.match(/\s+crossorigin(?:="[^"]*")?/g) ?? []).length;
html = html.replace(/\s+crossorigin(?:="[^"]*")?/g, "");

/* --- 2. hash the inline scripts ------------------------------------------ */

const hashes = [];
for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
  // The hash covers the element's exact text content, byte for byte — any
  // reformatting of index.html changes it, which is why this runs on the built
  // file rather than being written down somewhere.
  const digest = createHash("sha256").update(m[1], "utf8").digest("base64");
  hashes.push(`'sha256-${digest}'`);
}

/* --- 3. the policy ------------------------------------------------------- */

const POLICY = [
  "default-src 'self' file:",
  ["script-src 'self' file:", ...hashes].join(" "),
  "style-src 'self' file: 'unsafe-inline'",
  "connect-src 'self'",
  "img-src 'self' file: data:",
  "font-src 'self' file: data:",
].join("; ");

const TAG = `<meta http-equiv="Content-Security-Policy" content="${POLICY}">`;

if (/http-equiv="Content-Security-Policy"/i.test(html)) {
  // Replace rather than append: two policies both apply, and the intersection
  // of a stale one and this one is not something anyone wants to debug.
  html = html.replace(/<meta\s+http-equiv="Content-Security-Policy"[^>]*>/i, TAG);
} else {
  const head = html.match(/<head[^>]*>/i);
  if (!head) {
    console.error(
      `\n  finalize-renderer: no <head> in ${indexHtml}, so there is nowhere to\n` +
        `  put the policy. Failing rather than shipping a renderer with no CSP.\n`,
    );
    process.exit(1);
  }
  html = html.replace(head[0], `${head[0]}\n    ${TAG}`);
}

writeFileSync(indexHtml, html);

console.log(
  `renderer finalized: ${crossoriginCount} crossorigin attribute(s) removed, ` +
    `${hashes.length} inline script(s) hashed, csp injected`,
);
