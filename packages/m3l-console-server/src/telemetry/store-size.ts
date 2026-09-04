/**
 * `telemetry/store-size` — {@link sampleStoreSizeOnBoot}, the boot-time
 * sampler that measures the console store's on-disk footprint exactly once
 * and reports it as the single `store.health` sample
 * {@link "./port.js".M3LTelemetryRecorder} accepts (X8 slice 3d).
 *
 * SYNCHRONOUS, AND DELIBERATELY BUILT ON `node:fs`'s `statSync`. The reason
 * is where this runs, not what it costs: the call site is `main.ts`'s
 * `buildRuntimeAndBindListener`, in the PRE-BIND BOOT PATH beside
 * `runtime.runs?.orchestrator.reconcileOnBoot()`, which is synchronous for
 * the same reason — and every {@link "./port.js".M3LTelemetryRecorder} method
 * is synchronous too, so awaiting here would buy nothing while putting a
 * microtask boundary between the measurement and the listener binding.
 * `statSync` is metadata-only, so its cost does not depend on how far the
 * database or its `-wal` sidecar has grown; only the number of files stat'd
 * (at most three) bounds it.
 *
 * The primitive is nonetheless a REAL coupling, not an incidental one:
 * `tests/telemetry-store-size.test.ts` `vi.spyOn`s `statSync` itself to drive
 * per-file errno failures, degenerate sizes, and the proof that `":memory:"`
 * costs no syscall at all. A move to `fs/promises` `stat` or an
 * `open()`/`FileHandle` pair would silently stop those spies intercepting,
 * making some cases fail and others go vacuous. Changing the primitive is
 * therefore a two-spoke change (implementer + test author), never a drop-in.
 *
 * WHAT COUNTS AS "THE STORE". `store/store.ts` opens SQLite in WAL mode,
 * which keeps two sidecars — `<location>-wal` and `<location>-shm` — beside
 * the main database file, and the port documents `sizeBytes` as "the store's
 * on-disk size in bytes". So the sample is the SUM of all three.
 *
 * SIDECAR TOLERANCE STOPS AT `ENOENT`. A sidecar exists only while the
 * database is open in WAL mode and vanishes on a clean checkpoint, so an
 * ABSENT one is normal operation and must never discard the main file's size.
 * That tolerance is scoped to absence and to nothing else: a sidecar that
 * EXISTS but cannot be stat'd (`EACCES` after a uid change, `EIO`/`ESTALE` on
 * a degraded mount) is an unmeasurable COMPONENT of the footprint, and a
 * `-wal` routinely dwarfs the main file. Summing only what remained would
 * report a figure byte-identical to a cleanly checkpointed store, so the
 * metric whose whole purpose is spotting unbounded growth would read
 * "healthy" exactly when its largest component could not be measured. The
 * failing path's suffix does say WHICH sidecar it was, so an `-shm`-only
 * failure could in principle be summed around; declining it too is a
 * decision, not an oversight. `-shm` is the WAL index — small, bounded, and
 * rebuilt from the `-wal` — so an unstattable `-shm` reports almost no
 * missing bytes but does report that the WAL machinery itself is unhealthy,
 * which is exactly the condition this metric exists to surface. Its value is
 * the SIGNAL, not the bytes. So every non-`ENOENT` sidecar failure DECLINES
 * the measurement (and warns about it once) rather than recording a partial
 * sum.
 *
 * WHERE THAT FOLLOWS THE PROJECT RULE AND WHERE IT DEPARTS FROM IT.
 * `docs/contributing/style-guide.md`'s filesystem-error rule has two halves:
 * tolerate only `ENOENT` (via a small denylist `Set`, never a wrapped whole
 * `catch`), and RE-THROW `EACCES`/`EPERM`. The first half is followed
 * exactly. The second is a CONSCIOUS DEPARTURE, stated here rather than left
 * implicit: this module reports instead of re-throwing, because it runs in
 * the pre-bind boot path described above, where a throw would turn a degraded
 * mount into a failed start. The departure is confined to the propagation
 * mechanism — an unmeasurable sidecar is still treated as a fault and still
 * surfaced, as a warning plus a withheld sample rather than as an exception.
 *
 * WHY NOTHING IS EMITTED RATHER THAN `0`. `store.health` is a VALUE-BEARING
 * metric — `console_telemetry_rollup` persists it with a non-NULL
 * `sum_value` — so a fabricated `0` would read forever as "the store is
 * empty" rather than as "the store was not measured". An absent measurement
 * beats a wrong one, which is why the `":memory:"` branch, the
 * unreadable-main-file branch, the unreadable-sidecar branch AND the
 * degenerate-reading branch all record nothing. A merely IMPRECISE reading is
 * the opposite case: a fractional size is rounded and an
 * over-`MAX_SAFE_INTEGER` size is clamped, because each still measures a real
 * file (see {@link toValidSizeBytes}). A non-finite or negative size measures
 * nothing at all — flooring it to `0` would fabricate the very reading this
 * module refuses to fabricate elsewhere, and would be indistinguishable from
 * the legitimately empty database, whose genuine `0` IS recorded.
 *
 * NOTHING THROWS FOR ANY INPUT `fs.statSync` CAN ACTUALLY PRODUCE. Every
 * failure above resolves to "record nothing, warn once", never to an
 * exception: the sampler runs before the listener binds, so a degraded mount
 * must not turn an unmeasurable store into a failed start. And an absent
 * metric with no diagnostic anywhere would be a silent failure, so each
 * declined measurement leaves EXACTLY ONE warning naming the store, what
 * could not be measured, and why.
 *
 * That scope is deliberate, and it is held STRUCTURALLY rather than
 * defensively: `Stats.size` is always a `number` and Node always throws a
 * real `Error`, so nothing reachable arrives at the warning-rendering path
 * with a hostile shape. A hand-fabricated cause could still break it —
 * `Core.getErrorMessage` over an `Object.create(null)` or a throwing
 * `message` getter, `String()` over a throwing `toString` — and those inputs
 * are deliberately NOT guarded: a guard for a value the filesystem cannot
 * produce is a branch no test can reach honestly. So the claim is the scoped
 * one, not an absolute the code would have to buy with dead branches.
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
 * The WAL-mode sidecar suffixes appended to `location`, stat'd in this order
 * and NOT independently: the first non-`ENOENT` failure declines the whole
 * measurement and returns, so a `-wal` fault means `-shm` is never stat'd at
 * all. See this module's doc on where sidecar tolerance stops.
 */
const WAL_SIDECAR_SUFFIXES = ["-wal", "-shm"] as const;

/**
 * How a DEGENERATE SUM names what carries no measurement: appended to
 * `location`, it brace-expands to every path that went into the sum
 * (`…/console.sqlite{,-wal,-shm}`).
 *
 * The degenerate branch is reached only after `statSync` ANSWERED for every
 * file that exists, so it can honestly blame no single file — naming the main
 * database in particular would state something false about a file that was
 * measured fine and point an operator at the wrong thing. What carries no
 * measurement is the sum, so the sum is what is named. Derived from
 * {@link WAL_SIDECAR_SUFFIXES} so a future third sidecar cannot drift it.
 */
const SUMMED_PATHS_SUFFIX: string = `{,${WAL_SIDECAR_SUFFIXES.join(",")}}`;

/**
 * The ONLY `errno` codes a sidecar stat failure may be swallowed for: a file
 * that is not there. Deliberately a one-member set rather than a bare
 * comparison, so widening it later is a visible edit to a named policy — and
 * so the shape matches `docs/contributing/style-guide.md`'s filesystem rule
 * ("ignore only `ENOENT`, via a small denylist `Set`").
 */
const ABSENT_FILE_ERRNO_CODES: ReadonlySet<string> = new Set(["ENOENT"]);

/**
 * The smallest byte count that can carry a measurement. Anything below it is
 * DEGENERATE rather than imprecise — a negative footprint measures no file —
 * so {@link toValidSizeBytes} declines it instead of clamping it up.
 */
const MIN_VALID_SIZE_BYTES = 0;

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
 * Everything {@link sampleStoreSizeOnBoot} needs for one boot-time
 * measurement. Named rather than inline to match this package's sibling
 * convention (`HealthRouteOptions`, `RebuildHumanActionIndexOptions`, …), so
 * the parameter reads the same way at every call site and each field carries
 * its own rationale.
 *
 * @example
 * ```ts
 * const options: M3LStoreSizeSampleOptions = {
 *   store,
 *   telemetry: runtime.telemetry,
 *   logger: runtime.logger,
 * };
 * ```
 */
interface M3LStoreSizeSampleOptions {
  /**
   * The store to measure — read for its `location` and nothing else, which is
   * why it is typed {@link M3LStoreLocationProbe} rather than any `store/`
   * type.
   */
  readonly store: M3LStoreLocationProbe;
  /**
   * The recorder the single `store.health` sample is reported through. Never
   * throws by contract (`telemetry/port.ts`), so the emit itself needs no
   * guard.
   */
  readonly telemetry: M3LTelemetryRecorder;
  /**
   * Where a DECLINED measurement's one warning goes. Not optional: an absent
   * metric with no diagnostic is a silent failure, so the sampler always has
   * somewhere to report.
   */
  readonly logger: Core.M3LLogger;
}

/**
 * The `errno` code a Node filesystem failure carries as its OWN property, or
 * `undefined` for any value that is not one.
 *
 * OWNERSHIP IS PART OF THE CHECK, not a nicety. Tolerated absence is decided
 * from this code, so honouring an INHERITED `code` would make "the file is
 * not there" forgeable at a distance: one `Error.prototype.code = "ENOENT"`
 * anywhere in the process, or a `get code()` on the prototype of any thrown
 * subclass, and EVERY non-`ENOENT` sidecar failure would quietly become the
 * understated sum this module exists to withhold — recorded as a sample, with
 * no warning at all. Node's own errno errors always set `code` as an own
 * property, so requiring ownership costs no real path anything.
 *
 * Reads `.code` ONCE into a local and narrows the local, never the property
 * expression: a getter may answer differently on each read, so a
 * `typeof x.code === "string" ? x.code : …` chain is two reads of a value
 * that only one of them validated. `Object.hasOwn` tests for the property
 * without reading it, so the ownership guard adds no second read.
 *
 * A near-copy of `runs/report.ts`'s helper, because the `telemetry/` ESLint
 * zone may not import `runs/` — near, not identical: that copy does not yet
 * require ownership. Hoisting ONE hardened version into `errors/` is a
 * recorded follow-up rather than part of this slice.
 */
function errnoCodeOf(cause: unknown): string | undefined {
  if (!(cause instanceof Error) || !Object.hasOwn(cause, "code")) {
    return undefined;
  }
  const code: unknown = (cause as NodeJS.ErrnoException).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Normalises a raw summed byte count into a value the telemetry repository
 * can never reject — a non-negative safe integer in
 * `[0, Number.MAX_SAFE_INTEGER]` — or `undefined` when the reading carries no
 * measurement to normalise.
 *
 * The split is IMPRECISE versus DEGENERATE. A fractional or
 * over-`MAX_SAFE_INTEGER` reading still measures a real file, so it keeps its
 * sample (rounded, then clamped). A non-finite or negative reading measures
 * nothing: `undefined` is how that is signalled back, and the caller declines
 * the sample rather than flooring it to a `0` indistinguishable from a
 * genuinely empty database.
 *
 * `Math.round` runs BEFORE the ceiling clamp, not after: `Math.round(1e300)`
 * is `1e300`, so a ceiling applied first would be undone by the rounding and
 * leave a non-safe integer behind — the exact defect X8 slice 3a shipped in
 * `telemetry/duration.ts`'s `toValidDurationMs` and had to fix.
 *
 * @param rawSizeBytes - A summed `Stats.size` reading. May be fractional,
 * negative, non-finite or larger than `Number.MAX_SAFE_INTEGER` if the
 * filesystem (or an injected `statSync`) reports a degenerate size.
 * @returns A non-negative safe integer safe to hand to
 * {@link M3LTelemetryRecorder.storeHealth}, or `undefined` when the reading is
 * degenerate and no sample may be emitted.
 * @example
 * ```ts
 * toValidSizeBytes(1234.5); // 1235
 * toValidSizeBytes(Number.NaN); // undefined — record nothing
 * ```
 */
function toValidSizeBytes(rawSizeBytes: number): number | undefined {
  if (!Number.isFinite(rawSizeBytes) || rawSizeBytes < MIN_VALID_SIZE_BYTES) {
    return undefined;
  }
  // Round first, then clamp: Math.round(1e300) === 1e300, so the ceiling must
  // be applied after rounding, not before.
  return Math.min(Math.round(rawSizeBytes), SIZE_BYTES_CEILING);
}

/**
 * Everything one declined measurement's single warning needs. Named rather
 * than inline for the same reason {@link M3LStoreSizeSampleOptions} is — this
 * package's sibling convention (`HealthRouteOptions`,
 * `CreateRunReportReaderOptions`, …) is a named interface, so the parameter
 * reads the same way at every call site and each field carries its own
 * rationale. Not exported: the warning's shape is this module's private
 * diagnostic detail, not part of any contract.
 *
 * @example
 * ```ts
 * const report: ReportDeclinedMeasurementOptions = {
 *   logger,
 *   location: "/data/console.sqlite",
 *   unmeasuredPath: "/data/console.sqlite-wal",
 *   reason: "EACCES: permission denied",
 * };
 * ```
 */
interface ReportDeclinedMeasurementOptions {
  /**
   * Where the one warning goes. Never optional — a declined measurement with
   * no diagnostic anywhere would be the silent failure this module refuses.
   */
  readonly logger: Core.M3LLogger;
  /**
   * The store's `location`, carried in the message AND in `data` so a warning
   * is attributable to a store even when the unmeasured path is a sidecar.
   */
  readonly location: string;
  /**
   * What carries no measurement: the exact file `statSync` could not answer
   * for, or — for a degenerate SUM, where every existing file WAS answered
   * for — `location` plus {@link SUMMED_PATHS_SUFFIX}, naming the summed set.
   * Never a file `statSync` succeeded on.
   */
  readonly unmeasuredPath: string;
  /**
   * Why, already rendered to text: the cause's message, or the degenerate
   * reading itself. The rendered form rather than the error object goes into
   * `data`, mirroring `telemetry-recorder.ts`'s `reportDroppedFanOut`.
   */
  readonly reason: string;
}

/**
 * Emits the ONE warning a declined measurement leaves behind, naming the
 * store, what could not be measured, and why.
 *
 * Shared by all three declining paths (unreadable main file, unreadable
 * sidecar, degenerate sum) so each leaves an identically shaped diagnostic.
 *
 * @param options - The logger, the store's location, what carries no
 * measurement, and the rendered reason.
 * @example
 * ```ts
 * reportDeclinedMeasurement({
 *   logger,
 *   location: "/data/console.sqlite",
 *   unmeasuredPath: "/data/console.sqlite-wal",
 *   reason: "EACCES: permission denied",
 * });
 * ```
 */
function reportDeclinedMeasurement(
  options: ReportDeclinedMeasurementOptions,
): void {
  options.logger.warning(
    `console store size could not be measured at ${options.location}`,
    {
      location: options.location,
      unmeasuredPath: options.unmeasuredPath,
      message: options.reason,
    },
  );
}

/**
 * Measures the console store's on-disk footprint once and records it as a
 * single `store.health` sample. Never throws: it runs during boot, strictly
 * before the listener binds, so an unmeasurable store must never become a
 * failed start.
 *
 * Five outcomes, in the order they are decided:
 *
 * 1. `store.location` is `":memory:"` — nothing is recorded, nothing is
 *    stat'd and nothing is warned about. Recognised BEFORE any filesystem
 *    call, so an in-memory store costs no syscall at boot, and it is the
 *    designed outcome rather than a failure.
 * 2. The MAIN database file cannot be stat'd — nothing is recorded, and
 *    exactly one `logger.warning` names the location and the underlying
 *    failure (an errno error's own message carries its `ENOENT`/`ENOTDIR`
 *    code).
 * 3. A WAL sidecar is ABSENT (`ENOENT`, and only `ENOENT`) — tolerated
 *    silently, contributing nothing to the sum; a clean checkpoint removes it,
 *    so its absence is normal operation rather than a diagnostic event.
 * 4. A WAL sidecar failure that is NOT recognised absence — any other errno,
 *    and equally a throw carrying no own `code` at all, since nothing then
 *    attests that the file is missing — declines the whole measurement, with
 *    one warning naming that sidecar's full path. An understated sum is
 *    byte-identical to a checkpointed store, and a `-wal` routinely dwarfs
 *    the main file.
 * 5. Every file that exists was measured — one sample carrying the summed
 *    size, normalised by {@link toValidSizeBytes}. A DEGENERATE sum (a
 *    non-finite or negative reading) is declined here too, with one warning:
 *    it carries no measurement to record. That warning names the SUMMED
 *    paths, not any single file — every file that exists was answered for, so
 *    blaming one of them would be false (see {@link SUMMED_PATHS_SUFFIX}).
 *
 * The emit itself is deliberately NOT wrapped in `try`/`catch`:
 * {@link M3LTelemetryRecorder} never throws by contract (`telemetry/port.ts`),
 * the same stance `runs/orchestrator.ts`'s `recordFinish` documents. The
 * guard belongs around `statSync`, and only there.
 *
 * @param options - The store to measure, the recorder to report through, and
 * the logger a declined measurement's single warning goes to.
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
export function sampleStoreSizeOnBoot(
  options: M3LStoreSizeSampleOptions,
): void {
  const { location } = options.store;
  if (location === IN_MEMORY_LOCATION) {
    return;
  }

  let totalBytes: number;
  try {
    totalBytes = fs.statSync(location).size;
  } catch (cause) {
    reportDeclinedMeasurement({
      logger: options.logger,
      location,
      unmeasuredPath: location,
      reason: Core.getErrorMessage(cause),
    });
    return;
  }

  for (const suffix of WAL_SIDECAR_SUFFIXES) {
    const sidecarPath = `${location}${suffix}`;
    try {
      totalBytes += fs.statSync(sidecarPath).size;
    } catch (cause) {
      const errnoCode = errnoCodeOf(cause);
      if (errnoCode === undefined || !ABSENT_FILE_ERRNO_CODES.has(errnoCode)) {
        reportDeclinedMeasurement({
          logger: options.logger,
          location,
          unmeasuredPath: sidecarPath,
          reason: Core.getErrorMessage(cause),
        });
        return;
      }
      // Only absence falls through: this sidecar is simply not on disk, which
      // a clean checkpoint is expected to produce, so it contributes nothing
      // to the sum and raises no diagnostic.
    }
  }

  const sizeBytes = toValidSizeBytes(totalBytes);
  if (sizeBytes === undefined) {
    reportDeclinedMeasurement({
      logger: options.logger,
      location,
      // NOT `location`: `statSync` answered for the main file, and for every
      // sidecar that exists. What carries no measurement is the sum, so the
      // sum is what the warning names.
      unmeasuredPath: `${location}${SUMMED_PATHS_SUFFIX}`,
      reason: `stat reported a degenerate summed size of ${String(totalBytes)} bytes`,
    });
    return;
  }

  options.telemetry.storeHealth({ sizeBytes });
}
