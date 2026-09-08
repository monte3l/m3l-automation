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
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { repoRoot } from "./lib/report.mjs";

const root = repoRoot(import.meta.url);
const packageDir = join(root, "packages/m3l-common");

/**
 * Describe a failed/unspawnable command without guessing at the cause —
 * mirrors `bin/check-test-counts.mjs`'s `formatCollectFailure` shape. Pure:
 * takes a `spawnSync`-shaped result plus the command that produced it.
 *
 * @param {{ error?: NodeJS.ErrnoException, signal?: string | null }} res
 * @param {string} command
 * @param {string[]} args
 * @returns {string}
 */
export function formatRunFailure(res, command, args) {
  const invocation = `${command} ${args.join(" ")}`;
  if (res.error) {
    return `check:exports: could not run \`${invocation}\`: ${res.error.message}`;
  }
  if (res.signal) {
    return `check:exports: \`${invocation}\` was killed by ${res.signal}.`;
  }
  return `check:exports: \`${invocation}\` failed.`;
}

/**
 * Picks the `.tgz` `pnpm pack` wrote out of a temp directory's listing. Pure.
 *
 * @param {string[]} fileNames
 * @returns {string | undefined}
 */
export function findTarball(fileNames) {
  return fileNames.find((name) => name.endsWith(".tgz"));
}

/**
 * Combines `publint`'s and `attw`'s exit statuses into this script's own.
 * Pure. `attwStatus` is `undefined` when `attw` was never reached (pack
 * failed or produced no tarball) — treated as a failure, not a pass by
 * omission.
 *
 * @param {number} publintStatus
 * @param {number | undefined} attwStatus
 * @returns {0 | 1}
 */
export function computeExitCode(publintStatus, attwStatus) {
  return publintStatus === 0 && attwStatus === 0 ? 0 : 1;
}

/**
 * Runs a command, streaming its output straight to this process's
 * stdout/stderr (`stdio: "inherit"`) so the underlying tool's own formatting
 * survives — both `publint` and `attw` print human-readable, colorized
 * reports that a captured-and-replayed buffer would flatten. Not unit
 * tested: it always spawns a real child process, matching the convention in
 * `bin/check-deps.mjs`/`bin/check-licenses.mjs`, whose own `run()` wrappers
 * are exercised only through `pnpm check:exports` itself, never mocked.
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
  if (res.error || res.signal) {
    console.error(formatRunFailure(res, command, args));
    return 1;
  }
  return res.status ?? 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const publintStatus = run("pnpm", ["exec", "publint", packageDir]);

  let packDir;
  /** @type {number | undefined} */
  let attwStatus;
  try {
    packDir = mkdtempSync(join(tmpdir(), "m3l-check-exports-"));
    const packStatus = run("pnpm", ["pack", "--pack-destination", packDir], {
      cwd: packageDir,
    });
    if (packStatus !== 0) {
      console.error("check:exports: `pnpm pack` failed; skipping attw.");
    } else {
      const tarball = findTarball(readdirSync(packDir));
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

  process.exit(computeExitCode(publintStatus, attwStatus));
}
