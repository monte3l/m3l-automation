/**
 * Unit tests for X8 slice 3d's boot-time store-size sampler,
 * `src/telemetry/store-size.ts` — the module that measures the console
 * store's on-disk footprint once at boot and reports it as the single
 * `store.health` sample the {@link "../src/telemetry/port.js".M3LTelemetryRecorder}
 * accepts (`storeHealth({ sizeBytes })`).
 *
 * THE CONTRACT PINNED HERE (five points, one `describe` each):
 *
 * 1. A real file's sample is the SUM of `location`, `location + "-wal"` and
 *    `location + "-shm"`. SQLite runs in WAL mode (`store/store.ts`), which
 *    keeps those two sidecars alongside the main database, and the port
 *    documents `sizeBytes` as "the store's on-disk size in bytes" — so all
 *    three count, not just the main file.
 * 2. `":memory:"` records NOTHING. An in-memory store has no disk footprint
 *    at all, and `store.health` is a VALUE-BEARING metric
 *    (`console_telemetry_rollup` stores it with a non-NULL `sum_value`), so a
 *    `0` sample would be a fabricated measurement rather than an absent one.
 *    `store/store.ts:322` is the existing precedent for branching on that
 *    exact literal.
 * 3. A MISSING SIDECAR is normal, not an error, and tolerance is PER-FILE: a
 *    `-wal` that is absent (it appears only once the database is opened in
 *    WAL mode, and vanishes on a clean checkpoint) must not discard the main
 *    file's size. That tolerance is scoped to ABSENCE — `ENOENT` — and to
 *    nothing else. A sidecar that EXISTS but cannot be stat'd (`EIO`,
 *    `EACCES`, `ESTALE` on a degraded mount) is an unmeasurable COMPONENT of
 *    the footprint, and a `-wal` routinely dwarfs the main file, so omitting
 *    it would report the main file's size alone — byte-identical to what a
 *    cleanly checkpointed store reports. The metric whose purpose is spotting
 *    unbounded growth would then read "healthy" exactly when its largest
 *    component could not be measured. Declining is the only defensible
 *    outcome (there is no basis for assuming the unmeasurable file is
 *    `-shm`-sized rather than `-wal`-sized), so a non-`ENOENT` sidecar
 *    failure records NOTHING and warns exactly once, mirroring contract 4's
 *    main-file branch.
 * 4. A stat failure on the MAIN file records nothing, does not throw, and
 *    reports ONE warning naming the location and the underlying cause.
 *    This runs during boot, strictly before the listener binds, so a throw
 *    would turn an unmeasurable store into a failed start. And because the
 *    metric is value-bearing, an ABSENT measurement beats a wrong one — the
 *    sampler must NOT fall back to emitting `0`. But an absent metric with
 *    no diagnostic anywhere is a silent failure: the operator would see a
 *    missing measurement and have no way to learn why, which CLAUDE.md's
 *    "never swallow errors silently" rule forbids. Hence the warning — it is
 *    the only trace an unreadable database file leaves.
 * 5. A RECORDED `sizeBytes` is always a non-negative safe integer — but
 *    normalisation covers only a reading that is IMPRECISE, never one that is
 *    DEGENERATE. A fractional reading is rounded and an
 *    over-`MAX_SAFE_INTEGER` reading is clamped, because each still carries a
 *    real measurement of a real file. A non-finite or negative reading
 *    carries none: flooring it to `0` and emitting it would fabricate the
 *    reading contract 4 refuses to fabricate, and would be indistinguishable
 *    from the legitimately-empty database this same module records as a
 *    genuine `0`. So a degenerate reading records NOTHING and warns once.
 *    Where normalisation DOES apply it matters because the rollup
 *    repository's `requireValidMeasure` rejects anything out of range
 *    (`store/telemetry-validation.ts:256`), and
 *    `createStoreTelemetryRecorder` swallows that rejection as a logged
 *    warning (`telemetry-recorder.ts`) — so an out-of-range value does not
 *    surface as an error, it silently drops the row. This is precisely the
 *    defect slice 3a shipped in `toValidDurationMs`, which clamped its floor
 *    but not its ceiling (`telemetry/duration.ts:19-31` documents the fix).
 *
 * PINNED SHAPE. The sampler is `sampleStoreSizeOnBoot(options)`, SYNCHRONOUS
 * and `void`-returning, taking `{ store, telemetry, logger }`:
 *
 * - `store` is structural — `{ readonly location: string }` and nothing more.
 *   The `telemetry` ESLint zone may not import `store/`, so the module
 *   declares the shape it needs locally, exactly as
 *   `http/routes/health.ts:56-58` declares `M3LReadinessProbe` for
 *   `{ isOpen }`. `M3LConsoleStoreLifecycle` satisfies it structurally, which
 *   the last test in this file pins.
 * - `logger` is a `Core.M3LLogger` — the one contract-4 failure report goes
 *   through, mirroring `telemetry-recorder.ts`'s own `reportDroppedFanOut`
 *   (which likewise takes a logger and puts the failure's message in the
 *   event's `data`). `main.ts` has `runtime.logger` at the call site.
 * - Synchronous because it sits beside `runtime.runs?.orchestrator
 *   .reconcileOnBoot()` in `main.ts`'s `buildRuntimeAndBindListener`, which
 *   is synchronous for the same reason, and because every
 *   `M3LTelemetryRecorder` method is synchronous.
 *
 * I/O PRIMITIVE COUPLING, stated up front. Three groups of cases below
 * (contract 2, contract 3's non-`ENOENT` sidecar rows, and contract 5)
 * `vi.spyOn` `node:fs`'s **`statSync`**, which is the primitive the
 * synchronous shape above implies. They do so because no portable filesystem
 * fixture can produce an `EIO`/`ESTALE` on demand, or report a negative or
 * non-finite `Stats.size`, without root or a synthetic mount. That coupling
 * is deliberate but real: if the implementation ever moves to `fs/promises`
 * `stat` or an `open()`/`FileHandle` pair, the spy silently stops
 * intercepting and those cases would fail (contracts 3 and 5) or go vacuous
 * (contract 2) — so a primitive change is a two-spoke change (implementer +
 * test author), not a drop-in. Every other case drives REAL files and is
 * primitive-agnostic.
 *
 * The `vi.mock("node:fs", ...)` passthrough exists solely to make the
 * namespace spy-able (a raw builtin namespace is frozen); it re-exports the
 * actual module verbatim, so unspied calls keep real behaviour. This is
 * `tests/telemetry-policy-e2e.test.ts:79-82`'s established seam.
 *
 * Real files are created under an `mkdtemp` directory and removed in
 * `afterEach`. `mkdtemp`/`writeFile`/`rm` are NAMED imports, matching
 * `packages/m3l-common/tests/files.test.ts:103`'s established pattern for a
 * test that genuinely needs bytes on disk: the sizes asserted below are
 * exact, and only a real `stat` of real files can prove the summing rule.
 */
import * as nodeFs from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";
import type { MockInstance } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import type {
  M3LTelemetryRecorder,
  M3LTelemetryStoreHealthSample,
} from "../src/telemetry/port.js";
import type { M3LConsoleStoreLifecycle } from "../src/store/store.js";
import { sampleStoreSizeOnBoot } from "../src/telemetry/store-size.js";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof nodeFs>("node:fs");
  return { ...actual };
});

/** The byte counts written to the main database file and each WAL sidecar. */
const MAIN_BYTES = 100;
const WAL_BYTES = 20;
const SHM_BYTES = 3;

/**
 * A capturing {@link M3LTelemetryRecorder}: `storeHealth` records every
 * sample it is handed, and the other four methods throw loudly. The sampler
 * measures the store and nothing else, so a call to any of them is a defect,
 * not a detail — and a capturing (rather than inert) `storeHealth` is what
 * makes each "records nothing" assertion below falsifiable: the recorder
 * WOULD have captured a sample had one been emitted.
 */
function createCapturingRecorder(): {
  readonly recorder: M3LTelemetryRecorder;
  readonly storeHealthSamples: M3LTelemetryStoreHealthSample[];
} {
  const storeHealthSamples: M3LTelemetryStoreHealthSample[] = [];
  const unexpected = (method: string) => (): never => {
    throw new Error(`unexpected ${method} call on the store-size sampler`);
  };
  const recorder: M3LTelemetryRecorder = {
    httpRequest: unexpected("httpRequest"),
    runFinished: unexpected("runFinished"),
    sseStream: unexpected("sseStream"),
    policyDecision: unexpected("policyDecision"),
    storeHealth: (sample) => {
      storeHealthSamples.push(sample);
    },
  };
  return { recorder, storeHealthSamples };
}

/**
 * A real `Core.M3LLogger` over a capturing handler, plus the array it writes
 * into. `M3LLogger` is a class with `#private` fields, so a plain-object fake
 * can never satisfy it — `new Core.M3LLogger([handler])` over a handler that
 * pushes into an array is this package's sanctioned pattern
 * (`tests/subsystems.test.ts:158-167`). `reset` is a REQUIRED member of
 * `Core.M3LLoggerHandler`, not an optional one.
 *
 * Assertions read the captured events, never stdout: the handler routes every
 * message into `events`, so nothing reaches the console to grep for.
 */
function createCapturingLogger(): {
  readonly logger: Core.M3LLogger;
  readonly events: Core.M3LLogEvent[];
} {
  const events: Core.M3LLogEvent[] = [];
  const handler: Core.M3LLoggerHandler = {
    handle: (event) => {
      events.push(event);
    },
    reset: () => {
      events.length = 0;
    },
  };
  return { logger: new Core.M3LLogger([handler]), events };
}

/** Every `WARNING`-category event captured so far. */
function warningsIn(
  events: readonly Core.M3LLogEvent[],
): readonly Core.M3LLogEvent[] {
  return events.filter(
    (event) => event.category === Core.M3LLogEventCategory.WARNING,
  );
}

/**
 * Asserts that `events` carries EXACTLY one warning, and that its serialized
 * form mentions every fragment in `expectedFragments`.
 *
 * Asserted against the SERIALIZED event so either placement satisfies it —
 * the message text or the `data` payload, which is where
 * `telemetry-recorder.ts`'s `reportDroppedFanOut` puts a cause's message.
 * "Exactly one" matters as much as the content: a declined sample must leave
 * one diagnostic, not zero (a silent failure) and not one per stat'd file.
 */
function expectSingleWarningMentioning(
  events: readonly Core.M3LLogEvent[],
  expectedFragments: readonly string[],
): void {
  const warnings = warningsIn(events);
  expect(warnings).toHaveLength(1);
  const [warning] = warnings;
  if (warning === undefined) {
    throw new Error("expected exactly one warning event");
  }
  const serialized = JSON.stringify(warning);
  for (const fragment of expectedFragments) {
    expect(serialized).toContain(fragment);
  }
}

/** The single `mkdtemp` directory the current test's real files live in. */
let workDir: string | undefined;

/** Creates (once per test) the temp directory real fixture files are written into. */
async function createWorkDir(): Promise<string> {
  workDir = await mkdtemp(path.join(tmpdir(), "m3l-store-size-"));
  return workDir;
}

/** Writes `byteCount` bytes to `target`; the content is irrelevant, only the size is asserted. */
async function writeBytes(target: string, byteCount: number): Promise<void> {
  await writeFile(target, "x".repeat(byteCount));
}

/**
 * Replaces `node:fs`'s `statSync` with one that reports `size` for EVERY
 * path, so a degenerate or hostile size can be driven without writing an
 * absurd file. Returns the spy so a test can assert it was never consulted.
 *
 * Cast through `unknown`: `statSync` is overloaded (`throwIfNoEntry` changes
 * its return type), so a plain `mockReturnValue` cannot satisfy every
 * overload — `tests/telemetry-policy-e2e.test.ts:263-265` casts its
 * `lstatSync` stub the same way.
 */
function stubStatSyncSize(size: number): MockInstance<typeof nodeFs.statSync> {
  return vi.spyOn(nodeFs, "statSync").mockImplementation((() => ({
    size,
  })) as unknown as typeof nodeFs.statSync);
}

/**
 * What a stubbed `statSync` does for one path: report `size`, fail with
 * `errnoCode`, or throw `thrownValue` verbatim. An errno failure carries the
 * code in its `message` as well as in `.code`, exactly as Node's own errno
 * errors do (`EIO: i/o error, stat '<path>'`) — so a warning that reports only
 * `Core.getErrorMessage(cause)` (which is what the main-file branch does)
 * still surfaces the code.
 *
 * `thrownValue` exists for the shapes `errnoCode` cannot express, because
 * `createErrnoError` always produces a real `Error` with an OWN STRING
 * `code`: an `Error` whose own `code` is not a string, and a throw that is
 * not an `Error` at all. Both are what a non-Node library can raise, and
 * both are how the sampler's errno recognition is driven to reject.
 */
type M3LStatOutcome =
  | { readonly size: number }
  | { readonly errnoCode: string }
  | { readonly thrownValue: unknown };

/** An errno-shaped `Error`, indistinguishable from Node's for a reporter's purposes. */
function createErrnoError(
  errnoCode: string,
  target: string,
): Error & { code: string } {
  const error = new Error(
    `${errnoCode}: simulated failure, stat '${target}'`,
  ) as Error & { code: string };
  error.code = errnoCode;
  return error;
}

/**
 * Replaces `node:fs`'s `statSync` with one driven PER PATH, which is what
 * lets a sidecar fail while the main file (or the other sidecar) stays
 * readable — the discrimination a single all-paths stub cannot express.
 *
 * An UNMAPPED path throws `ENOENT`, i.e. it behaves as an absent file. That
 * default is deliberate: it makes "this sidecar is simply not there" the
 * baseline, so each mapped errno row differs from the tolerated case in
 * exactly one respect — the errno.
 *
 * Cast through `unknown` for the same reason as {@link stubStatSyncSize}:
 * `statSync` is overloaded on `throwIfNoEntry`.
 */
function stubStatSyncByPath(
  outcomes: ReadonlyMap<string, M3LStatOutcome>,
): MockInstance<typeof nodeFs.statSync> {
  return vi.spyOn(nodeFs, "statSync").mockImplementation(((
    target: unknown,
  ): unknown => {
    const key = String(target);
    const outcome = outcomes.get(key);
    if (outcome === undefined) {
      throw createErrnoError("ENOENT", key);
    }
    if ("errnoCode" in outcome) {
      throw createErrnoError(outcome.errnoCode, key);
    }
    if ("thrownValue" in outcome) {
      // Raised verbatim, and deliberately not normalised into an `Error`:
      // these rows exist to exercise the sampler over the UNKNOWN channel a
      // `statSync` caller actually catches, so coercing the value here would
      // delete the case under test. `unknown` is a legal `throw` operand
      // (`only-throw-error`'s `allowThrowingUnknown`), so no suppression is
      // needed for it.
      throw outcome.thrownValue;
    }
    return { size: outcome.size };
  }) as unknown as typeof nodeFs.statSync);
}

afterEach(async () => {
  vi.restoreAllMocks();
  if (workDir !== undefined) {
    await rm(workDir, { recursive: true, force: true });
    workDir = undefined;
  }
});

describe("sampleStoreSizeOnBoot — contract 1 & 3: the summed footprint, with per-file sidecar tolerance", () => {
  /**
   * Each row names which WAL sidecars exist on disk and the exact total the
   * single emitted sample must carry. Declared `as const` so the tuple types
   * stay literal rather than widening to `(string | boolean | number)[]`.
   *
   * Rows 1-3 are what makes tolerance PER-FILE rather than all-or-nothing: an
   * implementation that discarded the whole measurement (or the main file's
   * size) because one sidecar was absent fails them while row 4 still passes.
   */
  const SIDECAR_CASES = [
    [
      "neither sidecar exists (a clean checkpoint left only the main file)",
      false,
      false,
      MAIN_BYTES,
    ],
    ["only -wal exists", true, false, MAIN_BYTES + WAL_BYTES],
    ["only -shm exists", false, true, MAIN_BYTES + SHM_BYTES],
    [
      "both sidecars exist (an open WAL-mode database)",
      true,
      true,
      MAIN_BYTES + WAL_BYTES + SHM_BYTES,
    ],
  ] as const;

  test.each(SIDECAR_CASES)(
    "records exactly one sample summing every file that exists — %s",
    async (_label, hasWal, hasShm, expectedBytes) => {
      const directory = await createWorkDir();
      const location = path.join(directory, "console.sqlite");
      await writeBytes(location, MAIN_BYTES);
      if (hasWal) await writeBytes(`${location}-wal`, WAL_BYTES);
      if (hasShm) await writeBytes(`${location}-shm`, SHM_BYTES);
      const { recorder, storeHealthSamples } = createCapturingRecorder();
      const { logger, events } = createCapturingLogger();

      sampleStoreSizeOnBoot({
        store: { location },
        telemetry: recorder,
        logger,
      });

      // Exact array, not a length or a `toContainEqual`: the sum is the whole
      // contract, and a second sample would mean the boot measurement ran
      // more than once.
      expect(storeHealthSamples).toEqual([{ sizeBytes: expectedBytes }]);
      // The success path is silent: a measured store is not a diagnostic
      // event, so the ONLY warning this module ever emits is contract 4's.
      expect(warningsIn(events)).toEqual([]);
    },
  );

  test("an empty main file with no sidecars records a real zero — the store genuinely occupies no bytes yet", async () => {
    const directory = await createWorkDir();
    const location = path.join(directory, "console.sqlite");
    await writeBytes(location, 0);
    const { recorder, storeHealthSamples } = createCapturingRecorder();
    const { logger, events } = createCapturingLogger();

    sampleStoreSizeOnBoot({
      store: { location },
      telemetry: recorder,
      logger,
    });

    // Deliberately contrasted with contract 4 below: `0` is a legitimate
    // MEASUREMENT of an existing empty file, and must be recorded. It is only
    // a fabrication when the file could not be measured at all.
    expect(storeHealthSamples).toEqual([{ sizeBytes: 0 }]);
    expect(warningsIn(events)).toEqual([]);
  });
});

describe("sampleStoreSizeOnBoot — contract 3: sidecar tolerance stops at ENOENT", () => {
  /**
   * The stubbed main-file size, and the location every case in this block
   * measures. Nothing is written to disk here: `EIO`/`ESTALE`/`EACCES` cannot
   * be produced from a portable fixture, so `statSync` is driven per path
   * (see this file's I/O-primitive note) and the location need not exist.
   */
  const STUBBED_MAIN_BYTES = 4096;
  const STUB_LOCATION = path.join(tmpdir(), "m3l-store-size-sidecar.sqlite");

  /**
   * How one sidecar behaves: `"absent"` (unmapped, so the stub throws
   * `ENOENT`), `"readable"` (reports its byte count), or an errno code the
   * stub throws instead.
   */
  function outcomeFor(
    behaviour: string,
    readableBytes: number,
  ): M3LStatOutcome | undefined {
    if (behaviour === "absent") return undefined;
    if (behaviour === "readable") return { size: readableBytes };
    return { errnoCode: behaviour };
  }

  /**
   * Rows: `-wal`'s behaviour, `-shm`'s behaviour, then the suffix whose path
   * the single warning must name and the errno it must carry.
   *
   * ROWS 1 AND 2 DIFFER ONLY IN THE ERRNO (`EIO` versus `ESTALE`), and their
   * labels say so rather than claiming a `-shm` contrast: the sampler stats
   * `-wal` first and returns the moment it declines, so `-shm` is never
   * stat'd in either row. Both therefore leave it unmapped (absent), and a
   * label distinguishing "`-shm` absent" from "`-shm` readable" would
   * describe a stat that does not happen.
   *
   * ROW 3 is the one where a TOLERATED absence precedes the failure: `-wal`
   * comes back `ENOENT` and is swallowed, then `-shm` fails, so the decline
   * has to survive the tolerance branch rather than short-circuiting before
   * it.
   *
   * ROW 4 IS THE DISCRIMINATING ONE. It leaves `-wal` present AND readable
   * and fails only on `-shm`, so the sampler holds a perfectly good
   * main-file size and a perfectly good `-wal` size and must STILL decline.
   * That is what separates "tolerate ENOENT" from "tolerate every errno":
   * the omitted component's size is unknown, and there is no basis for
   * assuming an unmeasurable file is `-shm`-sized rather than `-wal`-sized.
   */
  const SIDECAR_FAILURE_CASES = [
    [
      "the -wal sidecar exists but is unreadable (EIO, a degraded mount)",
      "EIO",
      "absent",
      "-wal",
      "EIO",
    ],
    [
      "the -wal sidecar sits on a stale handle (ESTALE, the same short-circuit under a different errno)",
      "ESTALE",
      "absent",
      "-wal",
      "ESTALE",
    ],
    [
      "the -shm sidecar is permission-denied (EACCES) and -wal is absent",
      "absent",
      "EACCES",
      "-shm",
      "EACCES",
    ],
    [
      "-wal is present and readable while -shm is permission-denied (EACCES)",
      "readable",
      "EACCES",
      "-shm",
      "EACCES",
    ],
  ] as const;

  test.each(SIDECAR_FAILURE_CASES)(
    "records nothing and reports one warning when %s",
    (_label, walBehaviour, shmBehaviour, failingSuffix, expectedCode) => {
      const outcomes = new Map<string, M3LStatOutcome>([
        [STUB_LOCATION, { size: STUBBED_MAIN_BYTES }],
      ]);
      const wal = outcomeFor(walBehaviour, WAL_BYTES);
      if (wal !== undefined) outcomes.set(`${STUB_LOCATION}-wal`, wal);
      const shm = outcomeFor(shmBehaviour, SHM_BYTES);
      if (shm !== undefined) outcomes.set(`${STUB_LOCATION}-shm`, shm);
      stubStatSyncByPath(outcomes);
      const { recorder, storeHealthSamples } = createCapturingRecorder();
      const { logger, events } = createCapturingLogger();

      // Never throws, for contract 4's reason: this runs before the listener
      // binds, so a degraded mount must not become a failed boot.
      expect(() => {
        sampleStoreSizeOnBoot({
          store: { location: STUB_LOCATION },
          telemetry: recorder,
          logger,
        });
      }).not.toThrow();

      // Exact array, and the whole of contract 3: the sampler declines here,
      // because a main-file-only (or main-plus-readable-sidecar) figure is
      // indistinguishable from a cleanly checkpointed store, and an
      // understated sample is worse than none.
      expect(storeHealthSamples).toEqual([]);
      // The declined sample's only trace: which file could not be measured,
      // and why.
      expectSingleWarningMentioning(events, [
        `${STUB_LOCATION}${failingSuffix}`,
        expectedCode,
      ]);
    },
  );

  /**
   * An errno-shaped failure whose `code` is INHERITED rather than an own
   * property, which is what makes "absence" forgeable from a distance. Any
   * library in the process can assign `Error.prototype.code = "ENOENT"`; if
   * the sampler recognised absence from an inherited `code`, every
   * non-`ENOENT` sidecar failure in this block would quietly become the
   * understated reading contract 3 exists to prevent — a sample, and zero
   * warnings. Node's own errno errors always carry an OWN `code`, so
   * requiring ownership costs the real paths nothing.
   *
   * The accessor sits on a LOCAL subclass's prototype, so this fixture
   * mutates no global and needs no restoring: a leaked `Error.prototype.code`
   * would silently reshape every later test in the run.
   */
  class InheritedCodeError extends Error {
    /** On the PROTOTYPE, so `Object.hasOwn(error, "code")` is `false`. */
    get code(): string {
      return "ENOENT";
    }
  }

  test("records nothing and reports one warning when a sidecar failure carries ENOENT only as an INHERITED code — tolerated absence must be an own property", () => {
    const fixture = new InheritedCodeError("simulated failure");
    // Guards the fixture itself, with `Object.hasOwn` rather than
    // `not.toHaveProperty`: the latter falls back to the `in` operator, which
    // walks the prototype chain and would pass on an inherited `code`,
    // leaving this case unable to fail.
    expect(Object.hasOwn(fixture, "code")).toBe(false);
    expect(fixture.code).toBe("ENOENT");

    // Driven with a bespoke stub rather than `stubStatSyncByPath`, whose
    // `createErrnoError` deliberately sets an OWN `code` (as Node does).
    vi.spyOn(nodeFs, "statSync").mockImplementation(((
      target: unknown,
    ): unknown => {
      const key = String(target);
      if (key === STUB_LOCATION) return { size: STUBBED_MAIN_BYTES };
      if (key === `${STUB_LOCATION}-wal`) {
        throw new InheritedCodeError("simulated failure");
      }
      throw createErrnoError("ENOENT", key);
    }) as unknown as typeof nodeFs.statSync);
    const { recorder, storeHealthSamples } = createCapturingRecorder();
    const { logger, events } = createCapturingLogger();

    expect(() => {
      sampleStoreSizeOnBoot({
        store: { location: STUB_LOCATION },
        telemetry: recorder,
        logger,
      });
    }).not.toThrow();

    // An inherited `code` is no evidence that the file is absent, so this is
    // an UNRECOGNISED cause and must decline exactly as the `EIO` row does —
    // NOT be tolerated as absence, which would emit the main file's size
    // alone and warn about nothing.
    expect(storeHealthSamples).toEqual([]);
    expectSingleWarningMentioning(events, [`${STUB_LOCATION}-wal`]);
  });

  test("records nothing and reports one warning when a sidecar failure carries an OWN code that is NOT a string — a numeric code attests nothing about absence", () => {
    // The `code` a non-Node library sets need not be a string: an own
    // `code: 42` clears the ownership half of the sampler's errno check and
    // is then rejected on TYPE, so the cause carries no recognised errno and
    // the measurement is declined. What a relaxed guard would cost is
    // concrete: comparing a COERCED code (`String(42)`, or a bare
    // `code === "ENOENT"` against a `Number`-backed enum that renders that
    // way) would let a library's own numbering decide that an unmeasurable
    // `-wal` is merely absent — recording the main file's size alone, with
    // no warning at all, which is the understated reading contract 3 exists
    // to withhold. Only a STRING code drawn from the tolerated set may be
    // read as "the file is not there"; every other shape is a fault.
    const numericCodeFailure = new Error(
      "simulated failure carrying a numeric code",
    ) as Error & { code: number };
    numericCodeFailure.code = 42;
    // Guards the fixture, so the decline is attributable to the TYPE check
    // and not to a missing property: this is an `Error`, and `code` is its
    // OWN property, which is exactly what the inherited-`code` row above is
    // not.
    expect(numericCodeFailure).toBeInstanceOf(Error);
    expect(Object.hasOwn(numericCodeFailure, "code")).toBe(true);

    // Driven through the shared per-path stub, so this row differs from the
    // tolerated-absence control in exactly one respect: what `-wal` throws.
    stubStatSyncByPath(
      new Map<string, M3LStatOutcome>([
        [STUB_LOCATION, { size: STUBBED_MAIN_BYTES }],
        [`${STUB_LOCATION}-wal`, { thrownValue: numericCodeFailure }],
      ]),
    );
    const { recorder, storeHealthSamples } = createCapturingRecorder();
    const { logger, events } = createCapturingLogger();

    expect(() => {
      sampleStoreSizeOnBoot({
        store: { location: STUB_LOCATION },
        telemetry: recorder,
        logger,
      });
    }).not.toThrow();

    // Fail-closed: an unrecognised cause declines exactly as the `EIO` row
    // does. Both assertions flip under a relaxed guard — a sampler that read
    // `42` as tolerated absence would emit `[{ sizeBytes: 4096 }]` here and
    // warn about nothing.
    expect(storeHealthSamples).toEqual([]);
    expectSingleWarningMentioning(events, [
      `${STUB_LOCATION}-wal`,
      "simulated failure carrying a numeric code",
    ]);
  });

  test('records nothing and reports one warning when a sidecar throw is NOT an Error at all — a bare object carrying code: "ENOENT" is not an attestation of absence', () => {
    // The pointed case. This value SAYS `ENOENT`, and it is still a fault:
    // nothing that is not an `Error` attests that a file is missing. Node
    // reports a missing sidecar by throwing a real errno `Error`, so a bare
    // object (equally a string, a `Symbol`, a rejected primitive) reaching
    // the `catch` means something other than the filesystem's own
    // not-found path produced it — a monkey-patched `fs`, a proxy layer, a
    // `throw` from user code inside a wrapped `statSync`. Reading that as
    // absence would make the tolerance forgeable by any value that merely
    // LOOKS like an errno error, and the result would be silent: the main
    // file's size recorded as the whole footprint, no warning, and a
    // `-wal` of unknown size omitted from a metric whose purpose is
    // spotting growth. So the `Error` check is load-bearing on its own, not
    // a type-narrowing convenience ahead of the code check.
    const forgedAbsence: unknown = { code: "ENOENT" };
    // Guards the fixture: not an `Error`, yet carrying the tolerated code as
    // an own property — so the ownership and string-type checks would BOTH
    // pass on it, and only the `Error` check declines.
    expect(forgedAbsence).not.toBeInstanceOf(Error);
    expect(Object.hasOwn(forgedAbsence as object, "code")).toBe(true);

    stubStatSyncByPath(
      new Map<string, M3LStatOutcome>([
        [STUB_LOCATION, { size: STUBBED_MAIN_BYTES }],
        [`${STUB_LOCATION}-wal`, { thrownValue: forgedAbsence }],
      ]),
    );
    const { recorder, storeHealthSamples } = createCapturingRecorder();
    const { logger, events } = createCapturingLogger();

    // Still never throws: a hostile cause must not turn an unmeasurable
    // sidecar into a failed boot either.
    expect(() => {
      sampleStoreSizeOnBoot({
        store: { location: STUB_LOCATION },
        telemetry: recorder,
        logger,
      });
    }).not.toThrow();

    expect(storeHealthSamples).toEqual([]);
    // `Core.getErrorMessage` falls through to `String(value)` for anything
    // that is not an `Error` or a string, so the rendered reason is the bare
    // object's default stringification: the forged `code` is neither
    // honoured nor even echoed into the diagnostic.
    expectSingleWarningMentioning(events, [
      `${STUB_LOCATION}-wal`,
      "[object Object]",
    ]);
  });

  test("both sidecars absent (ENOENT) still records the main file's size — the tolerated case, driven through the same stub", () => {
    // The control for the four rows above. Every row in this block passes
    // against the shipped sampler, so the contrast is not "this one passes
    // while those fail" — it lives in the per-path stub they SHARE. This row
    // maps nothing but the main file, so both sidecars come back `ENOENT`,
    // and it is what stops the declining rows from being satisfied by
    // "decline on ANY sidecar failure": a sampler that did that would still
    // pass all four rows above and break this one.
    stubStatSyncByPath(
      new Map([[STUB_LOCATION, { size: STUBBED_MAIN_BYTES }]]),
    );
    const { recorder, storeHealthSamples } = createCapturingRecorder();
    const { logger, events } = createCapturingLogger();

    sampleStoreSizeOnBoot({
      store: { location: STUB_LOCATION },
      telemetry: recorder,
      logger,
    });

    expect(storeHealthSamples).toEqual([{ sizeBytes: STUBBED_MAIN_BYTES }]);
    expect(warningsIn(events)).toEqual([]);
  });
});

describe('sampleStoreSizeOnBoot — contract 2: ":memory:" records nothing', () => {
  test("an in-memory store emits no sample at all and never stats anything — not even a 0-byte sample", () => {
    // `statSync` is stubbed to report a PLAUSIBLE 4 KiB for every path, which
    // is what keeps this case from passing vacuously. Without the stub, a
    // sampler missing the `":memory:"` branch would stat the literal
    // `":memory:"` relative to the cwd, get ENOENT, and record nothing via
    // contract 4's path — passing this test while the branch was gone.
    // With it, deleting the branch yields a 12 KiB sample and this fails.
    const statSync = stubStatSyncSize(4096);
    const { recorder, storeHealthSamples } = createCapturingRecorder();
    const { logger, events } = createCapturingLogger();

    sampleStoreSizeOnBoot({
      store: { location: ":memory:" },
      telemetry: recorder,
      logger,
    });

    expect(storeHealthSamples).toEqual([]);
    // The stronger half: the literal is recognised BEFORE any filesystem
    // call, so an in-memory store costs no syscall at boot.
    expect(statSync).not.toHaveBeenCalled();
    // Nothing to report: an in-memory store recording no size is the
    // DESIGNED outcome, not a failure, so it must not warn either.
    expect(warningsIn(events)).toEqual([]);
  });
});

describe("sampleStoreSizeOnBoot — contract 4: an unmeasurable main file records nothing and never throws", () => {
  /**
   * Two genuinely different `stat` failures on the MAIN file, driven with
   * real paths rather than a mock so neither depends on which primitive the
   * implementation reaches for:
   *
   * - `ENOENT` — the database file simply is not there.
   * - `ENOTDIR` — a REGULAR FILE stands where the parent directory should be.
   *
   * The second row is the one that discriminates a real `try`/`catch` from an
   * `existsSync`-style pre-check: an implementation that only tolerated a
   * missing path would throw here.
   */
  const FAILURE_CASES = [
    ["the main database file does not exist (ENOENT)", "missing", "ENOENT"],
    [
      "the main file's parent is itself a regular file (ENOTDIR)",
      "blocked",
      "ENOTDIR",
    ],
  ] as const;

  test.each(FAILURE_CASES)(
    "records nothing, does not throw, and reports one warning when %s",
    async (_label, kind, expectedCode) => {
      const directory = await createWorkDir();
      let location: string;
      if (kind === "missing") {
        location = path.join(directory, "absent", "console.sqlite");
      } else {
        const blocker = path.join(directory, "blocker");
        await writeBytes(blocker, MAIN_BYTES);
        location = path.join(blocker, "console.sqlite");
      }
      const { recorder, storeHealthSamples } = createCapturingRecorder();
      const { logger, events } = createCapturingLogger();

      // Never throws: this runs before the listener binds, so a throw here
      // would turn an unmeasurable store into a failed boot.
      expect(() => {
        sampleStoreSizeOnBoot({
          store: { location },
          telemetry: recorder,
          logger,
        });
      }).not.toThrow();

      // Exact array: an absent measurement, NOT a `0` one. `store.health`
      // carries a non-NULL `sum_value`, so a `0` here would persist a
      // fabricated "the store is empty" reading forever.
      expect(storeHealthSamples).toEqual([]);

      // ...but NOT silently absent. Exactly one warning, and it must carry
      // enough to diagnose the gap: which store could not be measured, and
      // why. Read from the capturing handler's array, never from stdout: the
      // handler swallows the line, so nothing is printed to grep.
      expectSingleWarningMentioning(events, [location, expectedCode]);
    },
  );
});

describe("sampleStoreSizeOnBoot — contract 5: an imprecise reading is normalised, a degenerate one is declined", () => {
  /**
   * The location every case in this block "measures". Only the MAIN path is
   * mapped in each stub below, so both sidecars come back `ENOENT` and the
   * summed total is exactly the raw reading under test — which is what makes
   * the exact expectations below meaningful rather than triple-counted.
   */
  const STUB_LOCATION = path.join(tmpdir(), "m3l-store-size-stub.sqlite");

  /** Stubs the main file at `rawSize` with both sidecars absent. */
  function stubMainFileSize(rawSize: number): void {
    stubStatSyncByPath(new Map([[STUB_LOCATION, { size: rawSize }]]));
  }

  /**
   * Readings that are IMPRECISE but real, with the exact value each must be
   * recorded as. Both are measurements of a file that genuinely exists, so
   * both keep their sample.
   *
   * `1e300` is the ceiling case `Number.isFinite` alone does not catch, and
   * is the exact gap slice 3a left in `toValidDurationMs`: the rollup
   * repository's `requireValidMeasure` demands a non-negative safe integer,
   * and `createStoreTelemetryRecorder` swallows its rejection as a logged
   * warning — so an unclamped value is not an error, it is a silently
   * dropped row. Clamping to `MAX_SAFE_INTEGER` rather than to `0` is
   * `telemetry/duration.ts`'s `DURATION_MS_CEILING` precedent: it preserves
   * "very large" instead of making a huge store look empty.
   *
   * `1234.5` pins round-half-up, which is what `Math.round` gives; the
   * direction is characterised rather than derived from the contract, which
   * says only "rounded".
   */
  const NORMALISED_SIZES = [
    [
      "a size beyond Number.MAX_SAFE_INTEGER, clamped to the ceiling",
      1e300,
      Number.MAX_SAFE_INTEGER,
    ],
    ["a fractional byte count, rounded", 1234.5, 1235],
  ] as const;

  test.each(NORMALISED_SIZES)(
    "records one normalised sample when stat reports %s",
    (_label, rawSize, expectedBytes) => {
      stubMainFileSize(rawSize);
      const { recorder, storeHealthSamples } = createCapturingRecorder();
      const { logger, events } = createCapturingLogger();

      sampleStoreSizeOnBoot({
        store: { location: STUB_LOCATION },
        telemetry: recorder,
        logger,
      });

      // The store WAS measured; the reading was merely imprecise, so
      // normalising keeps the sample alive rather than discarding it.
      expect(storeHealthSamples).toEqual([{ sizeBytes: expectedBytes }]);
      expect(Number.isSafeInteger(expectedBytes)).toBe(true);
      // An imprecise reading is not a diagnostic event: nothing was lost.
      expect(warningsIn(events)).toEqual([]);
    },
  );

  /**
   * DEGENERATE readings — a reading that carries no measurement at all.
   *
   * Flooring these to `0` and emitting them would fabricate exactly the
   * reading contract 4 refuses to fabricate for an unreadable main file, and
   * that fabricated `0` would be indistinguishable from the
   * legitimately-empty database the "empty main file" case above records as a
   * genuine measurement. So the outcome is contract 4's — no sample, one
   * warning: `toValidSizeBytes` answers `undefined` for every row here and
   * the caller declines rather than normalising.
   *
   * `NaN` and `±Infinity` are the rows that reach the FINITENESS guard.
   * Without it `Math.round(NaN)` and `Math.min(NaN, MAX_SAFE_INTEGER)` are
   * both `NaN`, so `NaN` would flow into `telemetry.storeHealth`,
   * `requireValidMeasure` would reject it, and the store-backed recorder
   * would swallow the whole row behind its own `logger.warning` — a silent
   * drop. `-4096` reaches the companion `MIN_VALID_SIZE_BYTES` comparison
   * instead, which is a REJECT threshold and not a clamp target: a negative
   * byte count is not an imprecise measurement of anything, so it is
   * declined rather than raised to `0`.
   */
  const DEGENERATE_SIZES = [
    ["a NaN byte count", Number.NaN],
    ["an Infinity byte count", Number.POSITIVE_INFINITY],
    ["a -Infinity byte count", Number.NEGATIVE_INFINITY],
    ["a negative byte count", -4096],
  ] as const;

  test.each(DEGENERATE_SIZES)(
    "records nothing and reports one warning when stat reports %s",
    (_label, rawSize) => {
      stubMainFileSize(rawSize);
      const { recorder, storeHealthSamples } = createCapturingRecorder();
      const { logger, events } = createCapturingLogger();

      expect(() => {
        sampleStoreSizeOnBoot({
          store: { location: STUB_LOCATION },
          telemetry: recorder,
          logger,
        });
      }).not.toThrow();

      // Exact array: NOT a floored `0`. `toValidSizeBytes` answers
      // `undefined` for each of these readings and the caller declines, so a
      // reading that carries no measurement leaves no measurement behind.
      expect(storeHealthSamples).toEqual([]);
      // How the raw reading itself is rendered is deliberately unpinned; the
      // store it belongs to is not, since that is the operator's only handle
      // on which measurement went missing.
      expectSingleWarningMentioning(events, [STUB_LOCATION]);
    },
  );

  test("records nothing and reports one warning when a SIDECAR contributes the degenerate value — and does not blame the main file, which stat'd fine", () => {
    // Every degenerate row above stubs the MAIN path only, so the bad value
    // always originates in the very file the warning names, and the two are
    // indistinguishable. Here the main database stats cleanly at a plausible
    // 4 KiB and the `-wal` reading is what poisons the sum, which is the case
    // that separates "this file could not be measured" from "this SUM carries
    // no measurement".
    stubStatSyncByPath(
      new Map<string, M3LStatOutcome>([
        [STUB_LOCATION, { size: 4096 }],
        [`${STUB_LOCATION}-wal`, { size: Number.POSITIVE_INFINITY }],
      ]),
    );
    const { recorder, storeHealthSamples } = createCapturingRecorder();
    const { logger, events } = createCapturingLogger();

    expect(() => {
      sampleStoreSizeOnBoot({
        store: { location: STUB_LOCATION },
        telemetry: recorder,
        logger,
      });
    }).not.toThrow();

    // A non-finite sum carries no measurement wherever the poison came from,
    // so the outcome is the same as every other degenerate row: nothing
    // recorded, one warning naming the store.
    expect(storeHealthSamples).toEqual([]);
    expectSingleWarningMentioning(events, [STUB_LOCATION]);

    // ...but the warning must not attribute the gap to the MAIN database
    // file. `statSync` answered for it with a perfectly good size, so
    // reporting it as the unmeasured path states something false about the
    // one file that WAS measured, and points an operator at the wrong thing.
    // Deliberately a negative assertion: what a summed degenerate reading
    // should name instead (the sum itself, or the sidecar whose reading was
    // degenerate) is the implementation's choice — blaming a file that
    // stat'd successfully is not.
    const [warning] = warningsIn(events);
    if (warning === undefined) {
      throw new Error("expected exactly one warning event");
    }
    expect(warning.data?.["unmeasuredPath"]).not.toBe(STUB_LOCATION);
  });

  test("a real file's sample is an integer, not a float — every measured byte count is directly recordable", async () => {
    const directory = await createWorkDir();
    const location = path.join(directory, "console.sqlite");
    await writeBytes(location, MAIN_BYTES);
    await writeBytes(`${location}-wal`, WAL_BYTES);
    const { recorder, storeHealthSamples } = createCapturingRecorder();
    const { logger, events } = createCapturingLogger();

    sampleStoreSizeOnBoot({
      store: { location },
      telemetry: recorder,
      logger,
    });

    const [sample] = storeHealthSamples;
    if (sample === undefined) {
      throw new Error("expected exactly one store.health sample");
    }
    expect(Number.isSafeInteger(sample.sizeBytes)).toBe(true);
    expect(sample.sizeBytes).toBe(MAIN_BYTES + WAL_BYTES);
    expect(warningsIn(events)).toEqual([]);
  });
});

describe("sampleStoreSizeOnBoot — the store argument is structural, never an imported store type", () => {
  test("a full M3LConsoleStoreLifecycle is accepted, and only its location is read", async () => {
    const directory = await createWorkDir();
    const location = path.join(directory, "console.sqlite");
    await writeBytes(location, MAIN_BYTES);
    const { recorder, storeHealthSamples } = createCapturingRecorder();
    const { logger, events } = createCapturingLogger();
    // The real call site (`main.ts`'s `buildRuntimeAndBindListener`) hands
    // the concrete `store` parameter that function already owns — an
    // `M3LConsoleStoreHandle & M3LConsoleStore` — deliberately NOT the
    // optional `runtime.store`, whose `undefined` branch would be
    // unreachable there. Both halves of that intersection extend
    // `M3LConsoleStoreLifecycle` (`store/store.ts:144`, `:209`), so the
    // fixture below is the narrowest type the real argument still satisfies:
    // passing one here is a TYPE-level assertion that the local `{ location }`
    // stays a supertype of it — the same structural contract
    // `http/routes/health.ts`'s `M3LReadinessProbe` keeps with `{ isOpen }`,
    // and what lets `telemetry/` avoid a `store/` import.
    const lifecycle: M3LConsoleStoreLifecycle = {
      isOpen: true,
      location,
      schemaVersion: 11,
      close: () => {
        throw new Error("the sampler must never close the store");
      },
    };

    sampleStoreSizeOnBoot({
      store: lifecycle,
      telemetry: recorder,
      logger,
    });

    expect(storeHealthSamples).toEqual([{ sizeBytes: MAIN_BYTES }]);
    expect(warningsIn(events)).toEqual([]);
  });
});
