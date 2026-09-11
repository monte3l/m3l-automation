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
 * worker — a prior unsplit `eslint .` measured ~4.6GB at `--concurrency=1`
 * vs ~9.0GB at `--concurrency=2`, OOM'ing a fixed 4-vCPU/16GB runner
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
import { fileURLToPath } from "node:url";
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const target = process.argv[2];
  if (!Object.hasOwn(PER_WORKER_GIB, target)) {
    // A bad target is a caller/config bug (a typo in whichever
    // package.json script invokes this), not a transient condition —
    // fail loudly rather than silently degrading to a working run, unlike
    // the detectHostProfile() fallback below.
    process.stderr.write(
      `print-eslint-concurrency: unknown target ${JSON.stringify(target)} (expected one of: ${Object.keys(PER_WORKER_GIB).join(", ")})\n`,
    );
    process.exit(1);
  }
  try {
    const concurrency = resolveEslintConcurrency(target, detectHostProfile());
    process.stdout.write(String(concurrency));
  } catch (error) {
    // detectHostProfile() reads live environment state (os.cpus(),
    // /proc/meminfo, etc.) and can fail for reasons outside this script's
    // control. package.json's `--concurrency=$(node
    // bin/print-eslint-concurrency.mjs <target>)` command substitution
    // discards THIS process's own exit status regardless — the surrounding
    // eslint invocation's status is what actually propagates — so fall back
    // to the safe, always-correct serial value (1) rather than let this
    // failure interpolate as an empty `--concurrency=`.
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.stdout.write("1");
  }
}
