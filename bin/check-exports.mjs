#!/usr/bin/env node
/**
 * Runs `publint` and `attw` (arethetypeswrong) against `packages/m3l-common`'s
 * published shape — the packaging-correctness half of the exports contract
 * (ADR-0004), complementing `check:api`'s shape-only snapshot diff.
 *
 * `attw`'s own `--pack` flag shells out to `npm pack` internally and is
 * documented as npm-only (its CLI README: "the `--pack` option does not
 * support package managers other than npm at this time", recommending
 * `pnpm pack` + a direct tarball path instead for pnpm/yarn users). This repo
 * is pnpm-managed end to end (ADR-0001) with no npm lockfile, so this script
 * packs with `pnpm pack` into a temp dir and points `attw` at the resulting
 * tarball directly rather than relying on `--pack`'s npm shell-out — the fix
 * the 2026-09-08 refreshing-typescript-guidance sweep found overdue.
 *
 * Usage:
 *   node bin/check-exports.mjs
 *
 * Exit codes:
 *   0  publint and attw both pass against packages/m3l-common.
 *   1  Either tool reports a problem, or packing/spawning either tool failed.
 */
import process from "node:process";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "./lib/report.mjs";

const root = repoRoot(import.meta.url);
const packageDir = join(root, "packages/m3l-common");

/**
 * Runs a command, streaming its output straight to this process's
 * stdout/stderr (`stdio: "inherit"`) so the underlying tool's own formatting
 * survives — both `publint` and `attw` print human-readable, colorized
 * reports that a captured-and-replayed buffer would flatten.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string }} [options]
 * @returns {number} the child's exit code, or 1 if it could not be spawned
 */
function run(command, args, options = {}) {
  const res = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    stdio: "inherit",
  });
  if (res.error) {
    console.error(
      `check:exports: could not run \`${command} ${args.join(" ")}\`: ${res.error.message}`,
    );
    return 1;
  }
  if (res.signal) {
    console.error(
      `check:exports: \`${command} ${args.join(" ")}\` was killed by ${res.signal}.`,
    );
    return 1;
  }
  return res.status ?? 1;
}

const publintStatus = run("pnpm", ["exec", "publint", packageDir]);

let packDir;
let attwStatus = 1;
try {
  packDir = mkdtempSync(join(tmpdir(), "m3l-check-exports-"));
  const packStatus = run("pnpm", ["pack", "--pack-destination", packDir], {
    cwd: packageDir,
  });
  if (packStatus !== 0) {
    console.error("check:exports: `pnpm pack` failed; skipping attw.");
  } else {
    const tarball = readdirSync(packDir).find((name) => name.endsWith(".tgz"));
    if (!tarball) {
      console.error(
        `check:exports: \`pnpm pack\` reported success but wrote no .tgz into ${packDir}.`,
      );
    } else {
      attwStatus = run("pnpm", [
        "exec",
        "attw",
        join(packDir, tarball),
        "--profile",
        "esm-only",
      ]);
    }
  }
} finally {
  if (packDir) rmSync(packDir, { recursive: true, force: true });
}

process.exit(publintStatus === 0 && attwStatus === 0 ? 0 : 1);
