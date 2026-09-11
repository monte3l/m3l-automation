#!/usr/bin/env node
/**
 * Measurement harness for the adaptive-host-budgeting wave
 * (docs/plans/2026-09-08-adaptive-host-budgeting.md). Runs one or more of
 * this repo's heavy gates (lint, typecheck, build, test, the `checks`
 * chain) and reports wall-clock, CPU time, peak memory, parallel
 * efficiency, and (on Linux) PSI pressure deltas — so a Phase-2 tuning
 * candidate is judged against a real number, never inferred.
 *
 * Peak memory is measured via `/usr/bin/time --verbose` (GNU coreutils'
 * `time`, Linux) or `/usr/bin/time -l` (BSD `time`, macOS) — NOT the
 * cgroup-accounting (`systemd-run --user --scope` + `memory.peak`) this
 * wave's originating plan preferred. Both were tried live against this
 * host: `systemd-run --user --scope -p MemoryAccounting=yes -p
 * CPUAccounting=yes` enables accounting but `MemoryPeak`/`CPUUsageNSec`
 * both read back "[not set]" once the scope's process exits, on this
 * host's cgroup delegation — unreliable, so shipping it would silently
 * report wrong numbers rather than the "labelled fallback" the plan
 * itself already anticipated needing. `/usr/bin/time` is simple, already
 * installed (Ubuntu's `time` package), and verified working live. Its
 * known limitation (documented, not fixed): it reports only the largest
 * single child's peak RSS, not a whole process tree's — for a lane that
 * forks workers (vitest, a turbo-orchestrated multi-package build), the
 * reported peak understates the tree's actual footprint. Revisit the
 * cgroup path if that undercount proves to matter for a specific
 * candidate's before/after comparison.
 *
 * No consumer of this harness's numbers exists yet — this is measurement
 * only. Phase 2 candidates are gated on running this, not the other way
 * around.
 *
 * Usage:
 *   node bin/bench-gates.mjs --lane=lint:library [--lane=build ...]
 *   node bin/bench-gates.mjs                       # every lane
 *   node bin/bench-gates.mjs --cold --repeat=3 --sessions=1
 *   node bin/bench-gates.mjs --concurrent           # all selected lanes at once
 *   node bin/bench-gates.mjs --print-budget         # profile+budget only, no run
 *   node bin/bench-gates.mjs --json --out=baseline.json
 *
 * Flags:
 *   --lane=<name>        repeatable; defaults to every lane in LANES
 *   --warm | --cold      default warm; --cold forces turbo-backed lanes
 *                        (build, turbo:typecheck) to bypass their cache,
 *                        and removes each lane's own cacheDir (format's
 *                        Prettier cache, tsc:bin/turbo:typecheck's shared
 *                        tsc incremental cache under node_modules/.cache/tsc)
 *   --isolated|--concurrent  default isolated (one lane at a time)
 *   --repeat=N           default 1; report the median across N runs
 *   --sessions=N         pins the session count in the printed profile/
 *                        budget context (does not spawn fake sessions)
 *   --busy-threshold=N   contention-guard multiplier (default 0.5 — refuse
 *                        when 1-minute load average exceeds N * logical
 *                        cores; a 4-core host at load average 2.0 is
 *                        exactly this threshold)
 *   --force              run anyway despite the contention guard
 *   --print-budget       print the detected profile + derived budget and
 *                        exit; ignores every other flag except --sessions
 *                        and --json
 *   --json               emit one JSON payload instead of human text
 *   --out=<path>         also write the JSON payload to this file
 */
import process from "node:process";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { repoRoot, parseJsonFlag, createReporter } from "./lib/report.mjs";
import {
  DEFAULT_IO,
  detectHostProfile,
  deriveBudget,
} from "./lib/host-profile.mjs";

/**
 * @typedef {{ command: string, turbo: boolean, cacheDir?: string }} Lane
 */

/**
 * One entry per benchmarkable gate. `checks` is a verbatim copy of
 * `lefthook.yml`'s `checks:` pre-push lane command — there is no shared
 * source both files read from today, so keep them in sync by hand if
 * either changes.
 *
 * `format`'s `cacheDir` is Prettier's own default `--cache-location`
 * (`node_modules/.cache/prettier/`, Phase 2 candidate #1) — `clearLaneCacheDir`
 * removes it before a `--cold` run, outside the timed window, so the format
 * lane measures a true uncached run instead of silently reusing whatever the
 * previous invocation left behind.
 *
 * `turbo:typecheck` and `tsc:bin` share `node_modules/.cache/tsc/` (Phase 2
 * candidate #2 — `incremental`/`tsBuildInfoFile` on every tooling tsconfig,
 * one `.tsbuildinfo` file per project under that one directory). `--force`
 * on `turbo:typecheck` alone only bypasses turbo's own cache layer — each
 * package's `tsc -p tsconfig.json` invocation underneath would still reuse
 * its persisted `.tsbuildinfo` state even on a forced turbo re-run, so both
 * lanes also need `clearLaneCacheDir` to wipe the shared directory before a
 * true `--cold` measurement.
 *
 * `lint:library:fast` and `lint:workspace:fast` (Phase 2 candidate #3 —
 * `--cache --cache-strategy content` on the local-only `lint:fast` variant,
 * never on `lint` itself) each write to their own file under
 * `node_modules/.cache/eslint/`, unlike the shared `tsc` cache dir above —
 * the two ESLint invocations lint disjoint file sets, so each lane's
 * `cacheDir` names only its own cache file and clearing one never disturbs
 * the other.
 *
 * @type {Readonly<Record<string, Lane>>}
 */
export const LANES = Object.freeze({
  format: {
    command: "pnpm format:check",
    turbo: false,
    cacheDir: "node_modules/.cache/prettier",
  },
  "lint:library": { command: "pnpm lint:library", turbo: false },
  "lint:workspace": { command: "pnpm lint:workspace", turbo: false },
  "lint:library:fast": {
    command: "pnpm lint:library:fast",
    turbo: false,
    cacheDir: "node_modules/.cache/eslint/library.eslintcache",
  },
  "lint:workspace:fast": {
    command: "pnpm lint:workspace:fast",
    turbo: false,
    cacheDir: "node_modules/.cache/eslint/workspace.eslintcache",
  },
  "turbo:typecheck": {
    command:
      "pnpm exec turbo run typecheck --concurrency=$(node bin/print-concurrency.mjs)",
    turbo: true,
    cacheDir: "node_modules/.cache/tsc",
  },
  "tsc:bin": {
    command: "pnpm exec tsc -p bin/tsconfig.json",
    turbo: false,
    cacheDir: "node_modules/.cache/tsc",
  },
  build: {
    command:
      "pnpm exec turbo run build --concurrency=$(node bin/print-concurrency.mjs)",
    turbo: true,
  },
  "test:unit": { command: "pnpm exec vitest run", turbo: false },
  "test:bin": {
    command: "pnpm exec vitest run --config vitest.bin.config.ts",
    turbo: false,
  },
  "test:web": {
    command: "pnpm exec vitest run --config vitest.web.config.ts",
    turbo: false,
  },
  "test:integration": {
    command: "pnpm exec vitest run --config vitest.integration.config.ts",
    turbo: false,
  },
  checks: {
    command:
      "node bin/verify-signed-range.mjs && node bin/check-commit-trailers.mjs && pnpm check:control-chars && pnpm check:no-docker && pnpm check:file-budget && pnpm check:agents && pnpm check:script-docs && pnpm check:cli-docs && pnpm check:review-size && pnpm check:context-budget && pnpm check:provenance && pnpm check:index && pnpm check:adr-index && pnpm check:adr-claims && pnpm check:adr-provenance && pnpm check:adr-worthiness && pnpm check:harness-freshness && pnpm check:typescript-freshness && pnpm check:retrospective && pnpm check:staleness && pnpm check:logs-index && pnpm check:promotion-stamps && pnpm check:lefthook-shim && pnpm check:skill-evals && pnpm check:claude-cli-version && pnpm check:pnpm-version && pnpm check:review-policy && pnpm check:hooks && pnpm check:skill-frontmatter && pnpm check:mcp",
    turbo: false,
  },
});

// ---------------------------------------------------------------------------
// Pure helpers — parsing, arithmetic, arg handling. No IO.
// ---------------------------------------------------------------------------

/**
 * Parse CLI argv into a structured options object. Exported for unit tests
 * instead of asserting against `process.argv` indirectly.
 *
 * @param {string[]} argv
 * @returns {{
 *   lanes: string[], mode: "warm" | "cold", schedule: "isolated" | "concurrent",
 *   repeat: number, sessions: number | undefined, busyThreshold: number,
 *   force: boolean, printBudget: boolean, out: string | undefined,
 * }}
 */
export function parseArgs(argv) {
  const opts = {
    lanes: /** @type {string[]} */ ([]),
    mode: /** @type {"warm" | "cold"} */ ("warm"),
    schedule: /** @type {"isolated" | "concurrent"} */ ("isolated"),
    repeat: 1,
    sessions: undefined,
    busyThreshold: 0.5,
    force: false,
    printBudget: false,
    out: undefined,
  };
  for (const arg of argv) {
    if (arg === "--cold") opts.mode = "cold";
    else if (arg === "--warm") opts.mode = "warm";
    else if (arg === "--concurrent") opts.schedule = "concurrent";
    else if (arg === "--isolated") opts.schedule = "isolated";
    else if (arg === "--force") opts.force = true;
    else if (arg === "--print-budget") opts.printBudget = true;
    else if (arg.startsWith("--lane="))
      opts.lanes.push(arg.slice("--lane=".length));
    else if (arg.startsWith("--repeat=")) {
      const n = Number(arg.slice("--repeat=".length));
      opts.repeat = Number.isInteger(n) && n > 0 ? n : 1;
    } else if (arg.startsWith("--sessions=")) {
      const n = Number(arg.slice("--sessions=".length));
      if (Number.isInteger(n) && n > 0) opts.sessions = n;
    } else if (arg.startsWith("--busy-threshold=")) {
      const n = Number(arg.slice("--busy-threshold=".length));
      if (Number.isFinite(n) && n > 0) opts.busyThreshold = n;
    } else if (arg.startsWith("--out=")) {
      opts.out = arg.slice("--out=".length);
    }
  }
  return opts;
}

/**
 * Apply `--cold` to a lane's command: a turbo-backed lane gets `--force`
 * appended to its `turbo run <task>` invocation so it bypasses turbo's
 * cache. A lane with no such flag of its own (e.g. `format`'s `cacheDir`,
 * see `clearLaneCacheDir`) is unaffected here — its cache is cleared as a
 * separate, untimed pre-step instead of being folded into the measured
 * command, so the removal itself never counts toward the lane's reported
 * `wallSeconds`/`userSeconds`/`peakRssKiB`.
 *
 * @param {Lane} lane
 * @param {"warm" | "cold"} mode
 * @returns {string}
 */
export function buildLaneCommand(lane, mode) {
  if (mode === "cold" && lane.turbo) {
    // Anchored on the full "pnpm exec turbo run" prefix (every turbo-backed
    // lane's actual shape) rather than a bare "turbo run" — the bare form
    // could in principle match inside a quoted argument elsewhere in the
    // command string, which this anchor rules out.
    return lane.command.replace(/(pnpm exec turbo run \S+)/, "$1 --force");
  }
  return lane.command;
}

/**
 * Remove a lane's cache directory before a cold run. This is a plain `fs`
 * call the harness performs as an un-timed pre-step, not a shell command
 * folded into what `runLaneOnce` measures — unlike turbo's `--force` (a
 * flag on the invocation itself, correctly counted as part of the timed
 * work), Prettier has no such flag, so composing an `rm -rf` prefix into
 * the timed command would have counted cache teardown as measured work.
 * `{ force: true }` already makes a missing directory a no-op (no ENOENT);
 * the try/catch here is for everything else (e.g. `EACCES`/`EPERM`) — a
 * synchronous throw here would otherwise propagate out of `runLaneOnce`
 * itself (not a rejected promise, since it runs before that function's
 * `Promise` executor), breaking that function's documented "always
 * resolves, never rejects" contract. Degrading to a warning and letting the
 * lane run anyway (possibly against a stale cache) is preferable to
 * crashing the whole benchmark batch over one lane's cache teardown.
 *
 * `remove` is injectable (defaults to `rmSync`) purely so a test can force
 * the catch branch without needing a real permission-denied directory,
 * which isn't portably reproducible in a sandboxed test run.
 *
 * `turbo:typecheck` and `tsc:bin` share one `cacheDir` (`node_modules/.cache/tsc`)
 * rather than each getting their own — both lanes' underlying `tsc`
 * invocations write into that one directory (one `.tsbuildinfo` file per
 * project), so clearing it once before either lane's cold run is correct
 * and cheaper than tracking per-project paths here.
 *
 * @param {Lane} lane
 * @param {"warm" | "cold"} mode
 * @param {string} cwd
 * @param {typeof rmSync} [remove]
 * @returns {void}
 */
export function clearLaneCacheDir(lane, mode, cwd, remove = rmSync) {
  if (mode !== "cold" || !lane.cacheDir) return;
  try {
    remove(join(cwd, lane.cacheDir), { recursive: true, force: true });
  } catch (err) {
    console.warn(
      `bench-gates: could not clear cache dir "${lane.cacheDir}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Median of a numeric array (average of the two middle values on an even
 * length). `NaN`/non-finite entries are excluded before computing, so one
 * failed sample doesn't poison the whole median.
 *
 * @param {number[]} numbers
 * @returns {number | null} `null` if no finite values are present
 */
export function median(numbers) {
  const finite = numbers
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  if (finite.length === 0) return null;
  const mid = Math.floor(finite.length / 2);
  return finite.length % 2 === 0
    ? (finite[mid - 1] + finite[mid]) / 2
    : finite[mid];
}

/**
 * Contention guard: is the host already busy enough that a benchmark run
 * would measure contention rather than the lane itself? A 4-core host
 * already at 1-minute load average 2.0 (half its cores already spoken for)
 * is the example this threshold is calibrated against.
 *
 * @param {{ loadAvg1: number, logicalCores: number, threshold: number }} args
 * @returns {boolean}
 */
export function isHostBusy({ loadAvg1, logicalCores, threshold }) {
  return loadAvg1 > logicalCores * threshold;
}

/**
 * Parse GNU coreutils `time --verbose` report text (Linux).
 *
 * @param {string | null} text
 * @returns {{ userSeconds: number, systemSeconds: number, wallSeconds: number, peakRssKiB: number } | null}
 */
export function parseGnuTimeVerbose(text) {
  if (!text) return null;
  const userSeconds = Number(/User time \(seconds\): ([\d.]+)/.exec(text)?.[1]);
  const systemSeconds = Number(
    /System time \(seconds\): ([\d.]+)/.exec(text)?.[1],
  );
  const elapsedRaw = /Elapsed \(wall clock\) time.*?: ([\d:.]+)/.exec(
    text,
  )?.[1];
  const peakRssKiB = Number(
    /Maximum resident set size \(kbytes\): (\d+)/.exec(text)?.[1],
  );
  const wallSeconds = elapsedRaw ? parseTimeVElapsed(elapsedRaw) : NaN;
  if (
    !Number.isFinite(userSeconds) ||
    !Number.isFinite(systemSeconds) ||
    !Number.isFinite(wallSeconds) ||
    !Number.isFinite(peakRssKiB)
  ) {
    return null;
  }
  return { userSeconds, systemSeconds, wallSeconds, peakRssKiB };
}

/**
 * Parse GNU `time`'s `h:mm:ss` or `m:ss.ss` elapsed-time format into
 * seconds.
 *
 * @param {string} raw
 * @returns {number}
 */
export function parseTimeVElapsed(raw) {
  const parts = raw.split(":").map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return NaN;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0];
}

/**
 * Parse BSD `time -l` report text (macOS). Unproven on real hardware, same
 * caveat as `bin/lib/host-profile.mjs`'s Darwin collector.
 *
 * @param {string | null} text
 * @returns {{ userSeconds: number, systemSeconds: number, wallSeconds: number, peakRssKiB: number } | null}
 */
export function parseBsdTimeDashL(text) {
  if (!text) return null;
  const wallSeconds = Number(/([\d.]+)\s+real/.exec(text)?.[1]);
  const userSeconds = Number(/([\d.]+)\s+user/.exec(text)?.[1]);
  const systemSeconds = Number(/([\d.]+)\s+sys/.exec(text)?.[1]);
  const peakRssBytes = Number(
    /(\d+)\s+maximum resident set size/.exec(text)?.[1],
  );
  if (
    !Number.isFinite(wallSeconds) ||
    !Number.isFinite(userSeconds) ||
    !Number.isFinite(systemSeconds) ||
    !Number.isFinite(peakRssBytes)
  ) {
    return null;
  }
  return {
    userSeconds,
    systemSeconds,
    wallSeconds,
    peakRssKiB: Math.round(peakRssBytes / 1024),
  };
}

/**
 * CPU-time ÷ wall-clock — the parallel-efficiency number the wave's
 * lane-scheduling question (Phase 2 candidate #5) needs. `0` when wall
 * time is non-positive rather than `Infinity`/`NaN`, so a JSON consumer
 * never has to special-case a non-finite value.
 *
 * @param {number} userSeconds
 * @param {number} systemSeconds
 * @param {number} wallSeconds
 * @returns {number}
 */
export function computeCpuEfficiency(userSeconds, systemSeconds, wallSeconds) {
  if (!(wallSeconds > 0)) return 0;
  return (userSeconds + systemSeconds) / wallSeconds;
}

/**
 * Delta between two PSI `total` readings (microseconds of stall time
 * accumulated), converted to whole milliseconds. `total` is monotonic, so
 * this is a real "how much stall occurred during this lane" signal, unlike
 * the decayed `avgN` fields.
 *
 * @param {number | undefined} before
 * @param {number | undefined} after
 * @returns {number | null}
 */
export function pressureDeltaMs(before, after) {
  if (!Number.isFinite(before) || !Number.isFinite(after)) return null;
  return Math.round((after - before) / 1000);
}

// ---------------------------------------------------------------------------
// Impure execution — one lane run, wrapped in whichever `time` binary this
// platform has.
// ---------------------------------------------------------------------------

/**
 * @param {NodeJS.Platform} platform
 * @returns {{ bin: string, args: string[], parse: (text: string | null) => ReturnType<typeof parseGnuTimeVerbose> } | null}
 *   `null` when no supported `time` binary is available — the caller falls
 *   back to hrtime-only wall-clock timing.
 */
function resolveTimeBinary(platform) {
  if (platform === "linux" && existsSync("/usr/bin/time")) {
    return {
      bin: "/usr/bin/time",
      args: ["--verbose"],
      parse: parseGnuTimeVerbose,
    };
  }
  if (platform === "darwin" && existsSync("/usr/bin/time")) {
    return { bin: "/usr/bin/time", args: ["-l"], parse: parseBsdTimeDashL };
  }
  return null;
}

/**
 * Run one lane once, returning its measured metrics. Always resolves
 * (never rejects) — a failing lane still produces a timing sample, with
 * `exitCode` reported so the caller can flag it.
 *
 * @param {string} name
 * @param {Lane} lane
 * @param {{ mode: "warm" | "cold", cwd: string, timeBinary: ReturnType<typeof resolveTimeBinary>, tmpDir: string }} ctx
 * @returns {Promise<{ exitCode: number | null, wallSeconds: number, userSeconds: number | null, systemSeconds: number | null, peakRssKiB: number | null, cpuEfficiency: number | null, timingSource: "time" | "time-parse-failed" | "hrtime-only", parseError: string | null, spawnError?: string }>}
 */
function runLaneOnce(name, lane, ctx) {
  clearLaneCacheDir(lane, ctx.mode, ctx.cwd);
  const command = buildLaneCommand(lane, ctx.mode);
  const reportPath = ctx.timeBinary
    ? join(
        ctx.tmpDir,
        `${name.replace(/[^a-z0-9]/gi, "_")}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
      )
    : null;
  const spawnArgs = ctx.timeBinary
    ? [
        ctx.timeBinary.bin,
        [
          ...ctx.timeBinary.args,
          "-o",
          /** @type {string} */ (reportPath),
          "--",
          "bash",
          "-lc",
          command,
        ],
      ]
    : ["bash", ["-lc", command]];

  const wallStart = process.hrtime.bigint();
  return new Promise((resolve) => {
    const child = spawn(spawnArgs[0], spawnArgs[1], {
      cwd: ctx.cwd,
      stdio: "inherit",
    });
    // A bare EventEmitter throws on an unhandled "error" event — spawn can
    // emit one (ENOENT, EACCES, a PATH issue) before "close" ever fires, and
    // with no listener that crashes this whole harness mid-batch instead of
    // resolving with a reported failure, contradicting this function's own
    // "always resolves" contract. `settled` guards against the rare case
    // both events fire for the same child.
    let settled = false;
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      resolve({
        exitCode: null,
        wallSeconds: Number(process.hrtime.bigint() - wallStart) / 1e9,
        userSeconds: null,
        systemSeconds: null,
        peakRssKiB: null,
        cpuEfficiency: null,
        timingSource: "hrtime-only",
        parseError: null,
        spawnError: err.message,
      });
    });
    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      const hrtimeWallSeconds =
        Number(process.hrtime.bigint() - wallStart) / 1e9;
      let parsed = null;
      // Distinguish "no time binary was ever available" (hrtime-only is the
      // expected, already-warned-once-globally degradation) from "a time
      // binary ran but its report couldn't be read or parsed" (an
      // unexpected per-lane degradation this harness's own contract — "a
      // candidate is judged against a real number, never inferred" — says
      // must not pass silently). `parseError` carries the reason so `main`
      // can warn and the JSON payload can distinguish "not measured" from
      // "measured as absent".
      let parseError = null;
      if (reportPath) {
        let reportText = null;
        try {
          reportText = readFileSync(reportPath, "utf8");
        } catch (err) {
          parseError = `could not read time report: ${err.message}`;
        } finally {
          try {
            rmSync(reportPath, { force: true });
          } catch {
            // best-effort cleanup only
          }
        }
        if (reportText !== null) {
          parsed = ctx.timeBinary?.parse(reportText) ?? null;
          if (parsed === null) {
            parseError = "time report could not be parsed (unexpected format)";
          }
        }
      }
      const wallSeconds = parsed?.wallSeconds ?? hrtimeWallSeconds;
      resolve({
        exitCode,
        wallSeconds,
        userSeconds: parsed?.userSeconds ?? null,
        systemSeconds: parsed?.systemSeconds ?? null,
        peakRssKiB: parsed?.peakRssKiB ?? null,
        cpuEfficiency: parsed
          ? computeCpuEfficiency(
              parsed.userSeconds,
              parsed.systemSeconds,
              wallSeconds,
            )
          : null,
        timingSource: parsed
          ? "time"
          : reportPath
            ? "time-parse-failed"
            : "hrtime-only",
        parseError,
      });
    });
  });
}

/**
 * Read the three Linux PSI files' `total` fields, or `null` off-Linux.
 *
 * @param {typeof import("./lib/host-profile.mjs").DEFAULT_IO} io
 * @returns {{ cpu: number | undefined, memory: number | undefined, io: number | undefined } | null}
 */
function readPressureTotals(io) {
  if (process.platform !== "linux") return null;
  const readTotal = (path) => {
    const text = io.readFile(path);
    const match = text ? /^some.*?total=(\d+)/m.exec(text) : null;
    return match ? Number(match[1]) : undefined;
  };
  return {
    cpu: readTotal("/proc/pressure/cpu"),
    memory: readTotal("/proc/pressure/memory"),
    io: readTotal("/proc/pressure/io"),
  };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main() {
  const { json, argv } = parseJsonFlag();
  const opts = parseArgs(argv);
  const reporter = createReporter(json);
  const cwd = repoRoot(import.meta.url);

  const profile = detectHostProfile({ sessions: opts.sessions });
  const budget = deriveBudget(profile);
  // A total-detection failure (e.g. /proc/meminfo unreadable) falls back to
  // a plausible-looking sentinel (0 GiB, 1 core) that a reader could mistake
  // for a real tiny-host measurement — surface it explicitly rather than
  // letting the budget derived from it pass without comment.
  for (const warning of profile.warnings ?? []) reporter.warn(warning);

  if (opts.printBudget) {
    reporter.info(`Profile: ${JSON.stringify(profile, null, 2)}`);
    reporter.info(`Budget:  ${JSON.stringify(budget, null, 2)}`);
    reporter.finish({ profile, budget });
    return;
  }

  const [loadAvg1] = loadavg();
  if (
    !opts.force &&
    isHostBusy({
      loadAvg1,
      logicalCores: profile.logicalCores,
      threshold: opts.busyThreshold,
    })
  ) {
    reporter.error(
      `Host looks busy (1-min load average ${loadAvg1.toFixed(2)} > ` +
        `${opts.busyThreshold} * ${profile.logicalCores} logical cores) — a benchmark ` +
        `taken now would measure contention, not the lane itself. Re-run on a quiet ` +
        `box, or pass --force to override.`,
    );
    reporter.finish();
    process.exitCode = 1;
    return;
  }

  const laneNames =
    opts.lanes.length > 0 ? [...new Set(opts.lanes)] : Object.keys(LANES);
  const unknown = laneNames.filter((n) => !(n in LANES));
  if (unknown.length > 0) {
    reporter.error(
      `Unknown lane(s): ${unknown.join(", ")}. Valid lanes: ${Object.keys(LANES).join(", ")}`,
    );
    reporter.finish();
    process.exitCode = 1;
    return;
  }

  const timeBinary = resolveTimeBinary(process.platform);
  if (!timeBinary) {
    reporter.warn(
      `No supported "time" binary found for platform "${process.platform}" — ` +
        `reporting wall-clock only (no CPU time / peak memory).`,
    );
  }

  const tmpDir = mkdtempSync(join(tmpdir(), "bench-gates-"));
  /** @type {Record<string, { samples: object[], failedIterations: number, medianWallSeconds: number | null, medianCpuEfficiency: number | null, medianPeakRssKiB: number | null, pressureDeltaMs: object | null }>} */
  const results = {};

  try {
    for (let iteration = 0; iteration < opts.repeat; iteration++) {
      const pressureBefore = readPressureTotals(DEFAULT_IO);
      /** @type {[string, Awaited<ReturnType<typeof runLaneOnce>>][]} */
      let pairs;
      if (opts.schedule === "concurrent") {
        const settled = await Promise.all(
          laneNames.map((name) =>
            runLaneOnce(name, LANES[name], {
              mode: opts.mode,
              cwd,
              timeBinary,
              tmpDir,
            }),
          ),
        );
        pairs = laneNames.map((name, i) => [name, settled[i]]);
      } else {
        pairs = [];
        for (const name of laneNames) {
          const sample = await runLaneOnce(name, LANES[name], {
            mode: opts.mode,
            cwd,
            timeBinary,
            tmpDir,
          });
          pairs.push([name, sample]);
        }
      }
      const pressureAfter = readPressureTotals(DEFAULT_IO);

      for (const [name, sample] of pairs) {
        results[name] ??= {
          samples: [],
          failedIterations: 0,
          medianWallSeconds: null,
          medianCpuEfficiency: null,
          medianPeakRssKiB: null,
          pressureDeltaMs: null,
        };
        results[name].samples.push(sample);
        if (sample.exitCode !== 0) {
          // A failed lane's numbers are not a real measurement — surface it
          // as an error (flips report.ok, matches "never swallow silently")
          // rather than a warning a caller could miss in the JSON payload.
          const detail = sample.spawnError ? ` (${sample.spawnError})` : "";
          reporter.error(
            `Lane "${name}" exited ${sample.exitCode} on iteration ${iteration + 1}${detail}; its timing is not a valid measurement.`,
          );
        } else if (sample.timingSource === "time-parse-failed") {
          // The lane itself ran fine, but the time-binary report that was
          // supposed to back this measurement couldn't be read/parsed — the
          // reported numbers silently fell back to hrtime-only (no CPU/
          // memory data) rather than the real measurement this harness
          // exists to produce. Warn per-occurrence rather than staying
          // silent just because the command's own exit code was 0.
          reporter.warn(
            `Lane "${name}" iteration ${iteration + 1}: ${sample.parseError} — falling back to wall-clock-only timing (no CPU time / peak memory for this sample).`,
          );
        }
      }
      if (pressureBefore && pressureAfter) {
        // Attribute the whole batch's pressure delta to every lane in it —
        // isolated mode makes this per-lane exact; concurrent mode is
        // necessarily a shared total across the batch (that IS the number
        // the lane-scheduling question needs).
        const delta = {
          cpu: pressureDeltaMs(pressureBefore.cpu, pressureAfter.cpu),
          memory: pressureDeltaMs(pressureBefore.memory, pressureAfter.memory),
          io: pressureDeltaMs(pressureBefore.io, pressureAfter.io),
        };
        for (const [name] of pairs) results[name].pressureDeltaMs = delta;
      }
    }
  } finally {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup only
    }
  }

  for (const name of laneNames) {
    const lane = results[name];
    // A failed run's timing is not a real measurement of the lane — exclude
    // it from the medians rather than let it silently pull them toward a
    // fast-crash or slow-hang-then-exit number (it stays visible in
    // `samples` and in `failedIterations`, and its exit already emitted a
    // reporter.error() above).
    const okSamples = lane.samples.filter((s) => s.exitCode === 0);
    lane.failedIterations = lane.samples.length - okSamples.length;
    lane.medianWallSeconds = median(okSamples.map((s) => s.wallSeconds));
    lane.medianCpuEfficiency = median(
      okSamples.map((s) => s.cpuEfficiency).filter((v) => v !== null),
    );
    lane.medianPeakRssKiB = median(
      okSamples.map((s) => s.peakRssKiB).filter((v) => v !== null),
    );
    reporter.info(
      `${name}: median wall ${lane.medianWallSeconds?.toFixed(2) ?? "n/a"}s` +
        (lane.medianCpuEfficiency !== null
          ? `, CPU efficiency ${lane.medianCpuEfficiency.toFixed(2)}x`
          : "") +
        (lane.medianPeakRssKiB !== null
          ? `, peak RSS ${(lane.medianPeakRssKiB / 1024).toFixed(0)} MiB`
          : "") +
        (lane.failedIterations > 0
          ? ` (${lane.failedIterations}/${lane.samples.length} iteration(s) failed, excluded)`
          : ""),
    );
  }

  const payload = reporter.finish({
    profile,
    budget,
    mode: opts.mode,
    schedule: opts.schedule,
    lanes: results,
  });
  if (opts.out) {
    writeFileSync(opts.out, `${JSON.stringify(payload, null, 2)}\n`);
    if (!json) console.log(`\nWritten: ${opts.out}`);
  }
  // Any lane failure already emitted reporter.error() (flips payload.ok to
  // false) — reflect that in the process exit code too, so a failed
  // benchmark run is detectable by a caller checking `$?` alone, not only
  // one parsing the JSON payload.
  if (!payload.ok) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((cause) => {
    console.error("bench-gates failed:", cause);
    process.exit(1);
  });
}
