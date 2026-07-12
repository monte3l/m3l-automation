#!/usr/bin/env node
// Custom git merge driver for fully-generated files (see .gitattributes:
// entries tagged `merge=m3l-generated`). Registered via
// bin/install-merge-drivers.mjs into the shared repo config.
//
// Contract: git invokes this as
//   node bin/merge-driver-generated.mjs %O %A %B %P
// where %O/%A/%B are temp-file paths for the common ancestor, "ours"
// (current branch), and "theirs" (merging-in branch), and %P is the path of
// the file being merged, relative to the repo root.
//
// Deliberately does NOT run a generator here: at merge time the working tree
// is half-merged, and every generator in this repo reads *other* files
// (docs/reference sidecars, docs/implementation-status.md, ...) that may not
// yet be in their final merged state. Instead this resolves the conflict by
// keeping the current side (%A) exactly as git already wrote it — no read or
// write of %A at all — and exits 0 so git treats the merge as clean.
// Regeneration is the post-rewrite/post-merge hook's job
// (bin/post-integrate-regen.mjs); the existing CI byte-compare gates
// (check:index, check:provenance, check:doc-counts/check:impl-counts)
// guarantee the final bytes are correct once that runs.
import process from "node:process";
import { fileURLToPath } from "node:url";

/**
 * The one-line operator note printed for a resolved file. Pure so it's
 * unit-testable without spawning the CLI.
 *
 * @param {string | undefined} filePath - the merge driver's %P argument
 * @returns {string}
 */
export function describeMergeResolution(filePath) {
  return (
    `m3l-generated merge driver: kept the current side of ${filePath ?? "(unknown file)"} unchanged; ` +
    "run the post-rewrite/post-merge regeneration (or pnpm gen:index / pnpm gen:counts) to refresh it."
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // argv: [node, script, %O, %A, %B, %P]
  const filePath = process.argv[5];
  console.log(describeMergeResolution(filePath));
  process.exit(0);
}
