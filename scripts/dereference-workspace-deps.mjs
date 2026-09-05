#!/usr/bin/env node
// Replace pnpm's @skiff/* workspace symlinks with real directories.
//
// Why this exists
// ---------------
// electron-builder walks *resolved real paths*. pnpm links workspace packages,
// so apps/desktop/node_modules/@skiff/core resolves to packages/core, and
// app-builder-lib's getRelativePath() throws on any file that is neither under
// the app directory nor inside a "/node_modules/" path segment:
//
//   if (!file.startsWith(srcWithEndSlash)) {
//     const index = file.indexOf(NODE_MODULES_PATTERN)   // "/node_modules/"
//     if (index < 0) throw new Error(`${file} must be under ${srcWithEndSlash}`)
//     else return file.substring(index + 1)              // <- the escape hatch
//   }
//
// packages/core/LICENSE has no node_modules segment, so it throws. Copying the
// package in as a real directory puts the files back inside node_modules, which
// takes the second branch instead.
//
// Things already tried that do NOT fix this: node-linker=hoisted (hoisting
// applies to registry packages; workspace links stay symlinks) and
// dependenciesMeta.injected (needs pnpm's isolated linker, which node-linker=
// hoisted disables). Hence doing it directly here.
//
// Run AFTER the workspace packages are built (dist must exist) and BEFORE
// electron-builder runs. Any later `pnpm install` recreates the symlinks, so
// this has to be the last step before packaging.

import { readdir, lstat, realpath, rm, cp, access } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const repoRoot = path.resolve(process.argv[2] ?? process.cwd());
const SCOPE = "@skiff";

// Only these are copied. Deliberately excludes src/, tsconfig.json and
// anything else that is build input rather than runtime output. LICENSE is
// kept: packages/core is Apache-2.0 and the notice has to ship with the
// binary, and once it lives under node_modules it no longer trips the check.
const KEEP = ["package.json", "dist", "LICENSE", "NOTICE"];

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function scopeDirs() {
  const found = [];
  const candidates = [repoRoot];
  for (const group of ["apps", "packages"]) {
    const groupDir = path.join(repoRoot, group);
    if (!(await exists(groupDir))) continue;
    for (const entry of await readdir(groupDir, { withFileTypes: true })) {
      if (entry.isDirectory()) candidates.push(path.join(groupDir, entry.name));
    }
  }
  for (const base of candidates) {
    const scoped = path.join(base, "node_modules", SCOPE);
    if (await exists(scoped)) found.push(scoped);
  }
  return found;
}

let replaced = 0;
let skipped = 0;

for (const scopeDir of await scopeDirs()) {
  for (const entry of await readdir(scopeDir)) {
    const linkPath = path.join(scopeDir, entry);
    const stat = await lstat(linkPath);
    if (!stat.isSymbolicLink()) {
      skipped++;
      continue;
    }

    const target = await realpath(linkPath);

    // Only touch links that point back into this repo's *source* tree. A link
    // pointing into pnpm's content-addressable store is a registry package,
    // not a workspace one — and the store lives inside the repo, so "is it
    // under repoRoot" is not enough to tell them apart.
    const rel = path.relative(repoRoot, target);
    const insideRepo = rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
    const insideNodeModules = rel.split(path.sep).includes("node_modules");
    if (!insideRepo || insideNodeModules) {
      skipped++;
      continue;
    }

    const dist = path.join(target, "dist");
    if (!(await exists(dist))) {
      console.error(
        `\n  ${SCOPE}/${entry}: ${path.relative(repoRoot, dist)} does not exist.` +
          `\n  Build the workspace packages before running this script,` +
          `\n  otherwise the copy ships without any compiled output.\n`
      );
      process.exit(1);
    }

    await rm(linkPath, { recursive: true, force: true });

    for (const name of KEEP) {
      const from = path.join(target, name);
      if (!(await exists(from))) continue;
      await cp(from, path.join(linkPath, name), { recursive: true });
    }

    console.log(
      `  ${path.relative(repoRoot, linkPath)}  <-  ${path.relative(repoRoot, target)}`
    );
    replaced++;
  }
}

console.log(
  `\ndereferenced ${replaced} workspace package(s), left ${skipped} entr(y/ies) alone`
);

if (replaced === 0) {
  console.error(
    "\n  No workspace symlinks were replaced. Either this ran before" +
      "\n  `pnpm install`, or the layout changed — either way electron-builder" +
      "\n  would fail on the same boundary check, so failing here instead" +
      "\n  where the reason is visible.\n"
  );
  process.exit(1);
}
