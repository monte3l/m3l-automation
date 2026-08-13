/**
 * Tests for src/cli/output.ts — color resolution precedence and the
 * `M3LCliOutput` writer facade (m3l-cli 8b contract).
 */
import { describe, expect, expectTypeOf, test } from "vitest";

import { createOutput, resolveColorEnabled } from "../src/cli/output.js";
import type {
  M3LCliOutput,
  M3LCliOutputOptions,
  M3LCliOutputStream,
} from "../src/cli/output.js";

/**
 * A minimal collecting stream stub, structurally compatible with
 * process.stdout / M3LCliOutputStream. The return type is left inferred
 * (not annotated as `M3LCliOutputStream & {...}`) so RED — where
 * M3LCliOutputStream does not resolve yet — doesn't trip
 * `no-redundant-type-constituents` on an intersection with an error type;
 * it stays structurally assignable to M3LCliOutputStream once GREEN lands.
 */
function createStream(isTTY?: boolean) {
  const written: string[] = [];
  return {
    written,
    isTTY,
    write(text: string): boolean {
      written.push(text);
      return true;
    },
  };
}

describe("resolveColorEnabled", () => {
  test("FORCE_COLOR set to a non-'0' value forces color on, even off a non-TTY", () => {
    expect(resolveColorEnabled(false, { FORCE_COLOR: "1" })).toBe(true);
  });

  test("FORCE_COLOR set to an empty string still counts as 'present and !== \"0\"'", () => {
    expect(resolveColorEnabled(false, { FORCE_COLOR: "" })).toBe(true);
  });

  test("FORCE_COLOR='0' does not force color on; falls through to isTTY", () => {
    expect(resolveColorEnabled(false, { FORCE_COLOR: "0" })).toBe(false);
    expect(resolveColorEnabled(true, { FORCE_COLOR: "0" })).toBe(true);
  });

  test("NO_COLOR present with any value forces color off even on a TTY", () => {
    expect(resolveColorEnabled(true, { NO_COLOR: "" })).toBe(false);
    expect(resolveColorEnabled(true, { NO_COLOR: "1" })).toBe(false);
  });

  test("NODE_DISABLE_COLORS present forces color off even on a TTY", () => {
    expect(resolveColorEnabled(true, { NODE_DISABLE_COLORS: "1" })).toBe(false);
  });

  test("FORCE_COLOR takes precedence over NO_COLOR", () => {
    expect(
      resolveColorEnabled(false, { FORCE_COLOR: "1", NO_COLOR: "1" }),
    ).toBe(true);
  });

  test("FORCE_COLOR takes precedence over NODE_DISABLE_COLORS", () => {
    expect(
      resolveColorEnabled(false, {
        FORCE_COLOR: "1",
        NODE_DISABLE_COLORS: "1",
      }),
    ).toBe(true);
  });

  test("falls back to isTTY when no override env var is present", () => {
    expect(resolveColorEnabled(true, {})).toBe(true);
    expect(resolveColorEnabled(false, {})).toBe(false);
  });
});

describe("createOutput", () => {
  test("info writes to stdout with a trailing newline, uncolored when stdout is not a TTY", () => {
    const stdout = createStream(false);
    const stderr = createStream(false);
    const output = createOutput({ stdout, stderr, env: {} });

    output.info("hello");

    expect(stdout.written).toEqual(["hello\n"]);
    expect(stderr.written).toEqual([]);
  });

  test("heading writes to stdout with a trailing newline, styled bold when stdout is a TTY", () => {
    const stdout = createStream(true);
    const stderr = createStream(false);
    const output = createOutput({ stdout, stderr, env: {} });

    output.heading("Section");

    expect(stdout.written).toHaveLength(1);
    const [line] = stdout.written;
    expect(line).toContain("Section");
    expect(line?.endsWith("\n")).toBe(true);
  });

  test("heading is not styled when stdout is not a TTY", () => {
    const stdout = createStream(false);
    const stderr = createStream(false);
    const output = createOutput({ stdout, stderr, env: {} });

    output.heading("Section");

    expect(stdout.written).toEqual(["Section\n"]);
  });

  test("error writes to stderr with a trailing newline, styled red when stderr is a TTY", () => {
    const stdout = createStream(false);
    const stderr = createStream(true);
    const output = createOutput({ stdout, stderr, env: {} });

    output.error("boom");

    expect(stdout.written).toEqual([]);
    expect(stderr.written).toHaveLength(1);
    const [line] = stderr.written;
    expect(line).toContain("boom");
    expect(line?.endsWith("\n")).toBe(true);
  });

  test("error is not styled when stderr is not a TTY, even when stdout is", () => {
    const stdout = createStream(true);
    const stderr = createStream(false);
    const output = createOutput({ stdout, stderr, env: {} });

    output.error("boom");

    expect(stderr.written).toEqual(["boom\n"]);
  });

  test("color decision is per-stream: stdout TTY colors heading, stderr TTY colors error independently", () => {
    const stdout = createStream(true);
    const stderr = createStream(false);
    const output = createOutput({ stdout, stderr, env: {} });

    output.heading("H");
    output.error("E");

    // heading (stdout TTY) is styled -> longer than the bare text + newline;
    // error (stderr not TTY) is exactly the bare text + newline.
    expect(stderr.written).toEqual(["E\n"]);
    expect(stdout.written[0]).not.toBe("H\n");
  });

  test("colorEnabled reflects stdout's own TTY/env resolution", () => {
    const ttyOutput = createOutput({
      stdout: createStream(true),
      stderr: createStream(false),
      env: {},
    });
    const nonTtyOutput = createOutput({
      stdout: createStream(false),
      stderr: createStream(false),
      env: {},
    });

    expect(ttyOutput.colorEnabled).toBe(true);
    expect(nonTtyOutput.colorEnabled).toBe(false);
  });

  test("NO_COLOR disables styling even when both streams are TTYs", () => {
    const stdout = createStream(true);
    const stderr = createStream(true);
    const output = createOutput({ stdout, stderr, env: { NO_COLOR: "1" } });

    output.heading("Section");
    output.error("boom");

    expect(stdout.written).toEqual(["Section\n"]);
    expect(stderr.written).toEqual(["boom\n"]);
    expect(output.colorEnabled).toBe(false);
  });

  test("does not throw when env is omitted (defaults applied internally)", () => {
    const stdout = createStream(false);
    const stderr = createStream(false);

    expect(() => createOutput({ stdout, stderr })).not.toThrow();
  });
});

describe("M3LCliOutput contract", () => {
  test("declares the documented readonly/method shape", () => {
    expectTypeOf<M3LCliOutput["colorEnabled"]>().toEqualTypeOf<boolean>();
    expectTypeOf<M3LCliOutput["info"]>().toEqualTypeOf<
      (text: string) => void
    >();
    expectTypeOf<M3LCliOutput["error"]>().toEqualTypeOf<
      (text: string) => void
    >();
    expectTypeOf<M3LCliOutput["heading"]>().toEqualTypeOf<
      (text: string) => void
    >();
  });

  test("M3LCliOutputOptions requires stdout/stderr and makes env optional", () => {
    expectTypeOf<M3LCliOutputOptions>().toMatchTypeOf<{
      stdout: M3LCliOutputStream;
      stderr: M3LCliOutputStream;
    }>();
    expectTypeOf<M3LCliOutputOptions["env"]>().toEqualTypeOf<
      Readonly<Record<string, string | undefined>> | undefined
    >();
  });
});
