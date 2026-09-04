/**
 * Unit tests for X8 slice 3d's boot-time store-size sampler,
 * `src/telemetry/store-size.ts` — the module that measures the console
 * store's on-disk footprint once at boot and reports it as the single
 * `store.health` sample the {@link "../src/telemetry/port.js".M3LTelemetryRecorder}
 * accepts (`storeHealth({ sizeBytes })`).
 *
 * RED: `src/telemetry/store-size.ts` does not exist yet, so every case below
 * fails on the unresolved import until the implementer creates it. That —
 * plus the `import-x/no-unresolved` / `no-unsafe-*` lint findings the absent
 * module produces, which self-resolve at GREEN and are deliberately NOT
 * suppressed — is the only acceptable RED reason here; nothing in this file
 * should fail for a typo or a wrong path.
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
 *    file's size.
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
 * 5. `sizeBytes` is always a non-negative safe integer. The rollup
 *    repository's `requireValidMeasure` rejects anything else
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
 * I/O PRIMITIVE COUPLING, stated up front. Two cases below (contract 2 and
 * 5) `vi.spyOn` `node:fs`'s **`statSync`**, which is the primitive the
 * synchronous shape above implies. That coupling is deliberate but real: if
 * the implementation ever moves to `fs/promises` `stat` or an
 * `open()`/`FileHandle` pair, the spy silently stops intercepting and those
 * two cases would fail (contract 5) or go vacuous (contract 2) — so a
 * primitive change is a two-spoke change (implementer + test author), not a
 * drop-in. Every other case drives REAL files and is primitive-agnostic.
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
function stubStatSyncSize(size: number) {
  return vi.spyOn(nodeFs, "statSync").mockImplementation((() => ({
    size,
  })) as unknown as typeof nodeFs.statSync);
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
      // why. Asserted against the SERIALIZED event so either placement
      // satisfies it — the message text or the `data` payload, which is where
      // `telemetry-recorder.ts`'s `reportDroppedFanOut` puts the cause's
      // message. Read from the capturing handler's array, never from stdout:
      // the handler swallows the line, so nothing is printed to grep.
      const warnings = warningsIn(events);
      expect(warnings).toHaveLength(1);
      const [warning] = warnings;
      if (warning === undefined) {
        throw new Error("expected exactly one warning event");
      }
      const serialized = JSON.stringify(warning);
      expect(serialized).toContain(location);
      expect(serialized).toContain(expectedCode);
    },
  );
});

describe("sampleStoreSizeOnBoot — contract 5: sizeBytes is always a non-negative safe integer", () => {
  /**
   * Four raw `stat` sizes the rollup repository would REJECT verbatim.
   * `requireValidMeasure` demands a non-negative safe integer, and
   * `createStoreTelemetryRecorder` swallows its rejection as a logged
   * warning — so an unclamped value is not an error, it is a silently
   * dropped row. `1e300` is the ceiling case `Number.isFinite` alone does
   * not catch, and is the exact gap slice 3a left in `toValidDurationMs`.
   *
   * The assertions pin the INVARIANT, not a specific clamp target: the
   * contract states the range, and `telemetry/duration.ts`'s
   * `DURATION_MS_CEILING` precedent (clamp to `MAX_SAFE_INTEGER`, preserving
   * "very large" rather than collapsing to `0`) is the implementer's call to
   * mirror, not this file's to dictate.
   *
   * THE `NaN` ROW IS NOT A FOURTH VARIATION ON THE OTHER THREE — it is the
   * only row here that reaches the finiteness GUARD at all, and it exists
   * to pin that guard. `1e300`, `1234.5` and `-4096` are each absorbed by
   * the round-then-clamp pair on their own, so all three pass identically
   * against an implementation with no guard whatsoever. `NaN` cannot be
   * absorbed that way: `Math.round(NaN)`, `Math.max(0, NaN)` and
   * `Math.min(NaN, Number.MAX_SAFE_INTEGER)` are all `NaN`. Delete this row
   * and `NaN` would flow into `telemetry.storeHealth`, `requireValidMeasure`
   * would reject it, and the store-backed recorder would swallow the entire
   * row behind a `logger.warning` — the silent drop this whole contract
   * exists to prevent, and the identical failure mode slice 3a shipped in
   * `toValidDurationMs`. So removing it does not merely nudge a coverage
   * percentage down; it leaves the one degenerate reading that can still
   * silently lose a measurement completely unguarded.
   */
  const DEGENERATE_SIZES = [
    ["a size beyond Number.MAX_SAFE_INTEGER", 1e300],
    ["a fractional byte count", 1234.5],
    ["a negative byte count", -4096],
    ["a NaN byte count", Number.NaN],
  ] as const;

  test.each(DEGENERATE_SIZES)(
    "still records one recordable sample when stat reports %s",
    (_label, rawSize) => {
      stubStatSyncSize(rawSize);
      const { recorder, storeHealthSamples } = createCapturingRecorder();
      // Whether a degenerate-but-readable reading ALSO warrants a warning is
      // deliberately left unpinned — the contract only fixes the recorded
      // value's range — so `events` is not asserted on here.
      const { logger } = createCapturingLogger();

      sampleStoreSizeOnBoot({
        store: { location: path.join(tmpdir(), "m3l-store-size-stub.sqlite") },
        telemetry: recorder,
        logger,
      });

      // A sample IS still emitted: the store was measurable, the reading was
      // merely degenerate, so normalising keeps the sample alive rather than
      // discarding it (contract 4 covers the unmeasurable case instead).
      expect(storeHealthSamples).toHaveLength(1);
      const [sample] = storeHealthSamples;
      if (sample === undefined) {
        throw new Error("expected exactly one store.health sample");
      }
      expect(Number.isSafeInteger(sample.sizeBytes)).toBe(true);
      expect(sample.sizeBytes).toBeGreaterThanOrEqual(0);
    },
  );

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
    // The real runtime hands `runtime.store`, an `M3LConsoleStoreLifecycle`.
    // Passing one here is a TYPE-level assertion that the locally-declared
    // `{ location }` shape stays a supertype of it — the same structural
    // contract `http/routes/health.ts`'s `M3LReadinessProbe` keeps with
    // `{ isOpen }`, and what lets `telemetry/` avoid a `store/` import.
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
