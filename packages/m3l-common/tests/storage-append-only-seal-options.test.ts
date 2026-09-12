/**
 * Tests for `M3LAppendOnlyStream`'s not-yet-implemented `onSealFailed`
 * constructor option (X8, writer-seal wiring).
 *
 * `onSealFailed` is the caller's channel for a best-effort manifest seal
 * that could not be written — see the TSDoc on
 * `M3LAppendOnlySealFailure` (`core/storage/append-only-manifest-types.ts`,
 * already implemented and exported through the `core/storage` barrel) for
 * what the handler receives. This file pins ONLY the constructor-boundary
 * validation of the option itself, mirroring
 * `internal/storage/append-only-options.ts`'s existing `onTruncatedTail`
 * precedent (`validateReadOptions`) byte for byte in polarity: a function is
 * accepted, an omitted option is accepted, a TRUTHY non-function throws
 * `ERR_INVALID_ARGUMENT`, and a FALSY non-function degrades silently to "no
 * handler" rather than throwing.
 *
 * RED PHASE: `onSealFailed` is not yet in `M3LAppendOnlyStream`'s options
 * allowlist. Every test below that constructs with an `onSealFailed` key is
 * expected to fail — the current validator rejects it as an unrecognized
 * key (`ERR_INVALID_ARGUMENT` / `{ field: "options", violation:
 * "unknown-key" }`) regardless of what value is supplied, which is not yet
 * the behaviour these tests pin. Split into its own sibling file rather
 * than added to `storage-append-only-stream.test.ts`, which sits at 58,389
 * of 60,000 chars.
 *
 * Split test/behavior split: constructor-boundary validation only. Whether
 * `onSealFailed` is actually INVOKED on a real seal failure is a
 * higher-level integration behavior belonging to the sealer's own test file
 * once the writer wires it up.
 *
 * @packageDocumentation
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { M3LError } from "../src/core/errors/index.js";
import { M3LAppendOnlyStream } from "../src/core/storage/index.js";
import type { M3LAppendOnlyStreamOptions } from "../src/core/storage/index.js";

/**
 * Constructs through an `unknown` seam so an options bag carrying a field
 * not yet in the static type (`onSealFailed`, during this RED phase) can
 * reach the constructor without weakening the public type or tripping an
 * excess-property check on an object literal.
 */
function construct(options: unknown): M3LAppendOnlyStream {
  return new M3LAppendOnlyStream(options as M3LAppendOnlyStreamOptions);
}

/** Runs `run` and returns whatever it threw, or `undefined` if it did not. */
function catchThrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

/**
 * Asserts a caller-side boundary violation: a bare {@link M3LError} carrying
 * `code: "ERR_INVALID_ARGUMENT"`, matching the house pattern pinned in
 * `storage-append-only-stream.test.ts`'s `expectInvalidArgument`.
 */
function expectInvalidArgument(thrown: unknown): M3LError {
  expect(thrown).toBeInstanceOf(M3LError);
  const error = thrown as M3LError;
  expect(error.code).toBe("ERR_INVALID_ARGUMENT");
  return error;
}

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "m3l-append-only-seal-opts-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Accepted shapes
// ---------------------------------------------------------------------------

describe("onSealFailed — accepted shapes", () => {
  test("a function onSealFailed is accepted", () => {
    const dir = path.join(workDir, "audit");
    const stream = construct({
      directory: dir,
      onSealFailed: () => {
        // Intentionally inert: this test pins acceptance at construction,
        // not invocation.
      },
    });
    expect(stream.directory).toBe(dir);
  });

  test("onSealFailed omitted entirely is accepted", () => {
    const dir = path.join(workDir, "audit");
    const stream = construct({ directory: dir });
    expect(stream.directory).toBe(dir);
  });
});

// ---------------------------------------------------------------------------
// Truthy non-function — rejected
// ---------------------------------------------------------------------------

describe("onSealFailed — truthy non-function is rejected", () => {
  test.each([
    { label: "a string", value: "nope" },
    { label: "a number", value: 42 },
    { label: "a plain object", value: {} },
    { label: "an array", value: [] },
  ])(
    "rejects $label as ERR_INVALID_ARGUMENT with the onSealFailed context",
    ({ value }) => {
      const dir = path.join(workDir, "audit");

      const thrown = catchThrown(() =>
        construct({ directory: dir, onSealFailed: value }),
      );

      const error = expectInvalidArgument(thrown);
      expect(error.context).toEqual({
        field: "onSealFailed",
        violation: "not-a-function",
      });
    },
  );
});

// ---------------------------------------------------------------------------
// Falsy non-function — the polarity test, and the point of this file
// ---------------------------------------------------------------------------

describe("onSealFailed — falsy non-function degrades to no handler", () => {
  // Mirrors `validateReadOptions`'s `onTruncatedTail` check byte for byte:
  // `if (onSealFailed && !isFunction(onSealFailed)) { throw ... }`. Only a
  // TRUTHY non-function throws; a falsy one degrades to "no handler" and
  // must NOT throw. This is the test that must go RED if the check is later
  // "tightened" to `if (onSealFailed !== undefined && !isFunction(...))` —
  // that mutation would reject `0`, `""`, `false` and `null` too, which the
  // documented polarity forbids.
  test.each([
    { label: "undefined", value: undefined },
    { label: "null", value: null },
    { label: "zero", value: 0 },
    { label: "an empty string", value: "" },
    { label: "false", value: false },
  ])("does not throw for $label", ({ value }) => {
    const dir = path.join(workDir, "audit");

    expect(() =>
      construct({ directory: dir, onSealFailed: value }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// No caller data leaks into the thrown error
// ---------------------------------------------------------------------------

describe("onSealFailed — the thrown error carries no caller data", () => {
  test("the directory string is absent from the message and context", () => {
    const distinctiveDirectory = path.join(
      workDir,
      "tenant-zqx-9137-super-secret",
    );

    const thrown = catchThrown(() =>
      construct({ directory: distinctiveDirectory, onSealFailed: "nope" }),
    );

    const error = expectInvalidArgument(thrown);
    expect(error.message).not.toContain(distinctiveDirectory);
    expect(JSON.stringify(error.context)).not.toContain(distinctiveDirectory);
  });
});

// ---------------------------------------------------------------------------
// The allowlist gained a key, it was not loosened
// ---------------------------------------------------------------------------

describe("onSealFailed was added to the allowlist, not the allowlist loosened", () => {
  test("an unrelated unknown key is still rejected", () => {
    const dir = path.join(workDir, "audit");

    const thrown = catchThrown(() =>
      construct({ directory: dir, onSealFailedd: () => {} }),
    );

    const error = expectInvalidArgument(thrown);
    expect(error.context).toEqual({
      field: "options",
      violation: "unknown-key",
    });
  });
});
