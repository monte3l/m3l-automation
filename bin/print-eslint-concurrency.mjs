#!/usr/bin/env node
/**
 * Prints a host-derived `--concurrency` value for a local-only ESLint
 * `*:fast` target (`lint:library:fast` / `lint:workspace:fast` —
 * P3.6 of docs/plans/2026-09-08-adaptive-host-budgeting.md).
 *
 * Deliberately NOT wired into `lint:library`/`lint:workspace` — the plain
 * scripts pre-push (lefthook.yml) and CI's `lint-library`/`lint-workspace`
 * jobs both call directly. Those stay pinned at `--concurrency=1`: CI's
 * split into two jobs exists specifically because typescript-eslint's
 * `projectService` duplicates the *entire* typed-lint TS program per
 * worker — a prior unsplit `eslint . --concurrency=2` measured 4.6GB vs
 * 4.6GB→9.0GB at `--concurrency=1`, OOM'ing a fixed 4-vCPU/16GB runner
 * (issue #734, see `.github/workflows/ci.yml`'s comment above the
 * `lint-library` job). A fixed CI runner spec can't stand in for a live
 * host's actual available memory, so this script only ever runs by hand,
 * locally, against `os.freemem()`-derived numbers for THIS machine.
 *
 * `deriveBudget`'s `perWorkerGiB` option (`bin/lib/host-profile.mjs`,
 * default 1 GiB) is sized for build/typecheck/vitest workers, far smaller
 * than a typed-lint program copy — each target below passes its own
 * measured single-worker peak instead (the same numbers documented in
 * `.github/workflows/ci.yml`'s `lint-library`/`lint-workspace` comment).
 * `workers` (not `concurrentLaneWorkers`) is the right budget field here:
 * `*:fast` runs standalone, never alongside a sibling pre-push lane, so
 * there is no sibling-lane contention to halve for.
 *
 * Usage:
 *   node bin/print-eslint-concurrency.mjs library    # prints an integer, e.g. "2"
 *   node bin/print-eslint-concurrency.mjs workspace
 */
import { detectHostProfile, deriveBudget } from "./lib/host-profile.mjs";

/** @typedef {import("./lib/host-profile.mjs").HostProfile} HostProfile */

const PER_WORKER_GIB = {
  library: 3.1,
  workspace: 3.8,
};

/**
 * @param {"library" | "workspace"} target
 * @param {HostProfile} profile
 * @returns {number}
 */
export function resolveEslintConcurrency(target, profile) {
  const perWorkerGiB = PER_WORKER_GIB[target];
  if (perWorkerGiB === undefined) {
    throw new Error(
      `print-eslint-concurrency: unknown target ${JSON.stringify(target)} (expected one of: ${Object.keys(PER_WORKER_GIB).join(", ")})`,
    );
  }
  return deriveBudget(profile, { perWorkerGiB }).workers;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const target = process.argv[2];
  try {
    const concurrency = resolveEslintConcurrency(target, detectHostProfile());
    process.stdout.write(String(concurrency));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}
