/**
 * Tests for `M3LAgentDecisionLog`'s `onSealFailed` constructor option (X8,
 * writer-seal wiring) — the `core/agent` side of the option whose
 * `core/storage` sibling is pinned in `storage-append-only-seal-options.test.ts`.
 *
 * `onSealFailed` is the caller's channel for a best-effort manifest seal
 * that could not be written — see the TSDoc on `M3LAppendOnlySealFailure`
 * (`core/storage/append-only-manifest-types.ts`) for what the handler
 * receives, and on `M3LAgentDecisionLogOptions.onSealFailed`
 * (`core/agent/decision-log.ts`) for why sealing is best-effort here too.
 *
 * This file pins the constructor-boundary validation performed by
 * `internal/agent/decision-log-writer.ts`'s `readOnSealFailed` /
 * `validateAgentDecisionLogOptions`, driven only through the public
 * `new M3LAgentDecisionLog({...})` boundary — never the internal validator
 * directly. It mirrors the storage sibling file's shape and reasoning:
 * a function is accepted, an omitted option is accepted, a TRUTHY
 * non-function throws `ERR_INVALID_ARGUMENT`, and a FALSY non-function
 * degrades silently to "no handler" rather than throwing.
 *
 * Split into its own sibling file rather than folded into
 * `agent-decision-log-writer.test.ts` (already large), matching the
 * storage-side precedent.
 *
 * Split test/behavior split: constructor-boundary validation, plus
 * `flush()`'s documented drain guarantee. Whether `onSealFailed` is actually
 * INVOKED on a real seal failure is a higher-level integration behavior
 * belonging to a sealer-focused test file, not this one.
 *
 * @packageDocumentation
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  agentDecisionLogEntry,
  M3LAgentDecisionLog,
} from "../src/core/agent/index.js";
import type {
  M3LAgentDecision,
  M3LAgentDecisionLogEntry,
  M3LAgentDecisionLogOptions,
  M3LAgentIdentity,
} from "../src/core/agent/index.js";
import { M3LError } from "../src/core/errors/index.js";

/**
 * Constructs through an `unknown` seam so an options bag carrying a value
 * the static type wouldn't accept for `onSealFailed` (a string, a number,
 * ...) can reach the constructor without weakening the public type or
 * tripping an excess-property check on an object literal.
 */
function construct(options: unknown): M3LAgentDecisionLog {
  return new M3LAgentDecisionLog(options as M3LAgentDecisionLogOptions);
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
 * `agent-decision-log-writer.test.ts`'s `expectInvalidArgument`.
 */
function expectInvalidArgument(thrown: unknown): M3LError {
  expect(thrown).toBeInstanceOf(M3LError);
  const error = thrown as M3LError;
  expect(error.code).toBe("ERR_INVALID_ARGUMENT");
  return error;
}

const DEFAULT_IDENTITY: M3LAgentIdentity = { name: "release-bot" };

/** Builds a real, slice-1-validated entry ready to hand to the writer. */
function makeEntry(now: number): M3LAgentDecisionLogEntry {
  const decision: M3LAgentDecision = {
    verdict: "auto-approved",
    rule: "read-only-auto-approved",
    reason: "read-only action on an allowlisted script",
    action: {
      script: "s3-report",
      operation: undefined,
      kind: "read-only",
      target: undefined,
      parameterNames: ["bucket", "prefix"],
      dryRun: false,
      shapeKey: "s3-report:read-only",
    },
  };
  return agentDecisionLogEntry({ decision, identity: DEFAULT_IDENTITY, now });
}

const BASE_NOW = Date.UTC(2026, 0, 1, 0, 0, 0);

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "m3l-agent-decision-log-seal-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Accepted shapes
// ---------------------------------------------------------------------------

describe("onSealFailed — accepted shapes", () => {
  test("a function onSealFailed is accepted, and write() through it still works", async () => {
    const dir = path.join(workDir, "agent-log");
    const log = construct({
      directory: dir,
      onSealFailed: () => {
        // Intentionally inert: this test pins acceptance at construction and
        // that writing still succeeds, not invocation of the handler.
      },
    });

    await expect(log.write(makeEntry(BASE_NOW))).resolves.toBeUndefined();
    await log.flush();
  });

  test("onSealFailed omitted entirely is accepted", () => {
    const dir = path.join(workDir, "agent-log");
    expect(() => construct({ directory: dir })).not.toThrow();
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
      const dir = path.join(workDir, "agent-log");

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
  // Mirrors `readOnSealFailed`'s check byte for byte:
  // `if (value && !isFunction(value)) { throw ... }`. Only a TRUTHY
  // non-function throws; a falsy one degrades to "no handler" and must NOT
  // throw. This is the test that must go RED if the check is later
  // "tightened" to `if (value !== undefined && !isFunction(value))` — that
  // mutation would reject `0`, `""`, `false` and `null` too, which the
  // documented polarity forbids.
  test.each([
    { label: "undefined", value: undefined },
    { label: "null", value: null },
    { label: "zero", value: 0 },
    { label: "an empty string", value: "" },
    { label: "false", value: false },
  ])("does not throw for $label", ({ value }) => {
    const dir = path.join(workDir, "agent-log");

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
    const dir = path.join(workDir, "agent-log");

    const thrown = catchThrown(() =>
      construct({ directory: dir, onSealFailedd: () => {} }),
    );

    const error = expectInvalidArgument(thrown);
    expect(error.context).toEqual({
      field: "options",
      violation: "unknown-key",
      key: "onSealFailedd",
    });
  });
});

// ---------------------------------------------------------------------------
// flush() — a point-in-time drain, never rejects, safe-to-remove afterward
// ---------------------------------------------------------------------------

describe("flush()", () => {
  test("resolves after a write(), and the directory then removes cleanly", async () => {
    const dir = path.join(workDir, "agent-log");
    const log = construct({
      directory: dir,
      onSealFailed: () => {
        // Inert: this test is about `flush()` draining the chain, not about
        // whether a seal actually failed.
      },
    });

    await log.write(makeEntry(BASE_NOW));

    await expect(log.flush()).resolves.toBeUndefined();

    // flush()'s documented guarantee is that it is then safe to remove the
    // directory: a still-in-flight manifest seal would otherwise recreate
    // `manifest.jsonl` partway through this recursive remove and surface as
    // `ENOTEMPTY`. `rm` without `force` lets that failure mode surface.
    await expect(rm(dir, { recursive: true })).resolves.toBeUndefined();
  });
});
