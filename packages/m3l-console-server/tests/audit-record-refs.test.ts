/**
 * Tests for src/audit/record.ts — the REFUSAL surface of the human-action
 * audit record (m3l-console-server X7, slice 3, ADR-0070), split out of
 * `tests/audit-record.test.ts` to keep that file under the 60,000-byte file
 * budget.
 *
 * Three groups of contract live here, all of them consequences of the same
 * property `tests/audit-record.test.ts` states positively — no audit record
 * may carry a parameter VALUE:
 *
 * 1. An ADR-0068 reference that is an `inline` envelope is not a reference at
 *    all: `sessions/artifacts.ts`'s `inline` arm carries `value: unknown`, so
 *    an encoded inline ref smuggles the parameter VALUE itself into
 *    `parameterRefs`. It must be refused. `audit/` may not import
 *    `sessions/` (eslint zone), so the check is STRUCTURAL — parse the entry
 *    and look at `kind`.
 * 2. A caller TYPE violation is a caller fault, not a trail outage. It must
 *    carry its own code, distinct from `ERR_CONSOLE_AUDIT_WRITE_FAILED` —
 *    which `http/envelope.ts` classifies as a retryable 503, a rendering a
 *    caller mistake must never receive.
 * 3. The narrowing has to reach the CONTAINERS and the verbatim-copied
 *    scalar fields, not just list entries and `detail` values: today a
 *    non-array `parameterNames`, a string `detail`, or an object `operator`
 *    either escapes as a raw `TypeError` (unclassifiable by a route handler)
 *    or lands on the segment carrying caller data.
 *
 * RED: `ERR_CONSOLE_AUDIT_RECORD_INVALID` does not exist yet, and none of the
 * refusals below is implemented — every assertion here is expected to fail
 * until the implementer lands them.
 */
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { M3LConsoleError } from "../src/errors/console-error.js";
import type { M3LOperatorProfile } from "../src/auth/identity.js";
import type { M3LHumanActionAuditPort } from "../src/audit/port.js";
import { createHumanActionAuditStream } from "../src/audit/stream.js";
import {
  humanActionRecordFrom,
  projectHumanActionRecord,
} from "../src/audit/record.js";
import type { M3LHumanActionRecord } from "../src/audit/record.js";

/** A recognisable secret planted in a parameter VALUE; it may never leak. */
const SECRET_VALUE = "shibboleth-9f2c-parameter-value-must-not-leak";

/** An operator who declared no email. */
const OPERATOR: M3LOperatorProfile = { name: "ada", email: undefined };

/**
 * A file-backed ADR-0068 reference, in the exact envelope shape
 * `sessions/artifacts.ts`'s `encodeArtifactRef` emits for the `file` arm: a
 * POINTER (path, size, digest) and no payload. This is what `parameterRefs`
 * exists to carry, and it must keep flowing.
 */
const FILE_REF = `{"kind":"file","path":"sess-1/step-1.json","bytes":128,"sha256":"${"a".repeat(64)}"}`;

/**
 * An `inline` ADR-0068 reference, in the exact shape `encodeArtifactRef`
 * emits for the `inline` arm — `{"kind":"inline","value":<payload>}`. The
 * `value` IS the parameter content, so persisting this entry writes the
 * parameter value into the trail: the one thing the record's shape exists to
 * make unrepresentable.
 */
const INLINE_REF = JSON.stringify({ kind: "inline", value: SECRET_VALUE });

/** An inline ref whose payload is an object, i.e. the nested-secret shape. */
const INLINE_REF_NESTED = JSON.stringify({
  kind: "inline",
  value: { apiToken: SECRET_VALUE },
});

/** Builds a record through the public builder, defaulting to a script launch. */
function buildRecord(
  overrides: Partial<Parameters<typeof humanActionRecordFrom>[0]> = {},
): M3LHumanActionRecord {
  return humanActionRecordFrom({
    atMs: 1_700_000_000_000,
    operator: OPERATOR,
    correlationId: "corr-1",
    action: "run.launch",
    target: { kind: "script", id: "script-1", scriptName: "sqs-etl" },
    parameters: { queueUrl: "https://sqs.example.invalid/q" },
    parameterRefs: [FILE_REF],
    posture: "confirmed",
    outcome: "allowed",
    detail: { attempt: 1 },
    ...overrides,
  });
}

/**
 * Builds a record the way a plain-JavaScript caller would: a valid record
 * with own keys overwritten by values the interface forbids, handed over
 * through a cast. Trust-boundary fixtures, not type tests.
 */
function castRecord(
  overrides: Readonly<Record<string, unknown>>,
): M3LHumanActionRecord {
  return { ...buildRecord(), ...overrides };
}

/**
 * The caller-fault refusal code: a record the console REFUSES to build is a
 * caller mistake detected before any filesystem call, not a trail that may be
 * writable again on the next attempt.
 */
const INVALID_CODE = "ERR_CONSOLE_AUDIT_RECORD_INVALID";

/** The trail-outage code, which a caller fault must never be rendered as. */
const WRITE_FAILED_CODE = "ERR_CONSOLE_AUDIT_WRITE_FAILED";

/**
 * Asserts `act` refuses loudly with the caller-fault code, and that neither
 * the message nor the context carries the offending value onward — an error
 * message travels further than the segment it describes (`stream.ts:29-35`).
 */
function expectInvalidRecord(act: () => unknown): M3LConsoleError {
  let thrown: unknown;
  try {
    act();
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(M3LConsoleError);
  const refusal = thrown as M3LConsoleError;
  expect(refusal.code).toBe(INVALID_CODE);
  expect(refusal.code).not.toBe(WRITE_FAILED_CODE);
  expect(refusal.message).not.toContain(SECRET_VALUE);
  expect(JSON.stringify(refusal.context)).not.toContain(SECRET_VALUE);
  return refusal;
}

/** Runs `body` against a fresh file-backed port under a private temp root. */
async function withAuditPort<T>(
  body: (port: M3LHumanActionAuditPort, directory: string) => Promise<T>,
): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "m3l-audit-refs-"));
  const directory = join(root, "audit");
  try {
    return await body(createHumanActionAuditStream({ directory }), directory);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Every byte written under `directory`; `""` when nothing was appended. */
function readSegmentBytes(directory: string): string {
  if (!existsSync(directory)) return "";
  return readdirSync(directory)
    .sort((left, right) => left.localeCompare(right))
    .map((name) => readFileSync(join(directory, name), "utf8"))
    .join("");
}

describe("parameterRefs — an inline ADR-0068 ref is a VALUE, not a reference", () => {
  // `sessions/artifacts.ts`'s `M3LSessionArtifactRef` is a union: the `file`
  // arm is a pointer, the `inline` arm carries `value: unknown` — the payload
  // itself. `record.ts` documents `parameterRefs` as "references to parameter
  // content held ELSEWHERE", which an inline envelope is not, so an encoded
  // inline ref persists the parameter value (up to the per-entry byte budget)
  // into the append-only trail.
  //
  // THE PINNED RULE: an entry is refused when, and only when, it parses as
  // JSON yielding a non-null OBJECT whose `kind` is exactly `"inline"`.
  // Refusing every non-JSON entry would be a breaking overreach — refs are
  // free-form strings today and a future encoding need not be JSON at all.
  test("refuses an inline ref supplied through the builder", () => {
    expectInvalidRecord(() => buildRecord({ parameterRefs: [INLINE_REF] }));
  });

  test("refuses an inline ref whose payload is a nested object", () => {
    expectInvalidRecord(() =>
      buildRecord({ parameterRefs: [INLINE_REF_NESTED] }),
    );
  });

  test("refuses an inline ref supplied to projectHumanActionRecord", () => {
    expectInvalidRecord(() =>
      projectHumanActionRecord(castRecord({ parameterRefs: [INLINE_REF] })),
    );
  });

  test("refuses an inline ref sitting among well-formed file refs", () => {
    expectInvalidRecord(() =>
      buildRecord({ parameterRefs: [FILE_REF, INLINE_REF, FILE_REF] }),
    );
  });

  test("refuses an inline ref padded with the whitespace JSON.parse tolerates", () => {
    expectInvalidRecord(() =>
      buildRecord({ parameterRefs: [`  ${INLINE_REF}\n`] }),
    );
  });

  test("refuses an inline ref longer than the per-entry byte budget", () => {
    // Ordering pin: the structural check must run BEFORE per-entry byte
    // truncation. A budget-truncated inline envelope no longer parses as
    // JSON, so a check applied afterwards would wave through the very
    // entries whose payloads are largest.
    const oversized = JSON.stringify({
      kind: "inline",
      value: `${SECRET_VALUE}-${"x".repeat(8192)}`,
    });

    expectInvalidRecord(() => buildRecord({ parameterRefs: [oversized] }));
  });

  test("the refusal names the field without quoting the smuggled value", () => {
    const refusal = expectInvalidRecord(() =>
      buildRecord({ parameterRefs: [INLINE_REF] }),
    );

    expect(refusal.message).toContain("parameterRefs");
    expect(refusal.message).not.toContain(SECRET_VALUE);
    expect(refusal.message).not.toContain(INLINE_REF);
  });

  test("an inline ref never reaches the segment", async () => {
    await withAuditPort(async (port, directory) => {
      const record = castRecord({ parameterRefs: [INLINE_REF] });

      await expect(port.record(record)).rejects.toBeInstanceOf(M3LConsoleError);

      expect(readSegmentBytes(directory)).toBe("");
    });
  });

  test.each<[string, string]>([
    ["a file-kind ADR-0068 envelope", FILE_REF],
    ["an opaque non-JSON reference string", "sess-1/step-1.json#sha256:abc"],
    ["a bare id", "artifact-42"],
    ["JSON that is not an object", '"inline"'],
    ["a JSON number", "42"],
    ["a JSON array of inline-looking members", '[{"kind":"inline"}]'],
    ["an envelope whose kind is not inline", '{"kind":"file","path":"a"}'],
    ["a kind that merely contains the word", '{"kind":"inlined"}'],
  ])("still accepts %s", (_label, ref) => {
    const record = buildRecord({ parameterRefs: [ref] });

    expect(record.parameterRefs).toContain(ref);
  });
});

describe("a caller fault and a trail outage carry different codes", () => {
  // `ERR_CONSOLE_AUDIT_WRITE_FAILED` is classified `retryable: true`,
  // `origin: "library"`, 503 — "the trail may be writable again on the next
  // attempt, and the action itself was never attempted". A record the console
  // refuses to BUILD is none of those things: the caller sent a shape the
  // record may not carry, retrying it changes nothing, and slice 5 would
  // otherwise render a caller mistake as a retryable 503.
  //
  // `tests/envelope.test.ts` pins the new code's classification (400 /
  // caller / non-retryable / not a fault); `tests/audit-stream.test.ts` pins
  // that a real WRITE failure keeps `ERR_CONSOLE_AUDIT_WRITE_FAILED`.
  test.each<[string, () => unknown]>([
    [
      "a non-string parameterRefs entry",
      () => projectHumanActionRecord(castRecord({ parameterRefs: [{}] })),
    ],
    [
      "a non-scalar detail value",
      () =>
        projectHumanActionRecord(
          castRecord({ detail: { nested: { pw: SECRET_VALUE } } }),
        ),
    ],
    [
      "an inline parameterRefs entry",
      () => buildRecord({ parameterRefs: [INLINE_REF] }),
    ],
  ])("%s is refused as a caller fault, not a write failure", (_label, act) => {
    expectInvalidRecord(act);
  });
});

describe("humanActionRecordFrom — a non-object `parameters` is refused, never flattened", () => {
  // `Object.keys(input.parameters ?? {})` returns `[]` for any primitive, so
  // a caller reaching the builder from plain JavaScript with
  // `parameters: 5` records "no parameters supplied" — the trail then
  // asserts something false about what the operator sent, which is the one
  // outcome an audit record may never produce.
  test.each<[string, unknown]>([
    ["a number", 5],
    ["a string", SECRET_VALUE],
    ["a boolean", true],
    ["a function", (): string => SECRET_VALUE],
  ])("refuses %s as parameters", (_label, parameters) => {
    expectInvalidRecord(() =>
      buildRecord({
        parameters: parameters as Readonly<Record<string, unknown>>,
      }),
    );
  });

  test.each<[string, undefined | null]>([
    ["undefined", undefined],
    ["null", null],
  ])("still treats %s as 'no parameters supplied'", (_label, parameters) => {
    // Only an ABSENT parameters object may flatten to an empty name list:
    // that is the documented default, not a lost value.
    const record = buildRecord({
      parameters: parameters as undefined,
    });

    expect(record.parameterNames).toEqual([]);
  });
});

describe("projectHumanActionRecord — the CONTAINERS are narrowed too", () => {
  // The module narrows list ENTRIES and `detail` VALUES, but not the
  // containers holding them, so a plain-JS caller gets a raw `TypeError`
  // ("values.slice is not a function") instead of the typed refusal
  // `port.ts:37-38` documents `record()` as failing with — a slice-5 handler
  // classifying on `M3LConsoleError` would miss every one of these and emit
  // an unclassified 500.
  //
  // `detail: "oops"` is the sharpest of them: `Object.entries` over a string
  // yields per-CHARACTER entries, so it does not throw at all today — the
  // caller's string is indexed straight into the trail.
  test.each<[string, Readonly<Record<string, unknown>>]>([
    ["parameterNames: undefined", { parameterNames: undefined }],
    ["parameterNames: a string", { parameterNames: "abc" }],
    ["parameterNames: a number", { parameterNames: 5 }],
    ["parameterNames: a plain object", { parameterNames: { 0: "a" } }],
    ["parameterRefs: undefined", { parameterRefs: undefined }],
    ["parameterRefs: a number", { parameterRefs: 5 }],
    ["parameterRefs: a string", { parameterRefs: FILE_REF }],
    ["detail: undefined", { detail: undefined }],
    ["detail: null", { detail: null }],
    ["detail: a string", { detail: SECRET_VALUE }],
    ["detail: an array", { detail: [1, 2] }],
    ["target: undefined", { target: undefined }],
    ["target: a string", { target: "run-1" }],
    ["target: an unknown kind", { target: { kind: "wallet", id: "w-1" } }],
  ])("refuses %s with the typed console error", (_label, overrides) => {
    expectInvalidRecord(() => projectHumanActionRecord(castRecord(overrides)));
  });

  test("a per-character detail string never reaches the segment", async () => {
    await withAuditPort(async (port, directory) => {
      const record = castRecord({ detail: SECRET_VALUE });

      await expect(port.record(record)).rejects.toBeInstanceOf(M3LConsoleError);

      expect(readSegmentBytes(directory)).toBe("");
    });
  });

  test("refuses a non-object operator reaching the builder", () => {
    expectInvalidRecord(() =>
      humanActionRecordFrom({
        atMs: 1,
        operator: undefined as unknown as M3LOperatorProfile,
        correlationId: "corr-1",
        action: "run.launch",
        target: { kind: "run", id: "run-1" },
        posture: "confirmed",
        outcome: "allowed",
      }),
    );
  });
});

describe("projectHumanActionRecord — the verbatim-copied fields are narrowed", () => {
  // `operator`, `correlationId` and the target's `id`/`scriptName` are copied
  // field for field with no runtime check, so an object planted in any of
  // them survives the rebuild and persists as a nested node — the same
  // value-leak route the inline ref opens, through four more doors.
  test.each<[string, Readonly<Record<string, unknown>>]>([
    ["operator", { operator: { secret: SECRET_VALUE } }],
    ["operator (a number)", { operator: 7 }],
    ["correlationId", { correlationId: { secret: SECRET_VALUE } }],
    ["target.id", { target: { kind: "run", id: { secret: SECRET_VALUE } } }],
    [
      "target.scriptName",
      {
        target: {
          kind: "script",
          id: "script-1",
          scriptName: { secret: SECRET_VALUE },
        },
      },
    ],
    ["atMs (a string)", { atMs: SECRET_VALUE }],
    [
      "operatorEmailDeclared (a string)",
      { operatorEmailDeclared: SECRET_VALUE },
    ],
    [
      "action (not a member of the closed kind union)",
      { action: "run.delete" },
    ],
    ["posture (not a member of the closed union)", { posture: "maybe" }],
    ["outcome (not a member of the closed union)", { outcome: "shrug" }],
  ])("refuses a non-conforming %s", (_label, overrides) => {
    expectInvalidRecord(() => projectHumanActionRecord(castRecord(overrides)));
  });

  test("an object planted in operator never reaches the segment", async () => {
    await withAuditPort(async (port, directory) => {
      const record = castRecord({ operator: { secret: SECRET_VALUE } });

      await expect(port.record(record)).rejects.toBeInstanceOf(M3LConsoleError);

      expect(readSegmentBytes(directory)).toBe("");
    });
  });
});

describe("detail — a number JSON cannot carry back out is refused at the console boundary", () => {
  // `typeof NaN === "number"`, so `isDetailScalar` admits NaN, both
  // infinities and `-0`. Core's own projection refuses all four two layers
  // later — `internal/storage/append-only-projection.ts:156-157`
  // (`Number.isFinite`) and `:159-160` (`Object.is(value, -0)`, added in X7
  // slice 2 because `JSON.parse(JSON.stringify({ a: -0 })).a` is `+0`, so the
  // persisted line would disagree with the entry). Left to Core, every one of
  // them reaches the operator as `ERR_CONSOLE_AUDIT_WRITE_FAILED` — "the
  // audit trail is unwritable" — for what is a console-authored value (a
  // `durationMs` computed over a missing timestamp, or a `-0` falling out of
  // `Math.round(-0.4)`). Refused HERE, it is the caller fault it actually is,
  // and the message can name the offending key.
  test.each<[string, number]>([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["-0", -0],
  ])("refuses %s as a detail value", (_label, value) => {
    const refusal = expectInvalidRecord(() =>
      projectHumanActionRecord(castRecord({ detail: { durationMs: value } })),
    );

    expect(refusal.message).toContain("durationMs");
  });

  test("still accepts +0, the value -0 must not be silently normalised to", () => {
    // The refusal above must bite on `-0` ONLY: `Object.is` distinguishes the
    // two zeros, and normalising `-0` to `+0` here would be the same
    // "persisted line disagrees with the entry" defect Core's check exists to
    // prevent, just moved one layer up.
    const record = projectHumanActionRecord(
      castRecord({ detail: { delta: 0 } }),
    );

    expect(Object.is(record.detail["delta"], 0)).toBe(true);
  });

  test("a non-finite detail value never reaches the segment", async () => {
    await withAuditPort(async (port, directory) => {
      const record = castRecord({ detail: { durationMs: Number.NaN } });

      await expect(port.record(record)).rejects.toBeInstanceOf(M3LConsoleError);

      expect(readSegmentBytes(directory)).toBe("");
    });
  });
});

describe("detail — a negative zero never reaches the segment", () => {
  // The byte-level half of the same pin: `-0` must be refused before the
  // append, not normalised into `0` on the way to disk.
  //
  // The CODE assertion is what makes this test discriminate. Nothing reaches
  // the segment today either — Core's own `Object.is(value, -0)` check
  // (`append-only-projection.ts:159-160`) rejects the append two layers
  // down — so an empty-segment assertion alone would pass against the
  // pre-fix code. What is wrong today is WHICH failure the operator sees: a
  // retryable "the audit trail is unwritable" 503 for a console-authored
  // value that a retry can never fix.
  test("a -0 detail value is refused as a caller fault, not as an unwritable trail", async () => {
    await withAuditPort(async (port, directory) => {
      const record = castRecord({ detail: { delta: -0 } });

      let thrown: unknown;
      try {
        await port.record(record);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LConsoleError);
      expect((thrown as M3LConsoleError).code).toBe(INVALID_CODE);
      expect(readSegmentBytes(directory)).toBe("");
    });
  });
});
