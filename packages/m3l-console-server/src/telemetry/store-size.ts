/**
 * `telemetry/store-size` — {@link sampleStoreSizeOnBoot}, the boot-time
 * sampler that measures the console store's on-disk footprint exactly once
 * and reports it as the single `store.health` sample
 * {@link "./port.js".M3LTelemetryRecorder} accepts (X8 slice 3d).
 *
 * SYNCHRONOUS, AND DELIBERATELY BUILT ON `node:fs`'s `statSync`. Every
 * {@link "./port.js".M3LTelemetryRecorder} method is synchronous, and the
 * call site in `main.ts`'s `buildRuntimeAndBindListener` sits beside
 * `runtime.runs?.orchestrator.reconcileOnBoot()`, which is synchronous for
 * the same reason — so this module reaches for the synchronous primitive
 * rather than `fs/promises`. That is a REAL coupling, not an incidental
 * one: `tests/telemetry-store-size.test.ts` `vi.spyOn`s `statSync` itself in
 * two cases (to drive a degenerate size, and to prove `":memory:"` costs no
 * syscall), and a move to `fs/promises` `stat` or an `open()`/`FileHandle`
 * pair would silently stop those spies intercepting — making one case fail
 * and the other go vacuous. Changing the primitive is therefore a two-spoke
 * change (implementer + test author), never a drop-in.
 *
 * WHAT COUNTS AS "THE STORE". `store/store.ts` opens SQLite in WAL mode,
 * which keeps two sidecars — `<location>-wal` and `<location>-shm` — beside
 * the main database file, and the port documents `sizeBytes` as "the store's
 * on-disk size in bytes". So the sample is the SUM of all three, and
 * tolerance is PER-FILE: a sidecar exists only while the database is open in
 * WAL mode and vanishes on a clean checkpoint, so an absent one is normal
 * operation and must never discard the main file's size.
 *
 * WHY NOTHING IS EMITTED RATHER THAN `0`. `store.health` is a VALUE-BEARING
 * metric — `console_telemetry_rollup` persists it with a non-NULL
 * `sum_value` — so a fabricated `0` would read forever as "the store is
 * empty" rather than as "the store was not measured". An absent measurement
 * beats a wrong one, which is why both the `":memory:"` branch and the
 * unreadable-main-file branch record nothing at all. An existing but empty
 * main file is the opposite case: that `0` is a genuine measurement and IS
 * recorded.
 *
 * @packageDocumentation
 */

import * as fs from "node:fs";

import { Core } from "@m3l-automation/m3l-common";

import type { M3LTelemetryRecorder } from "./port.js";

/**
 * The `location` an in-memory store is opened with. Branching on this exact
 * literal mirrors `store/store.ts`'s own `ensureParentDirectory`, which skips
 * its `mkdirSync` for the same value for the same reason: it names no path on
 * disk.
 */
const IN_MEMORY_LOCATION = ":memory:";

/**
 * The WAL-mode sidecar suffixes appended to `location`, each stat'd and
 * tolerated independently — see this module's doc on per-file tolerance.
 */
const WAL_SIDECAR_SUFFIXES: readonly string[] = ["-wal", "-shm"];

/**
 * The floor a normalised size sample is clamped to — the rollup repository
 * behind {@link M3LTelemetryRecorder} rejects a negative `valueBytes`
 * (`store/telemetry-validation.ts`'s `requireValidMeasure`).
 */
const SIZE_BYTES_FLOOR = 0;

/**
 * The ceiling a normalised size sample is clamped to.
 *
 * `Number.isFinite(1e300)` is `true`, so a finiteness guard alone does not
 * prevent values that exceed `Number.MAX_SAFE_INTEGER`. `requireValidMeasure`
 * rejects any `valueBytes` that is not a non-negative safe integer, and
 * {@link M3LTelemetryRecorder}'s contract is never-throws — meaning the
 * rejection is swallowed by `telemetry-recorder.ts`'s fan-out as a logged
 * warning and the row is silently dropped. Clamping to `MAX_SAFE_INTEGER`
 * rather than to `0` preserves the information that the store was very large
 * rather than making it appear empty.
 */
const SIZE_BYTES_CEILING = Number.MAX_SAFE_INTEGER;

/**
 * The structural shape this sampler needs from a console store: nothing more
 * than `location`. Declared here, rather than imported from
 * `store/store.ts`, so self-measurement never creates a `telemetry -> store`
 * ESLint zone edge (`eslint.config.js`: `telemetry/` may import only
 * `errors/`, because the store-backed recorder is `telemetry-recorder.ts` at
 * the `src/` root) — the same trick, for the same reason, as
 * `http/routes/health.ts`'s `M3LReadinessProbe` for `{ isOpen }`.
 * `M3LConsoleStoreLifecycle` satisfies this structurally, so do NOT
 * "simplify" it into an import later.
 *
 * @example
 * ```ts
 * const probe: M3LStoreLocationProbe = { location: "data/console/console.sqlite" };
 * ```
 */
interface M3LStoreLocationProbe {
  readonly location: string;
}

/**
 * Turns a raw summed byte count into a value the telemetry repository can
 * never reject: always a non-negative safe integer in
 * `[0, Number.MAX_SAFE_INTEGER]`.
 *
 * Structurally identical to `telemetry/duration.ts`'s `toValidDurationMs`,
 * which solves the same problem for milliseconds — a unit-agnostic helper
 * shared by both belongs in that module rather than in a third one, and is
 * left as a follow-up so this slice stays scoped to the sampler.
 *
 * `Math.round` runs BEFORE the ceiling clamp, not after: `Math.round(1e300)`
 * is `1e300`, so a ceiling applied first would be undone by the rounding and
 * leave a non-safe integer behind — the exact defect X8 slice 3a shipped in
 * `toValidDurationMs` and had to fix.
 *
 * @param rawSizeBytes - A summed `Stats.size` reading. May be fractional,
 * negative or larger than `Number.MAX_SAFE_INTEGER` if the filesystem (or an
 * injected `statSync`) reports a degenerate size.
 * @returns A non-negative safe integer, safe to hand to
 * {@link M3LTelemetryRecorder.storeHealth}.
 */
function toValidSizeBytes(rawSizeBytes: number): number {
  if (!Number.isFinite(rawSizeBytes)) {
    return SIZE_BYTES_FLOOR;
  }
  // Round first, then clamp: Math.round(1e300) === 1e300, so the ceiling must
  // be applied after rounding, not before.
  const rounded = Math.max(SIZE_BYTES_FLOOR, Math.round(rawSizeBytes));
  return Math.min(rounded, SIZE_BYTES_CEILING);
}

/**
 * Measures the console store's on-disk footprint once and records it as a
 * single `store.health` sample. Never throws: it runs during boot, strictly
 * before the listener binds, so an unmeasurable store must never become a
 * failed start.
 *
 * Three outcomes, in the order they are decided:
 *
 * 1. `store.location` is `":memory:"` — nothing is recorded and nothing is
 *    stat'd. Recognised BEFORE any filesystem call, so an in-memory store
 *    costs no syscall at boot.
 * 2. The MAIN database file cannot be stat'd — nothing is recorded, and
 *    exactly one `logger.warning` names the location and the underlying
 *    failure (an errno error's own message carries its `ENOENT`/`ENOTDIR`
 *    code). The warning is the only trace an unreadable database leaves, so
 *    omitting it would turn an absent metric into a silent failure.
 * 3. The main file is measurable — one sample carrying the summed size of
 *    the main file plus whichever WAL sidecars exist, normalised by
 *    {@link toValidSizeBytes}.
 *
 * The emit itself is deliberately NOT wrapped in `try`/`catch`:
 * {@link M3LTelemetryRecorder} never throws by contract (`telemetry/port.ts`),
 * the same stance `runs/orchestrator.ts`'s `recordFinish` documents. The
 * guard belongs around `statSync`, and only there.
 *
 * @param options - The store to measure, the recorder to report through, and
 * the logger the single failure report goes to.
 * @example
 * ```ts
 * import { sampleStoreSizeOnBoot } from "@m3l-automation/m3l-console-server/telemetry/store-size.js";
 *
 * // From `main.ts`'s pre-bind boot slot, beside `reconcileOnBoot()`.
 * sampleStoreSizeOnBoot({
 *   store,
 *   telemetry: runtime.telemetry,
 *   logger: runtime.logger,
 * });
 * ```
 */
export function sampleStoreSizeOnBoot(options: {
  readonly store: M3LStoreLocationProbe;
  readonly telemetry: M3LTelemetryRecorder;
  readonly logger: Core.M3LLogger;
}): void {
  const { location } = options.store;
  if (location === IN_MEMORY_LOCATION) {
    return;
  }

  let totalBytes: number;
  try {
    totalBytes = fs.statSync(location).size;
  } catch (cause) {
    options.logger.warning(
      `console store size could not be measured at ${location}`,
      { location, message: Core.getErrorMessage(cause) },
    );
    return;
  }

  for (const suffix of WAL_SIDECAR_SUFFIXES) {
    try {
      totalBytes += fs.statSync(`${location}${suffix}`).size;
    } catch {
      // Tolerated per-file and silently: a WAL sidecar exists only while the
      // database is open in WAL mode and vanishes on a clean checkpoint, so
      // its absence is normal operation, not a diagnostic event.
    }
  }

  options.telemetry.storeHealth({ sizeBytes: toValidSizeBytes(totalBytes) });
}
