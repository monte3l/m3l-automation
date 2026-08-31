/**
 * Tests for `M3LAppendOnlyStream.read`'s OPTIONS-BAG validation (X7b):
 * the unknown-key allow-list and the non-object refusal added when
 * `assertOnTruncatedTailIsCallable` was widened into
 * `internal/storage/append-only-options.ts`'s `validateReadOptions`.
 *
 * Split out of the sibling `storage-append-only-read.test.ts` purely under
 * ADR-0072's size ratchet — that file is at 58,389 of its 60,000-byte
 * ceiling and this block does not fit. The `onTruncatedTail` CALLABLE guard
 * stays there, next to the torn-tail behaviour it protects; what lives here
 * is the shape of the bag itself.
 *
 * @packageDocumentation
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { M3LError } from "../src/core/errors/index.js";
import { M3LAppendOnlyStream } from "../src/core/storage/index.js";
import type { M3LAppendOnlyReadOptions } from "../src/core/storage/index.js";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "m3l-append-only-read-opts-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/** Calls `read` with a deliberately ill-typed bag and returns what it threw. */
function readAndCatch(directory: string, options: unknown): unknown {
  const reader = new M3LAppendOnlyStream({ directory });
  try {
    reader.read(options as M3LAppendOnlyReadOptions);
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("unknown keys on the read options bag", () => {
  // INVARIANT: an unrecognised own key is a typo'd known one far more often
  // than it is intent, and the likeliest one — `read({ directory })` — would
  // otherwise silently read the CONSTRUCTOR's directory while the caller
  // believed they had redirected the read. Rejected, not ignored, matching
  // the constructor bag's own allow-list.
  //
  // The two allow-lists are deliberately SEPARATE sets sharing one rejection
  // helper: a single merged set would make the `directory` row below pass,
  // which is the exact confusion this guard exists to prevent.
  test.each([
    ["a constructor-only key", { directory: "/tmp" }],
    ["a typo'd known key", { onTruncatedTails: (): void => {} }],
    [
      "an unknown key beside a valid one",
      { onTruncatedTail: (): void => {}, extra: 1 },
    ],
  ] as [string, unknown][])("rejects %s", (_label, value) => {
    const thrown = readAndCatch(workDir, value);
    expect(thrown).toBeInstanceOf(M3LError);
    expect((thrown as M3LError).code).toBe("ERR_INVALID_ARGUMENT");
    // `field` is "options", never the offending key: an unknown key is
    // caller input, and this error never echoes caller input back.
    expect((thrown as M3LError).context).toEqual({
      field: "options",
      violation: "unknown-key",
    });
  });
});

describe("the shape of the read options bag itself", () => {
  // INVARIANT: `read("nonsense")` used to return silently. It is now refused,
  // matching the constructor: a caller who passed a non-object passed
  // SOMETHING, and reading under the default torn-tail policy while they
  // believed they had installed a callback is the failure this prevents.
  test.each([
    ["a string", "nonsense"],
    ["null", null],
    ["an array", []],
  ] as [string, unknown][])("rejects %s", (_label, value) => {
    const thrown = readAndCatch(workDir, value);
    expect(thrown).toBeInstanceOf(M3LError);
    expect((thrown as M3LError).context).toEqual({
      field: "options",
      violation: "not-an-object",
    });
  });

  // …while `read()` with no bag at all stays the documented no-options call.
  test("accepts an omitted options bag", () => {
    const reader = new M3LAppendOnlyStream({ directory: workDir });
    expect(() => reader.read()).not.toThrow();
  });

  // …and an empty bag is a bag with no unknown keys, not a malformed one.
  test("accepts an empty options bag", () => {
    const reader = new M3LAppendOnlyStream({ directory: workDir });
    expect(() => reader.read({})).not.toThrow();
  });
});
