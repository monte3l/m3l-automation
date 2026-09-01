/**
 * Tests for src/audit/record.ts — the human-action audit record model
 * (m3l-console-server X7, slice 3, ADR-0070): its closed type surface,
 * `humanActionRecordFrom`'s value-discarding builder, `humanActionPostureFor`'s
 * derivation of the three postures from the shipped `runs/policy.ts` rule, and
 * `projectHumanActionRecord`'s detached rebuild.
 *
 * The DEFINING assertion of this slice is that no audit record can carry a
 * parameter VALUE — only parameter NAMES and ADR-0068 references. This file
 * proves it at the TYPE level (the record's key set is closed and enumerated,
 * and no field is typed to accept caller data) and at the object level (a
 * builder handed a secret-bearing parameters object emits only its keys).
 * `tests/audit-stream.test.ts` proves the same property at the BYTE level,
 * against a real segment file.
 *
 * `record.ts` is pure data construction, so most of this file needs no
 * filesystem I/O. Three groups are the exception: the cast-boundary,
 * line-ceiling and truncation-marker tests assert on what does (or does not)
 * reach the SEGMENT BYTES, which only a real append can settle — those run
 * against real temp directories through `createHumanActionAuditStream`, with
 * the `node:fs` functions imported by NAME (the idiom
 * `tests/audit-stream.test.ts` documents).
 *
 * RED: `../src/audit/record.js` does not exist yet — every import below is
 * expected to fail to resolve until the implementer lands the module.
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

import { describe, expect, expectTypeOf, test } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import { M3LConsoleError } from "../src/errors/console-error.js";
import type { M3LOperatorProfile } from "../src/auth/identity.js";
import type { M3LHumanActionAuditPort } from "../src/audit/port.js";
import { createHumanActionAuditStream } from "../src/audit/stream.js";
import {
  humanActionPostureFor,
  humanActionRecordFrom,
  projectHumanActionRecord,
} from "../src/audit/record.js";
import type {
  M3LHumanActionKind,
  M3LHumanActionOperator,
  M3LHumanActionOutcome,
  M3LHumanActionRecord,
  M3LHumanActionTarget,
} from "../src/audit/record.js";

/**
 * A recognisable secret planted in a parameter VALUE. Nothing derived from a
 * record may ever contain it — this is the slice's defining property.
 */
const SECRET_VALUE = "shibboleth-9f2c-parameter-value-must-not-leak";

/** A declared operator email. `identity.ts:29` promises it is never logged. */
const OPERATOR_EMAIL = "ada@example.invalid";

/** An operator who declared no email. */
const OPERATOR: M3LOperatorProfile = { name: "ada", email: undefined };

/** The same operator, with an email declared. */
const OPERATOR_WITH_EMAIL: M3LOperatorProfile = {
  name: "ada",
  email: OPERATOR_EMAIL,
};

/**
 * A file-backed ADR-0068 artifact reference, in the exact envelope shape
 * `sessions/artifacts.ts`'s `encodeArtifactRef` emits. A literal is used
 * rather than importing that encoder so this file drives `audit/record.ts`
 * alone (v8 `perFile` coverage binding — see `tests/store-paths.test.ts`).
 */
const FILE_REF = `{"kind":"file","path":"sess-1/step-1.json","bytes":128,"sha256":"${"a".repeat(64)}"}`;

/** The nine write-action kinds; X7b's view kinds land alongside the SSE wiring. */
const ACTION_KINDS = [
  "run.launch",
  "run.cancel",
  "session.create",
  "session.step.add",
  "session.decision.raise",
  "session.decision.answer",
  "session.binding.select",
  "session.close",
  "session.reopen",
] as const satisfies readonly M3LHumanActionKind[];

/** The five target arms, one fixture each, keyed by discriminant. */
const TARGETS = [
  { kind: "script", id: "script-1", scriptName: "sqs-etl" },
  { kind: "run", id: "run-1" },
  { kind: "session", id: "sess-1" },
  { kind: "step", id: "step-1" },
  { kind: "artifact", id: "artifact-1" },
] as const satisfies readonly M3LHumanActionTarget[];

/**
 * Builds a record through the public builder, defaulting every input to an
 * allowed, confirmed script launch. Deliberately routes through
 * `humanActionRecordFrom` rather than an object literal: the builder is the
 * only place a caller's parameter VALUES are ever in scope, so it is the
 * seam that has to prove it discards them.
 */
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

describe("M3LHumanActionRecord — the closed field shape", () => {
  test("has exactly the eleven readonly fields the contract declares", () => {
    expectTypeOf<M3LHumanActionRecord>().toEqualTypeOf<{
      readonly atMs: number;
      readonly operator: string;
      readonly operatorEmailDeclared: boolean;
      readonly correlationId: string;
      readonly action: M3LHumanActionKind;
      readonly target: M3LHumanActionTarget;
      readonly parameterNames: readonly string[];
      readonly parameterRefs: readonly string[];
      readonly posture: "auto" | "confirmed" | "escalated";
      readonly outcome: "allowed" | "denied" | "rejected" | "failed" | "served";
      readonly detail: Readonly<Record<string, string | number | boolean>>;
    }>();
  });

  test("operator is the profile's NAME (a string), never the profile itself", () => {
    expectTypeOf<M3LHumanActionRecord["operator"]>().toEqualTypeOf<string>();
    expectTypeOf<M3LOperatorProfile>().not.toExtend<
      M3LHumanActionRecord["operator"]
    >();
  });
});

describe("M3LHumanActionRecord — no field can carry a parameter VALUE", () => {
  // The defining type-level assertion of X7 slice 3. The key set is closed
  // and enumerated, so ADDING a value-bearing field (`parameters`,
  // `parameterValues`, `input`, …) breaks this test rather than silently
  // widening what an audit file may contain. Reuses `runs/audit.ts:45-52`'s
  // reasoning verbatim: the type is the primary control, not a redaction list.
  test("keyof is exactly the eleven declared names — no value-bearing field", () => {
    expectTypeOf<keyof M3LHumanActionRecord>().toEqualTypeOf<
      | "atMs"
      | "operator"
      | "operatorEmailDeclared"
      | "correlationId"
      | "action"
      | "target"
      | "parameterNames"
      | "parameterRefs"
      | "posture"
      | "outcome"
      | "detail"
    >();
  });

  test("has no parameters / parameterValues / values / args / input field", () => {
    // One shape per forbidden name: a record missing the property is not
    // assignable to a type requiring it, whatever that property's type.
    expectTypeOf<M3LHumanActionRecord>().not.toExtend<{
      readonly parameters: unknown;
    }>();
    expectTypeOf<M3LHumanActionRecord>().not.toExtend<{
      readonly parameterValues: unknown;
    }>();
    expectTypeOf<M3LHumanActionRecord>().not.toExtend<{
      readonly values: unknown;
    }>();
    expectTypeOf<M3LHumanActionRecord>().not.toExtend<{
      readonly args: unknown;
    }>();
    expectTypeOf<M3LHumanActionRecord>().not.toExtend<{
      readonly input: unknown;
    }>();
  });

  test("carries no operator EMAIL field — only the declared-or-not flag", () => {
    expectTypeOf<M3LHumanActionRecord>().not.toExtend<{
      readonly operatorEmail: unknown;
    }>();
    expectTypeOf<
      M3LHumanActionRecord["operatorEmailDeclared"]
    >().toEqualTypeOf<boolean>();
  });

  test("parameterNames and parameterRefs are readonly string arrays", () => {
    expectTypeOf<M3LHumanActionRecord["parameterNames"]>().toEqualTypeOf<
      readonly string[]
    >();
    expectTypeOf<M3LHumanActionRecord["parameterRefs"]>().toEqualTypeOf<
      readonly string[]
    >();
  });
});

describe("M3LHumanActionTarget — the discriminated union", () => {
  test("discriminates on exactly the five documented kinds", () => {
    expectTypeOf<M3LHumanActionTarget["kind"]>().toEqualTypeOf<
      "script" | "run" | "session" | "step" | "artifact"
    >();
  });

  test("the script arm carries scriptName alongside its id", () => {
    expectTypeOf<
      Extract<M3LHumanActionTarget, { kind: "script" }>
    >().toEqualTypeOf<{
      readonly kind: "script";
      readonly id: string;
      readonly scriptName: string;
    }>();
  });

  test.each(["run", "session", "step", "artifact"] as const)(
    "the %s arm carries its id and nothing else",
    (kind) => {
      // Runtime companion to the per-arm type assertions below: each fixture
      // has exactly the two own keys the arm declares.
      const target = TARGETS.find((candidate) => candidate.kind === kind);
      expect(target).toBeDefined();
      expect(Object.keys(target ?? {})).toEqual(["kind", "id"]);
    },
  );

  test("the non-script arms are exactly { kind, id }", () => {
    expectTypeOf<
      Extract<M3LHumanActionTarget, { kind: "run" }>
    >().toEqualTypeOf<{ readonly kind: "run"; readonly id: string }>();
    expectTypeOf<
      Extract<M3LHumanActionTarget, { kind: "session" }>
    >().toEqualTypeOf<{ readonly kind: "session"; readonly id: string }>();
    expectTypeOf<
      Extract<M3LHumanActionTarget, { kind: "step" }>
    >().toEqualTypeOf<{ readonly kind: "step"; readonly id: string }>();
    expectTypeOf<
      Extract<M3LHumanActionTarget, { kind: "artifact" }>
    >().toEqualTypeOf<{ readonly kind: "artifact"; readonly id: string }>();
  });

  test("an unrecognised discriminant is not a target", () => {
    expectTypeOf<{
      readonly kind: "database";
      readonly id: string;
    }>().not.toExtend<M3LHumanActionTarget>();
  });
});

describe("M3LHumanActionKind — closed union", () => {
  test.each(ACTION_KINDS)("%s is a member of the union", (kind) => {
    // `ACTION_KINDS` is declared `satisfies readonly M3LHumanActionKind[]`, so
    // membership is already a compile-time fact; this exercises it at runtime
    // through the builder as well, which is what a record actually carries.
    expect(buildRecord({ action: kind }).action).toBe(kind);
  });

  test("is closed — an undocumented literal is not a kind", () => {
    expectTypeOf<"run.obliterate">().not.toExtend<M3LHumanActionKind>();
  });
});

describe("humanActionRecordFrom — parameters go in by value, come out by name", () => {
  test("emits only the parameter NAMES, never the values", () => {
    const record = buildRecord({
      parameters: {
        queueUrl: "https://sqs.example.invalid/q",
        apiToken: SECRET_VALUE,
      },
    });

    expect(record.parameterNames).toEqual(["queueUrl", "apiToken"]);
    expect(JSON.stringify(record)).not.toContain(SECRET_VALUE);
  });

  test("a nested secret buried in a parameter value never surfaces", () => {
    const record = buildRecord({
      parameters: {
        credentials: { nested: { deeper: SECRET_VALUE } },
      },
    });

    expect(record.parameterNames).toEqual(["credentials"]);
    expect(JSON.stringify(record)).not.toContain(SECRET_VALUE);
  });

  test("an absent parameters object yields an empty name list, not undefined", () => {
    const record = humanActionRecordFrom({
      atMs: 1,
      operator: OPERATOR,
      correlationId: "corr-1",
      action: "session.create",
      target: { kind: "session", id: "sess-1" },
      posture: "auto",
      outcome: "allowed",
    });

    expect(record.parameterNames).toEqual([]);
    expect(record.parameterRefs).toEqual([]);
    expect(record.detail).toEqual({});
  });

  test("a parameter literally named __proto__ is carried as a plain string", () => {
    // A parameter NAME is caller-influenced input reaching an audit file. As
    // an array ELEMENT it can never become an own key, so it must survive as
    // ordinary text rather than being dropped or mutating any prototype.
    const record = buildRecord({
      parameters: { ["__proto__"]: SECRET_VALUE, ok: 1 },
    });

    expect(record.parameterNames).toContain("__proto__");
    expect(JSON.stringify(record)).not.toContain(SECRET_VALUE);
  });

  test("carries the caller's ADR-0068 refs through verbatim", () => {
    const record = buildRecord({ parameterRefs: [FILE_REF] });

    expect(record.parameterRefs).toEqual([FILE_REF]);
  });
});

describe("humanActionRecordFrom — operator identity", () => {
  test("carries the profile's NAME as operator", () => {
    expect(buildRecord({ operator: OPERATOR }).operator).toBe("ada");
  });

  test("an undeclared email yields operatorEmailDeclared false", () => {
    expect(buildRecord({ operator: OPERATOR }).operatorEmailDeclared).toBe(
      false,
    );
  });

  test("a declared email yields true — and the email itself never appears", () => {
    const record = buildRecord({ operator: OPERATOR_WITH_EMAIL });

    expect(record.operatorEmailDeclared).toBe(true);
    expect(record.operator).toBe("ada");
    expect(JSON.stringify(record)).not.toContain(OPERATOR_EMAIL);
  });

  test("a blank declared email is not a declaration", () => {
    const record = buildRecord({
      operator: { name: "ada", email: "   " },
    });

    expect(record.operatorEmailDeclared).toBe(false);
  });
});

describe("humanActionRecordFrom — bounded parameter lists", () => {
  /**
   * Sentinels chosen well ABOVE any reasonable cap and well BELOW the input
   * these tests supply: they prove a cap exists and bites, without pinning the
   * implementer to a particular number (the contract states "capped", not
   * "capped at N"). Tighten them once the constant is chosen.
   */
  const ABSURD_COUNT = 512;
  const ABSURD_LENGTH = 4_096;

  test("caps the NUMBER of parameter names", () => {
    const parameters: Record<string, string> = {};
    for (let index = 0; index < ABSURD_COUNT * 4; index += 1) {
      parameters[`param-${String(index)}`] = SECRET_VALUE;
    }

    const record = buildRecord({ parameters });

    expect(record.parameterNames.length).toBeLessThan(ABSURD_COUNT);
    expect(new Set(record.parameterNames).size).toBe(
      record.parameterNames.length,
    );
  });

  test("caps the LENGTH of each parameter name", () => {
    const longName = "n".repeat(ABSURD_LENGTH * 4);

    const record = buildRecord({ parameters: { [longName]: SECRET_VALUE } });

    for (const name of record.parameterNames) {
      expect(name.length).toBeLessThan(ABSURD_LENGTH);
    }
  });

  test("caps the NUMBER of parameter refs", () => {
    const refs = Array.from({ length: ABSURD_COUNT * 4 }, () => FILE_REF);

    const record = buildRecord({ parameterRefs: refs });

    expect(record.parameterRefs.length).toBeLessThan(ABSURD_COUNT);
  });

  test("caps the LENGTH of each parameter ref", () => {
    const longRef = "r".repeat(ABSURD_LENGTH * 4);

    const record = buildRecord({ parameterRefs: [longRef] });

    for (const ref of record.parameterRefs) {
      expect(ref.length).toBeLessThan(ABSURD_LENGTH);
    }
  });

  test("a list already within the caps is carried through unchanged", () => {
    const record = buildRecord({
      parameters: { alpha: 1, beta: 2 },
      parameterRefs: [FILE_REF],
    });

    expect(record.parameterNames).toEqual(["alpha", "beta"]);
    expect(record.parameterRefs).toEqual([FILE_REF]);
  });
});

describe("humanActionPostureFor — the shipped runs/policy.ts rule", () => {
  // `createConfirmationPolicy` (runs/policy.ts:116-118) allows a launch when
  // `dryRun || confirmed`. The three postures are that same rule, named:
  // a dry run needed no human gesture (auto), a confirmed real run had one
  // (confirmed), and a run that is neither was denied and needs escalation.
  test.each<[string, boolean, boolean, "auto" | "confirmed" | "escalated"]>([
    ["a dry run", true, false, "auto"],
    ["a dry run that was also confirmed", true, true, "auto"],
    ["a confirmed real run", false, true, "confirmed"],
    ["a denied real run", false, false, "escalated"],
  ])("%s derives posture %s", (_label, dryRun, confirmed, expected) => {
    expect(humanActionPostureFor({ dryRun, confirmed })).toBe(expected);
  });

  test("returns exactly the three-literal posture union", () => {
    expectTypeOf(
      humanActionPostureFor({ dryRun: false, confirmed: true }),
    ).toEqualTypeOf<"auto" | "confirmed" | "escalated">();
  });
});

describe("projectHumanActionRecord — a detached rebuild", () => {
  test("returns a distinct object that equals the input field for field", () => {
    const record = buildRecord();

    const projected = projectHumanActionRecord(record);

    expect(projected).not.toBe(record);
    expect(projected).toEqual(record);
  });

  test("detaches the nested arrays and detail map from the caller's copies", () => {
    const record = buildRecord({ parameters: { alpha: 1 } });

    const projected = projectHumanActionRecord(record);

    expect(projected.parameterNames).not.toBe(record.parameterNames);
    expect(projected.detail).not.toBe(record.detail);
    expect(projected.target).not.toBe(record.target);
  });

  test("drops a value-bearing key smuggled past the type system", () => {
    // A caller reaching the builder through an `as` cast (or a plain-JS
    // consumer) can plant an own key the interface forbids. The projection is
    // the layer that proves no value field EXISTS on what reaches the stream,
    // so the smuggled key — and its secret — must not survive the rebuild.
    const smuggled = {
      ...buildRecord(),
      parameters: { apiToken: SECRET_VALUE },
    } as unknown as M3LHumanActionRecord;

    const projected = projectHumanActionRecord(smuggled);

    expect(Object.hasOwn(projected, "parameters")).toBe(false);
    expect(JSON.stringify(projected)).not.toContain(SECRET_VALUE);
  });

  test("defeats an inherited Object.prototype.toJSON", () => {
    // `Object.freeze` does not stop an inherited `toJSON` forging the bytes a
    // record serializes to. The projection must return an object whose
    // serialization is its own fields, not whatever the prototype dictates.
    const record = buildRecord();
    const prototype = Object.prototype as unknown as {
      toJSON?: () => unknown;
    };

    try {
      prototype.toJSON = () => ({ forged: SECRET_VALUE });

      const projected = projectHumanActionRecord(record);
      const serialized = JSON.stringify(projected);

      expect(serialized).not.toContain(SECRET_VALUE);
      expect(serialized).not.toContain("forged");
      expect(JSON.parse(serialized)).toMatchObject({
        operator: "ada",
        correlationId: "corr-1",
      });
    } finally {
      delete prototype.toJSON;
    }
  });

  test("is idempotent — projecting a projection changes nothing", () => {
    const once = projectHumanActionRecord(buildRecord());

    expect(projectHumanActionRecord(once)).toEqual(once);
  });

  test("returns the record type unchanged", () => {
    expectTypeOf(
      projectHumanActionRecord,
    ).returns.toEqualTypeOf<M3LHumanActionRecord>();
  });
});

/**
 * Runs `body` against a fresh file-backed port under a private temp root,
 * removing the root afterwards. The trust-boundary and line-ceiling tests
 * below assert on what does (or does not) reach the SEGMENT BYTES, which a
 * mocked filesystem could only ever echo back — same idiom, and the same
 * by-name `node:fs` imports, as `tests/audit-stream.test.ts`.
 */
async function withAuditPort<T>(
  body: (port: M3LHumanActionAuditPort, directory: string) => Promise<T>,
): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "m3l-audit-record-"));
  const directory = join(root, "audit");
  try {
    return await body(createHumanActionAuditStream({ directory }), directory);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Every byte written under `directory`, across all segments, as one string.
 * An absent directory means nothing was ever appended — the stream creates it
 * on the first successful append, not at construction.
 */
function readSegmentBytes(directory: string): string {
  if (!existsSync(directory)) return "";
  return readdirSync(directory)
    .sort((left, right) => left.localeCompare(right))
    .map((name) => readFileSync(join(directory, name), "utf8"))
    .join("");
}

/**
 * Builds a record the way a plain-JavaScript caller would: a valid record
 * with own keys overwritten by values the interface forbids, handed over
 * through a cast. These are TRUST-BOUNDARY fixtures, not type tests —
 * `record.ts:353-360` claims robustness against exactly this caller, so the
 * claim has to be exercised from outside the type system.
 */
function castRecord(
  overrides: Readonly<Record<string, unknown>>,
): M3LHumanActionRecord {
  // The `unknown`-valued spread is what a plain-JS caller hands over; the
  // declared return type is the cast itself, so no `as` is needed (and one
  // would be flagged as unnecessary).
  return { ...buildRecord(), ...overrides };
}

/**
 * A `parameterNames` whose own `slice` returns objects while the array itself
 * looks well-formed — the route the security review used. Whatever the
 * projection READS is what it has to validate.
 */
function poisonedSliceNames(): readonly string[] {
  return Object.defineProperty(["ok"], "slice", {
    value: () => [{ leaked: SECRET_VALUE }],
    enumerable: false,
    writable: false,
    configurable: false,
  });
}

/**
 * Asserts `act` refuses the record loudly, and that the refusal itself
 * carries no parameter value onward (an error message travels further than
 * the segment it describes — `stream.ts:29-35`).
 */
function expectAuditRefusal(act: () => unknown): M3LConsoleError {
  let thrown: unknown;
  try {
    act();
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(M3LConsoleError);
  const refusal = thrown as M3LConsoleError;
  // A record the console refuses to BUILD is a caller fault detected before
  // any filesystem call: it must NOT reuse `ERR_CONSOLE_AUDIT_WRITE_FAILED`,
  // which `http/envelope.ts` classifies as a retryable 503 ("the trail may be
  // writable again on the next attempt"). See `tests/audit-record-refs.test.ts`
  // and the classification row in `tests/envelope.test.ts`.
  expect(refusal.code).toBe("ERR_CONSOLE_AUDIT_RECORD_INVALID");
  expect(refusal.code).not.toBe("ERR_CONSOLE_AUDIT_WRITE_FAILED");
  expect(refusal.message).not.toContain(SECRET_VALUE);
  return refusal;
}

/** The four cast-boundary poisons the security review reached the port with. */
const POISONED_RECORDS = [
  [
    "a non-string entry in parameterNames",
    (): M3LHumanActionRecord =>
      castRecord({ parameterNames: ["ok", { leaked: SECRET_VALUE }] }),
  ],
  [
    "a non-string entry in parameterRefs",
    (): M3LHumanActionRecord =>
      castRecord({ parameterRefs: [{ leaked: SECRET_VALUE }] }),
  ],
  [
    "a non-scalar detail value",
    (): M3LHumanActionRecord =>
      castRecord({
        detail: { nested: { pw: SECRET_VALUE }, email: OPERATOR_EMAIL },
      }),
  ],
  [
    "a parameterNames whose slice() is poisoned",
    (): M3LHumanActionRecord =>
      castRecord({ parameterNames: poisonedSliceNames() }),
  ],
] as const satisfies readonly (readonly [string, () => M3LHumanActionRecord])[];

describe("projectHumanActionRecord — narrowing at the cast boundary", () => {
  // `boundedList` compares `value.length > maxLength`, which is `false` for a
  // non-string, and `projectDetail` copies `Object.entries` values verbatim —
  // so today a plain object smuggled in as a name or a detail value is
  // neither truncated nor refused, and lands on the segment. Core's own
  // projection cannot catch it: a nested plain object is a legal ENTRY value,
  // so this layer is the only one that can enforce "scalars only".
  //
  // Refusal, not silent dropping: this is an audit trail, and a dropped field
  // under-reports what the operator supplied — the one outcome the stream may
  // never produce. The code is `ERR_CONSOLE_AUDIT_RECORD_INVALID`, the
  // caller-fault half of the audit trail's two codes: slice 5 must render
  // this as a 4xx, and `ERR_CONSOLE_AUDIT_WRITE_FAILED` — a trail outage the
  // caller can retry — as the 503 it is classified as.
  test.each(POISONED_RECORDS)("refuses %s", (_label, build) => {
    expectAuditRefusal(() => projectHumanActionRecord(build()));
  });

  test.each(POISONED_RECORDS)(
    "%s never reaches the segment",
    async (_label, build) => {
      await withAuditPort(async (port, directory) => {
        await expect(port.record(build())).rejects.toBeInstanceOf(
          M3LConsoleError,
        );

        expect(readSegmentBytes(directory)).toBe("");
      });
    },
  );

  test.each<[string, Record<string, unknown>]>([
    ["a nested object", { nested: { pw: SECRET_VALUE } }],
    ["an array", { list: [SECRET_VALUE] }],
    ["null", { absent: null }],
    ["undefined", { absent: undefined }],
    ["a function", { compute: () => SECRET_VALUE }],
    // -0 in a detail value: `detailScalar` refuses it because JSON.stringify
    // serialises -0 as 0, so the persisted line would disagree with the record.
    // The sibling atMs: -0 case is diagnosed by numberField; both are console-
    // layer refusals. Do not consolidate: they exercise different code paths
    // (detailScalar vs numberField) and both must be independently covered.
    ["-0 (negative zero)", { amount: -0 }],
  ])("refuses %s as a detail value", (_label, detail) => {
    expectAuditRefusal(() => projectHumanActionRecord(castRecord({ detail })));
  });

  test("atMs: -0 is refused by numberField and the message names the field", () => {
    // Two different -0 cases, two different console-layer validators — do not
    // consolidate them:
    //
    //  • `detail: { val: -0 }` — `detailScalar` refuses it (see test.each above).
    //  • `atMs: -0` — `numberField` refuses it here, after the fix that gave
    //    numberField parity with detailScalar. The fix moved the diagnosis up from
    //    Core (which refused -0 two layers down without naming the field) to the
    //    console projection, where the field name is known. `audit-stream.test.ts`
    //    covers the surviving Core-disagrees route (the __proto__ key).
    const refusal = expectAuditRefusal(() =>
      projectHumanActionRecord(castRecord({ atMs: -0 })),
    );
    // The point of diagnosing at the console layer is to name the field.
    expect(refusal.message).toContain("atMs");
  });

  test("still accepts every scalar the detail map declares", () => {
    // The narrowing must bite on non-scalars ONLY: string, number and boolean
    // are the closed set `M3LHumanActionRecord["detail"]` declares.
    const record = projectHumanActionRecord(
      castRecord({ detail: { note: "ok", attempt: 2, dryRun: false } }),
    );

    expect(record.detail).toEqual({ note: "ok", attempt: 2, dryRun: false });
  });

  test("refuses a non-string parameter name reached through the builder", () => {
    // `humanActionRecordFrom` derives names from `Object.keys`, so its own
    // names are always strings — but a plain-JS caller can hand it a
    // `parameterRefs` array of objects, and that path must refuse too.
    expectAuditRefusal(() =>
      humanActionRecordFrom({
        atMs: 1,
        operator: OPERATOR,
        correlationId: "corr-1",
        action: "run.launch",
        target: { kind: "run", id: "run-1" },
        parameterRefs: [{ leaked: SECRET_VALUE }] as unknown as string[],
        posture: "confirmed",
        outcome: "allowed",
      }),
    );
  });
});

describe("the documented caps must fit inside the Core line ceiling", () => {
  /**
   * Far above any cap the module could plausibly declare, so the projection
   * clamps every list to ITS OWN maximum: the resulting record is "every list
   * and every entry at its documented maximum" without this file hardcoding a
   * guess. The caps are module-private constants (`record.ts:29-38`), not
   * exported, so they cannot be imported and multiplied out here.
   */
  const OVERSUPPLIED_COUNT = 1_024;
  const OVERSUPPLIED_LENGTH = 8_192;

  /** A record whose every list and entry sits exactly at the module's caps. */
  function maximalRecord(): M3LHumanActionRecord {
    const parameters: Record<string, number> = {};
    for (let index = 0; index < OVERSUPPLIED_COUNT; index += 1) {
      parameters[
        `${String(index).padStart(6, "0")}-${"n".repeat(OVERSUPPLIED_LENGTH)}`
      ] = 1;
    }

    return buildRecord({
      parameters,
      parameterRefs: Array.from({ length: OVERSUPPLIED_COUNT }, () =>
        "r".repeat(OVERSUPPLIED_LENGTH),
      ),
    });
  }

  test("a record at every cap serializes below the Core line ceiling", () => {
    // Measured against the shipped caps, `parameterRefs` ALONE (32 x 2048)
    // renders a 65,850-byte line against a 65,536-byte ceiling, so a record
    // inside its own documented spec cannot be appended at all. The caps have
    // to leave headroom for the other nine fields as well as the newline.
    const record = maximalRecord();

    expect(record.parameterNames.length).toBeLessThan(OVERSUPPLIED_COUNT);
    expect(record.parameterRefs.length).toBeLessThan(OVERSUPPLIED_COUNT);

    const line = `${JSON.stringify(record)}\n`;

    expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(
      Core.M3L_APPEND_ONLY_MAX_LINE_BYTES,
    );
  });

  test("a record at every cap persists through the audit stream", async () => {
    await withAuditPort(async (port, directory) => {
      const record = maximalRecord();

      await expect(port.record(record)).resolves.toBeUndefined();

      const lines = readSegmentBytes(directory)
        .split("\n")
        .filter((line) => line.trim().length > 0);
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0] ?? "null")).toMatchObject({
        correlationId: "corr-1",
        operator: "ada",
      });
    });
  });
});

describe("count-cap truncation is recorded, never silent", () => {
  // `boundedList` drops everything past the count cap with no marker, so the
  // trail under-reports what the operator supplied — the one outcome an audit
  // stream may never produce. (Per-entry CHARACTER truncation is deliberate
  // and keeps a prefix; that stays as it is.) The count is recorded in the
  // closed scalar `detail` map rather than in a twelfth record field: "eleven
  // fields and no twelfth" is this slice's defining property, and a count is
  // a number, not a place a parameter value could hide.
  const SUPPLIED = 512;

  test("records how many parameter names the count cap dropped", () => {
    const parameters: Record<string, number> = {};
    for (let index = 0; index < SUPPLIED; index += 1) {
      parameters[`param-${String(index)}`] = 1;
    }

    const record = buildRecord({ parameters });

    expect(record.parameterNames.length).toBeLessThan(SUPPLIED);
    expect(record.detail["parameterNamesTruncated"]).toBe(
      SUPPLIED - record.parameterNames.length,
    );
  });

  test("records how many parameter refs the count cap dropped", () => {
    const refs = Array.from({ length: SUPPLIED }, () => FILE_REF);

    const record = buildRecord({ parameterRefs: refs });

    expect(record.parameterRefs.length).toBeLessThan(SUPPLIED);
    expect(record.detail["parameterRefsTruncated"]).toBe(
      SUPPLIED - record.parameterRefs.length,
    );
  });

  test("the dropped count survives onto the segment", async () => {
    await withAuditPort(async (port, directory) => {
      const refs = Array.from({ length: SUPPLIED }, () => FILE_REF);

      await port.record(buildRecord({ parameterRefs: refs }));

      expect(readSegmentBytes(directory)).toContain("parameterRefsTruncated");
    });
  });

  test("a record within the caps records no truncation at all", () => {
    // The marker must be evidence, not noise: an untruncated record keeps the
    // caller's detail map exactly as supplied.
    const record = buildRecord({
      parameters: { alpha: 1, beta: 2 },
      parameterRefs: [FILE_REF],
      detail: { attempt: 1 },
    });

    expect(record.detail).toEqual({ attempt: 1 });
  });
});

/**
 * The serialized cost of one entry as it actually lands in a record line: its
 * `JSON.stringify` form, in UTF-8 bytes. This is the unit
 * `Core.M3L_APPEND_ONLY_MAX_LINE_BYTES` counts in, and therefore the unit an
 * entry cap has to be measured in. `String.prototype.length` counts UTF-16
 * code units, which is neither: one code unit can cost 1, 2, 3 or 6 bytes
 * once `JSON.stringify` has escaped it.
 */
function serializedBytes(value: string): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/** The one retained entry of a single-entry list, guarded for the index read. */
function onlyEntry(values: readonly string[]): string {
  expect(values).toHaveLength(1);
  const [value] = values;
  if (value === undefined) throw new Error("expected one retained entry");
  return value;
}

/** A smiling-face emoji: two UTF-16 code units, four UTF-8 bytes, one grapheme. */
const EMOJI = String.fromCodePoint(0x1f642);

/**
 * One repetition of every way a character inflates under `JSON.stringify`: a
 * control character (U+0001, which escapes to six bytes), an escaped quote
 * and an escaped backslash (two bytes each), and a non-BMP character. Five
 * code units in, fourteen serialized bytes out: a 2.8x inflation a CHARACTER
 * cap cannot see.
 *
 * Parameter names are `Object.keys(body.parameters)` of the operator's own
 * request body, so this is reachable input, not a theoretical one.
 */
const INFLATING_UNIT = `${String.fromCharCode(1)}"\\${EMOJI}`;

/** At least `units` code units of {@link INFLATING_UNIT}, never split mid-pair. */
function inflating(units: number): string {
  return INFLATING_UNIT.repeat(Math.ceil(units / INFLATING_UNIT.length));
}

/** An entry far longer than any per-entry cap the module could declare. */
const OVERLONG_ASCII = "n".repeat(16_384);

/**
 * Whether `value` carries a lone surrogate: what byte-budgeted truncation can
 * leave behind when its budget expires in the middle of an astral character,
 * and the failure mode character-budgeted truncation never had. Under the `u`
 * flag a well-formed pair is one astral code point, so `Cs` (the surrogate
 * general category) matches only an UNPAIRED half.
 */
function hasLoneSurrogate(value: string): boolean {
  return /\p{Cs}/u.test(value);
}

/** The retained `parameterNames` for a record built around one supplied name. */
function retainedNames(entry: string): readonly string[] {
  return buildRecord({ parameters: { [entry]: 1 } }).parameterNames;
}

/** The retained `parameterRefs` for a record built around one supplied ref. */
function retainedRefs(entry: string): readonly string[] {
  return buildRecord({ parameterRefs: [entry] }).parameterRefs;
}

/** Both capped lists, so every invariant below is asserted over the whole set. */
const ENTRY_LISTS = [
  ["parameterNames", retainedNames],
  ["parameterRefs", retainedRefs],
] as const satisfies readonly (readonly [
  string,
  (entry: string) => readonly string[],
])[];

/** How many entries the worst-case fixtures supply: far above either count cap. */
const WORST_CASE_SUPPLIED = 512;

/**
 * A record whose every entry is built entirely from escape-inflating and
 * non-BMP characters, supplied far above both count caps and both per-entry
 * caps. Under the shipped CHARACTER caps this renders 64 names of 256
 * all-escaped characters, up to 1,536 bytes each and ~98,304 bytes for the
 * names alone, against a 65,536-byte ceiling.
 */
function worstCaseEscapedRecord(): M3LHumanActionRecord {
  const parameters: Record<string, number> = {};
  for (let index = 0; index < WORST_CASE_SUPPLIED; index += 1) {
    parameters[`${String(index).padStart(4, "0")}${inflating(1_024)}`] = 1;
  }

  return buildRecord({
    parameters,
    parameterRefs: Array.from({ length: WORST_CASE_SUPPLIED }, () =>
      inflating(1_024),
    ),
  });
}

describe("the caps must bound SERIALIZED BYTES, not characters", () => {
  // The caps count characters; `Core.M3L_APPEND_ONLY_MAX_LINE_BYTES` counts
  // bytes after `JSON.stringify`. The shipped arithmetic (64 x 259 + 32 x 515
  // = 33,056) holds only for ASCII: an all-escaped 256-character name costs
  // up to 1,536 bytes, so 64 of them alone reach ~98,304 and blow the
  // ceiling. Slice 5 refuses an action whose audit record cannot be
  // persisted, so this is a 503 on legal operator input: the same defect
  // class the cap change fixed, merely made less likely.
  test("a worst-case all-escaped record still fits the Core line ceiling", () => {
    const line = `${JSON.stringify(worstCaseEscapedRecord())}\n`;

    expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(
      Core.M3L_APPEND_ONLY_MAX_LINE_BYTES,
    );
  });

  test("a worst-case all-escaped record persists through the audit stream", async () => {
    await withAuditPort(async (port, directory) => {
      const record = worstCaseEscapedRecord();

      await expect(port.record(record)).resolves.toBeUndefined();

      const lines = readSegmentBytes(directory)
        .split("\n")
        .filter((line) => line.trim().length > 0);
      expect(lines).toHaveLength(1);
      const persisted = JSON.parse(lines[0] ?? "null") as M3LHumanActionRecord;
      expect(persisted.correlationId).toBe("corr-1");
      // A segment is read back as UTF-8, so an entry truncated mid-pair
      // surfaces here either as a lone surrogate (well-formed
      // `JSON.stringify` writes one as a six-byte escape, so the bytes
      // survive and the defect survives with them) or as U+FFFD.
      for (const entry of [
        ...persisted.parameterNames,
        ...persisted.parameterRefs,
      ]) {
        expect(hasLoneSurrogate(entry)).toBe(false);
        expect(entry).not.toContain(String.fromCharCode(0xfffd));
      }
    });
  });

  test.each(ENTRY_LISTS)(
    "%s truncates a multi-byte entry to FEWER characters than an ASCII one",
    (_label, retain) => {
      // The budget is DERIVED from the module's own ASCII behaviour rather
      // than hardcoded, so this states the invariant ("one entry costs at
      // most what an ASCII entry at the cap costs") instead of a number.
      const ascii = onlyEntry(retain(OVERLONG_ASCII));
      const budgetBytes = serializedBytes(ascii);

      const inflated = onlyEntry(retain(inflating(ascii.length * 4)));

      expect(serializedBytes(inflated)).toBeLessThanOrEqual(budgetBytes);
      expect(inflated.length).toBeLessThan(ascii.length);
    },
  );

  test.each(ENTRY_LISTS)(
    "%s keeps an entry already inside the byte budget verbatim",
    (_label, retain) => {
      // Byte budgeting must not start truncating short non-ASCII entries: a
      // smiling emoji costs four bytes, not a whole budget.
      const short = `alpha-${EMOJI}-omega`;

      expect(onlyEntry(retain(short))).toBe(short);
    },
  );
});

/**
 * Every combination of list and leading alignment: a budget expires mid-pair
 * only at particular offsets, so a single fixture would be a coin flip. The
 * odd-length prefixes misalign a CODE-UNIT cut; the last one contributes two
 * BYTES for one code unit, misaligning a byte cut as well.
 */
const SPLIT_CASES = ["", "a", "aa", "aaa", String.fromCharCode(0xe9)].flatMap(
  (prefix) =>
    ENTRY_LISTS.map(
      ([label, retain]) =>
        [`${label} after ${JSON.stringify(prefix)}`, prefix, retain] as const,
    ),
);

describe("byte-budgeted truncation never splits a surrogate pair", () => {
  // Not merely a lock against a future byte budget: this already FAILS under
  // the shipped CHARACTER truncation. `value.slice(0, 256)` cuts on a
  // code-unit boundary, so an ODD-length prefix followed by astral characters
  // puts the cut in the middle of a pair and persists a lone surrogate today
  // (the even-length arms, "" and "aa", pass). A byte budget moves the cut to
  // many more offsets, so the guarantee has to be stated outright rather than
  // inherited from an accident of code-unit alignment.
  const ASTRAL_ENTRY = EMOJI.repeat(2_048);

  test.each(SPLIT_CASES)(
    "%s retains no lone surrogate",
    (_label, prefix, retain) => {
      const retained = onlyEntry(retain(`${prefix}${ASTRAL_ENTRY}`));

      expect(hasLoneSurrogate(retained)).toBe(false);
    },
  );

  test.each(SPLIT_CASES)(
    "%s round-trips through JSON unchanged",
    (_label, prefix, retain) => {
      // Necessary but NOT sufficient alone: ES2019 well-formed
      // `JSON.stringify` escapes a lone surrogate and `JSON.parse` hands the
      // same lone surrogate back, so this round-trip holds even for a split
      // pair. The surrogate scan above is the discriminating assertion; this
      // one proves the retained value survives serialization at all.
      const retained = onlyEntry(retain(`${prefix}${ASTRAL_ENTRY}`));

      expect(JSON.parse(JSON.stringify(retained))).toBe(retained);
    },
  );
});

describe("count-cap truncation markers survive byte budgeting", () => {
  // The markers report what the COUNT cap dropped. Byte budgeting changes
  // what each retained entry looks like, never how many entries were
  // dropped: a per-entry truncation is not a dropped entry, and conflating
  // the two would make the marker unreadable.
  test("reports the count-cap drop when every entry is also byte-truncated", () => {
    const record = worstCaseEscapedRecord();

    expect(record.detail["parameterNamesTruncated"]).toBe(
      WORST_CASE_SUPPLIED - record.parameterNames.length,
    );
    expect(record.detail["parameterRefsTruncated"]).toBe(
      WORST_CASE_SUPPLIED - record.parameterRefs.length,
    );
  });

  test("the marker for an all-escaped record reaches the segment", async () => {
    await withAuditPort(async (port, directory) => {
      const record = worstCaseEscapedRecord();

      await port.record(record);

      const persisted = JSON.parse(
        readSegmentBytes(directory).split("\n")[0] ?? "null",
      ) as M3LHumanActionRecord;
      expect(persisted.detail["parameterNamesTruncated"]).toBe(
        WORST_CASE_SUPPLIED - record.parameterNames.length,
      );
      expect(persisted.detail["parameterRefsTruncated"]).toBe(
        WORST_CASE_SUPPLIED - record.parameterRefs.length,
      );
    });
  });
});

describe("M3LHumanActionOperator — pinned against the profile it claims to accept", () => {
  // `audit/` may not import `auth/` (the eslint zone), so
  // `M3LHumanActionOperator` is declared structurally and merely CLAIMS to be
  // "structurally identical to `M3LOperatorProfile` and satisfied by it".
  // Nothing enforced that, so a widening of `M3LOperatorProfile` would drift
  // silently. The zone rule constrains `src/audit/`, not `tests/`, so this is
  // exactly where the two shapes can be held together.
  //
  // The import is also what gives the re-exported type a knip consumer: the
  // vitest plugin makes `tests/**` entry points, which is why
  // `M3LHumanActionRecordInput`, `CreateHumanActionAuditStreamOptions` and
  // `resolveAuditStreamRoot` are all exported today with no `src/**` consumer
  // and `pnpm knip` is still green — the "tests are outside knip's project
  // glob" note in `record.ts` is false.
  test("M3LOperatorProfile satisfies M3LHumanActionOperator", () => {
    expectTypeOf<M3LOperatorProfile>().toExtend<M3LHumanActionOperator>();
  });

  test("declares the two fields the record reads, and no more", () => {
    expectTypeOf<M3LHumanActionOperator>().toEqualTypeOf<{
      readonly name: string;
      readonly email: string | undefined;
    }>();
  });
});

describe("M3LHumanActionOutcome — closed union", () => {
  test("is the exact five-member union the contract declares", () => {
    expectTypeOf<M3LHumanActionOutcome>().toEqualTypeOf<
      "allowed" | "denied" | "rejected" | "failed" | "served"
    >();
  });
});

describe("the truncation markers are a RESERVED, console-authored namespace", () => {
  // `projectDetail` writes a marker only when the drop count is `> 0` and
  // otherwise copies the caller's `detail` verbatim, so BOTH directions leak:
  // a caller-supplied `parameterNamesTruncated` on an untruncated record
  // survives (an audit trail lying about its own completeness), and a
  // caller-supplied value on a truncated one is silently arbitrated away by
  // the `Map` rather than refused. Both keys must be reserved.
  //
  // THE PINNED RULE: a caller-supplied marker is REFUSED, except where it can
  // only be this projection's own prior output — a list already sitting at
  // its count cap with nothing dropped this pass. That exception is not
  // optional: `stream.ts:86` re-projects every record `humanActionRecordFrom`
  // already projected, and the two "the dropped count survives onto the
  // segment" tests above require a genuine marker to survive that second
  // pass. The residual (a forger who also supplies a saturated list) cannot
  // be closed without a twelfth record field, which this slice forbids.
  const SUPPLIED = 512;

  /** A `parameters` object with `count` distinct keys. */
  function manyParameters(count: number): Record<string, number> {
    const parameters: Record<string, number> = {};
    for (let index = 0; index < count; index += 1) {
      parameters[`param-${String(index)}`] = 1;
    }
    return parameters;
  }

  test.each<[string, string]>([
    ["parameterNamesTruncated", "parameterNamesTruncated"],
    ["parameterRefsTruncated", "parameterRefsTruncated"],
  ])("refuses a caller-supplied %s when nothing was dropped", (_label, key) => {
    expectAuditRefusal(() =>
      buildRecord({
        parameters: { alpha: 1, beta: 2 },
        parameterRefs: [FILE_REF],
        detail: { [key]: 12 },
      }),
    );
  });

  test("refuses a caller-supplied names marker even when the count cap DID fire", () => {
    // Silent arbitration is the other half of the same defect: the caller's
    // entry disappears with no diagnostic, so a caller cannot tell a rejected
    // field from an accepted one.
    expectAuditRefusal(() =>
      buildRecord({
        parameters: manyParameters(SUPPLIED),
        detail: { parameterNamesTruncated: "CALLER-VALUE" },
      }),
    );
  });

  test("refuses a caller-supplied refs marker even when the count cap DID fire", () => {
    expectAuditRefusal(() =>
      buildRecord({
        parameterRefs: Array.from({ length: SUPPLIED }, () => FILE_REF),
        detail: { parameterRefsTruncated: 0 },
      }),
    );
  });

  test("a forged marker never reaches the segment", async () => {
    await withAuditPort(async (port, directory) => {
      const record = castRecord({
        detail: { parameterNamesTruncated: 999 },
      });

      await expect(port.record(record)).rejects.toBeInstanceOf(M3LConsoleError);

      expect(readSegmentBytes(directory)).toBe("");
    });
  });

  test("re-projecting a truncated record keeps its console-authored markers", () => {
    // REGRESSION LOCK, currently passing: this is what forbids an
    // unconditional refusal of the reserved keys, because `stream.ts:86`
    // projects a second time on the way to disk. After the refusal lands,
    // confirm this still discriminates by inverting it — dropping the
    // saturated-list exception must make it fail.
    const once = worstCaseEscapedRecord();

    const twice = projectHumanActionRecord(once);

    expect(twice.detail["parameterNamesTruncated"]).toBe(
      once.detail["parameterNamesTruncated"],
    );
    expect(twice.detail["parameterRefsTruncated"]).toBe(
      once.detail["parameterRefsTruncated"],
    );
  });
});

/**
 * A list whose own `slice` returns `returned` — something other than an
 * array. `poisonedSliceNames` above returns an ARRAY of objects, so it is
 * caught by the per-ENTRY check; this one has to be caught by the
 * `slice()`-result container check (`limits.ts:504-505`), because there are
 * no entries to walk and `read.length` on a string or an object would
 * silently project a truncated list (or an empty one) instead of refusing.
 */
function poisonedSliceReturning(returned: unknown): readonly string[] {
  return Object.defineProperty(["ok"], "slice", {
    value: () => returned,
    enumerable: false,
    writable: false,
    configurable: false,
  });
}

/** What a hostile `slice()` can return instead of an array. */
const NON_ARRAY_SLICE_RESULTS = [
  ["a string", "ok"],
  ["an object", { 0: "ok", length: 1 }],
  ["undefined", undefined],
  ["null", null],
  ["a number", 1],
] as const satisfies readonly (readonly [string, unknown])[];

describe("boundedList — a slice() returning a NON-array is refused, not walked", () => {
  // `Array.isArray(values)` proves the CONTAINER is an array; it proves
  // nothing about what that array's own `slice` hands back. A string result
  // has a `length` and numeric indices, so an unguarded walk would project
  // per-CHARACTER entries; an object with a forged `length` would do the same
  // for whatever it chose to expose; `undefined`/`null`/a number would throw
  // a raw `TypeError` no handler classifying on `M3LConsoleError` can render.
  // All five must land on `ERR_CONSOLE_AUDIT_RECORD_INVALID`, naming the
  // `slice()` location rather than an entry index — the offending value is
  // the slice RESULT, and an entry index would point at input that was never
  // read.
  test.each(NON_ARRAY_SLICE_RESULTS)(
    "refuses a parameterNames whose slice() returns %s",
    (_label, returned) => {
      const refusal = expectAuditRefusal(() =>
        projectHumanActionRecord(
          castRecord({ parameterNames: poisonedSliceReturning(returned) }),
        ),
      );

      expect(refusal.message).toContain("parameterNames slice()");
    },
  );

  test("refuses a parameterRefs whose slice() returns a non-array too", () => {
    const refusal = expectAuditRefusal(() =>
      projectHumanActionRecord(
        castRecord({ parameterRefs: poisonedSliceReturning("ok") }),
      ),
    );

    expect(refusal.message).toContain("parameterRefs slice()");
  });

  test("the refusal names the slice() result's typeof, never an entry index", () => {
    const refusal = expectAuditRefusal(() =>
      projectHumanActionRecord(
        castRecord({
          parameterNames: poisonedSliceReturning({ leaked: SECRET_VALUE }),
        }),
      ),
    );

    expect(refusal.message).toContain("parameterNames slice() is a object");
    expect(refusal.message).not.toContain("entry 0");
    expect(refusal.message).not.toContain(SECRET_VALUE);
  });
});
