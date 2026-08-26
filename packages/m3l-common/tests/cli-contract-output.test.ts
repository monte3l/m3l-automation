/**
 * `core/cli-contract/output` — the writer-port factory slice (U7 PR1).
 *
 * ADR-0072 slice split: this file owns `createCommandOutput`,
 * `M3LCommandOutputOptions` and `M3LCommandOutputStream`. The
 * `M3LCommandOutput` *interface* itself is asserted in `cli-contract.test.ts`
 * alongside the rest of the type surface; this file exists because the factory
 * is the first thing in `output.ts` with a runtime body, and `perFile` v8
 * coverage binds a test file to every `src/` file it imports from.
 *
 * Why the factory exists: three pilot scripts each carried a byte-identical
 * private `consoleOutput` const, and `packages/m3l-cli` carries a private
 * `M3LCliOutputStream` with exactly the shape promoted here. PR2 aliases the
 * CLI's type to `M3LCommandOutputStream`, so the structural parity check below
 * is load-bearing rather than decorative — a drifted member would break PR2
 * silently.
 *
 * Key behavioral contracts asserted here:
 *  - Injected stub streams receive the writes; `error()` always lands on the
 *    stderr stream and never on stdout, regardless of `colorEnabled`.
 *  - Omitted streams default to the REAL `process.stdout`/`process.stderr`
 *    (asserted via `vi.spyOn`), with a trailing newline — byte-for-byte the
 *    pilots' deleted `consoleOutput`.
 *  - The default is resolved lazily, per call, not captured at import time.
 *  - `colorEnabled` is `false` unless explicitly requested; this module
 *    renders nothing either way (ADR-0054 keeps rendering private to the CLI).
 */

import {
  afterEach,
  beforeAll,
  describe,
  expect,
  expectTypeOf,
  test,
  vi,
} from "vitest";

import { createCommandOutput } from "../src/core/cli-contract/index.js";
import type {
  M3LCommandOutput,
  M3LCommandOutputOptions,
  M3LCommandOutputStream,
} from "../src/core/cli-contract/index.js";

// ---------------------------------------------------------------------------
// Local test doubles
// ---------------------------------------------------------------------------

/** An array-collecting `M3LCommandOutputStream`. */
interface RecordingStream {
  readonly stream: M3LCommandOutputStream;
  readonly writes: string[];
}

function createRecordingStream(isTTY?: boolean): RecordingStream {
  const writes: string[] = [];
  const stream: M3LCommandOutputStream = {
    write(text: string): boolean {
      writes.push(text);
      return true;
    },
    ...(isTTY === undefined ? {} : { isTTY }),
  };
  return { stream, writes };
}

// `isTTY` is absent (not merely `false`) on a non-TTY CI stream, so any spy
// setup touching it must find a configurable own-property first.
beforeAll(() => {
  for (const stream of [process.stdout, process.stderr]) {
    if (!Object.prototype.hasOwnProperty.call(stream, "isTTY")) {
      Object.defineProperty(stream, "isTTY", {
        value: false,
        configurable: true,
        writable: true,
      });
    }
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Injected streams
// ---------------------------------------------------------------------------

describe("createCommandOutput — injected streams", () => {
  test("info and heading write to the supplied stdout stream, newline-terminated", () => {
    const stdout = createRecordingStream();
    const stderr = createRecordingStream();

    const output = createCommandOutput({
      stdout: stdout.stream,
      stderr: stderr.stream,
    });
    output.info("an info line");
    output.heading("A heading");

    expect(stdout.writes).toEqual(["an info line\n", "A heading\n"]);
    expect(stderr.writes).toEqual([]);
  });

  test("error writes to the supplied stderr stream and never to stdout", () => {
    const stdout = createRecordingStream();
    const stderr = createRecordingStream();

    const output = createCommandOutput({
      stdout: stdout.stream,
      stderr: stderr.stream,
    });
    output.error("an error line");

    expect(stderr.writes).toEqual(["an error line\n"]);
    expect(stdout.writes).toEqual([]);
  });

  // The channel split is the part a host relies on: a caller piping stdout
  // must not swallow diagnostics. Asserted separately for the colour-enabled
  // arm because `colorEnabled` is the only knob that could plausibly reroute.
  test("error still lands on stderr when colour is enabled", () => {
    const stdout = createRecordingStream();
    const stderr = createRecordingStream();

    const output = createCommandOutput({
      stdout: stdout.stream,
      stderr: stderr.stream,
      colorEnabled: true,
    });
    output.error("an error line");

    expect(stderr.writes).toEqual(["an error line\n"]);
    expect(stdout.writes).toEqual([]);
  });

  test("a supplied stdout with no stderr still defaults stderr to process.stderr", () => {
    const stdout = createRecordingStream();
    const realStderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    const output = createCommandOutput({ stdout: stdout.stream });
    output.info("captured");
    output.error("not captured");

    expect(stdout.writes).toEqual(["captured\n"]);
    expect(realStderr.mock.calls.map(([chunk]) => chunk)).toEqual([
      "not captured\n",
    ]);
  });

  // No styling and no sanitisation ship here (ADR-0054): the text a caller
  // hands in reaches the stream verbatim apart from the trailing newline.
  test("renders nothing — the text reaches the stream verbatim", () => {
    const stdout = createRecordingStream();
    const output = createCommandOutput({
      stdout: stdout.stream,
      colorEnabled: true,
    });

    // The escape is built from an explicit \u001b rather than pasted
    // literally: this repo's `check:control-chars` gate rejects a raw ESC
    // byte in source.
    const styled = "Export \u001b[31mred\u001b[39m";
    output.heading(styled);

    expect(stdout.writes).toEqual([`${styled}\n`]);
  });
});

// ---------------------------------------------------------------------------
// Default streams — the pilots' deleted `consoleOutput`, verbatim
// ---------------------------------------------------------------------------

describe("createCommandOutput — default streams", () => {
  test("with no arguments, info and heading go to process.stdout and error to process.stderr", () => {
    const out = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const err = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    const output = createCommandOutput();
    output.info("an info line");
    output.heading("A heading");
    output.error("an error line");

    expect(out.mock.calls.map(([chunk]) => chunk)).toEqual([
      "an info line\n",
      "A heading\n",
    ]);
    expect(err.mock.calls.map(([chunk]) => chunk)).toEqual(["an error line\n"]);
  });

  test("with an empty options object, the same defaults apply", () => {
    const out = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    const output = createCommandOutput({});
    output.info("an info line");

    expect(out.mock.calls.map(([chunk]) => chunk)).toEqual(["an info line\n"]);
  });

  // The factory must stay import-inert: reaching for `process.stdout` eagerly
  // (an `options?.stdout ?? process.stdout` evaluated when the module loads,
  // or when the port is built) would capture whatever stream object existed at
  // that moment. Resolving per call is what a host that swaps the stream
  // between builds relies on — and this test can only pass under the lazy
  // form, because the spy is installed AFTER the port was built.
  test("resolves the default stream per write, not at construction time", () => {
    const output = createCommandOutput();

    const out = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    output.info("written after the spy was installed");

    expect(out.mock.calls.map(([chunk]) => chunk)).toEqual([
      "written after the spy was installed\n",
    ]);
  });
});

// ---------------------------------------------------------------------------
// colorEnabled
// ---------------------------------------------------------------------------

describe("createCommandOutput — colorEnabled", () => {
  test("defaults to false with no options at all", () => {
    expect(createCommandOutput().colorEnabled).toBe(false);
  });

  test("defaults to false when the option is omitted from a supplied bag", () => {
    const stdout = createRecordingStream(true);
    expect(createCommandOutput({ stdout: stdout.stream }).colorEnabled).toBe(
      false,
    );
  });

  test("is false when explicitly requested false", () => {
    expect(createCommandOutput({ colorEnabled: false }).colorEnabled).toBe(
      false,
    );
  });

  test("is true only when explicitly requested true", () => {
    expect(createCommandOutput({ colorEnabled: true }).colorEnabled).toBe(true);
  });

  // A TTY-flagged stream must NOT flip the flag on its own: this module
  // resolves nothing about the terminal — per-stream TTY plus
  // `NO_COLOR`/`FORCE_COLOR` precedence stays private to `packages/m3l-cli`.
  test("a stream reporting isTTY: true does not enable colour by itself", () => {
    const stdout = createRecordingStream(true);
    const stderr = createRecordingStream(true);

    const output = createCommandOutput({
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(output.colorEnabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Type-level contract
// ---------------------------------------------------------------------------

describe("M3LCommandOutputStream / M3LCommandOutputOptions — type-level contract", () => {
  /**
   * The hand-written shape `packages/m3l-cli/src/cli/output.ts` currently
   * declares privately as `M3LCliOutputStream`. PR2 replaces that declaration
   * with an alias to `M3LCommandOutputStream`, so any drift here — a widened
   * `write` return, a dropped `| undefined` on `isTTY` — breaks that alias.
   * Written out by hand rather than imported across the package boundary:
   * importing `m3l-cli` from a `m3l-common` test would invert the dependency
   * direction the whole seam exists to keep one-way.
   */
  interface ExpectedStreamShape {
    write(text: string): unknown;
    readonly isTTY?: boolean | undefined;
  }

  test("M3LCommandOutputStream is structurally identical to the CLI's private stream shape", () => {
    expectTypeOf<M3LCommandOutputStream>().toEqualTypeOf<ExpectedStreamShape>();
  });

  test("a real process stream satisfies M3LCommandOutputStream", () => {
    const stream: M3LCommandOutputStream = process.stdout;
    expect(typeof stream.write).toBe("function");
  });

  test("an array-collecting stub with no isTTY satisfies M3LCommandOutputStream", () => {
    const stream: M3LCommandOutputStream = {
      write(): void {
        // A `void`-returning `write` is admissible: the return is `unknown`.
      },
    };
    expect(typeof stream.write).toBe("function");
  });

  test("the options bag's three members are all optional", () => {
    const empty: M3LCommandOutputOptions = {};
    expectTypeOf<M3LCommandOutputOptions["stdout"]>().toEqualTypeOf<
      M3LCommandOutputStream | undefined
    >();
    expectTypeOf<M3LCommandOutputOptions["stderr"]>().toEqualTypeOf<
      M3LCommandOutputStream | undefined
    >();
    expectTypeOf<M3LCommandOutputOptions["colorEnabled"]>().toEqualTypeOf<
      boolean | undefined
    >();
    expect(empty).toEqual({});
  });

  test("the factory's parameter is optional and it returns M3LCommandOutput", () => {
    expectTypeOf(createCommandOutput).returns.toEqualTypeOf<M3LCommandOutput>();
    expectTypeOf(createCommandOutput)
      .parameter(0)
      .toEqualTypeOf<M3LCommandOutputOptions | undefined>();
  });
});
