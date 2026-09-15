// Tests for src/cli/envelopes.ts (V10c): parseJsonText and parseDoctorChecks,
// the CLI-output parser for `m3l doctor --json`.
//
// Contract source: docs authority is packages/m3l-cli/src/commands/doctor.ts
// (renderChecks emits `JSON.stringify(checks)` — a bare array, no wrapper
// object — of M3LCliDoctorCheck rows: { name: string, status: "ok"|"warn"|
// "fail", detail: string }). Confirmed to match this slice's contract
// verbatim; see the report accompanying this file for the confirmation.
//
// The whole point of the closed EnvelopeParseFailure union is that a parse
// failure never echoes the offending input back to a caller (raw CLI stdout
// may carry caller data, and this parser's output can reach a model
// verbatim in a later slice). Every failing-path test below asserts the
// returned reason is one of the fixed literal strings and does not contain
// a distinctive sentinel planted in the input.
import { describe, expect, expectTypeOf, test } from "vitest";

import {
  type EnvelopeParseFailure,
  type M3LMcpDoctorCheck,
  parseDoctorChecks,
  parseJsonText,
  type ParseResult,
} from "../src/cli/envelopes.js";

/** Planted in inputs that must fail parsing, to prove it never reaches a reason. */
const SENTINEL = "CALLER-DATA-9f2a";

describe("parseJsonText", () => {
  test("returns ok:true with the parsed value for valid JSON", () => {
    const result = parseJsonText('{"a":1}');

    expect(result).toEqual({ ok: true, value: { a: 1 } });
  });

  test("returns ok:true with an empty array for '[]'", () => {
    const result = parseJsonText("[]");

    expect(result).toEqual({ ok: true, value: [] });
  });

  test("returns reason 'not-json' for non-JSON text, and never echoes the input", () => {
    const result = parseJsonText(`{ not valid json ${SENTINEL}`);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("not-json");
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });

  test("returns reason 'not-json' for empty text", () => {
    const result = parseJsonText("");

    expect(result).toEqual({ ok: false, reason: "not-json" });
  });
});

describe("parseDoctorChecks", () => {
  test("parses multiple valid rows and freezes the returned array", () => {
    const input = [
      { name: "node-version", status: "ok", detail: "v24.0.0" },
      { name: "workspace-root", status: "warn", detail: "not found" },
      { name: "reserved-names", status: "fail", detail: "collision" },
    ];

    const result = parseDoctorChecks(input);

    expect(result).toEqual({ ok: true, value: input });
    if (!result.ok) throw new Error("unreachable");
    expect(Object.isFrozen(result.value)).toBe(true);
  });

  test("an empty array succeeds, it is not treated as a failure", () => {
    const result = parseDoctorChecks([]);

    expect(result).toEqual({ ok: true, value: [] });
    if (!result.ok) throw new Error("unreachable");
    expect(Object.isFrozen(result.value)).toBe(true);
  });

  test("returns reason 'not-an-array' for a JSON object rather than an array", () => {
    const result = parseDoctorChecks({ name: "a", status: "ok", detail: "d" });

    expect(result).toEqual({ ok: false, reason: "not-an-array" });
  });

  test("returns reason 'not-an-array' for a bare string", () => {
    const result = parseDoctorChecks("not an array");

    expect(result).toEqual({ ok: false, reason: "not-an-array" });
  });

  test("returns reason 'row-not-an-object' when a row is a string", () => {
    const result = parseDoctorChecks(["a-string-row"]);

    expect(result).toEqual({ ok: false, reason: "row-not-an-object" });
  });

  test.each([
    ["name", { status: "ok", detail: "d" }],
    ["status", { name: "a", detail: "d" }],
    ["detail", { name: "a", status: "ok" }],
  ] as const)(
    "returns reason 'missing-field' when '%s' is absent",
    (_key, row) => {
      const result = parseDoctorChecks([row]);

      expect(result).toEqual({ ok: false, reason: "missing-field" });
    },
  );

  test.each([
    ["name", { name: 42, status: "ok", detail: "d" }],
    ["status", { name: "a", status: 42, detail: "d" }],
    ["detail", { name: "a", status: "ok", detail: 42 }],
  ] as const)(
    "returns reason 'field-not-a-string' when '%s' has the wrong type",
    (_key, row) => {
      const result = parseDoctorChecks([row]);

      expect(result).toEqual({ ok: false, reason: "field-not-a-string" });
    },
  );

  test("returns reason 'unknown-status' for a status outside ok/warn/fail, never coerced to 'fail'", () => {
    const result = parseDoctorChecks([
      { name: "a", status: "pending", detail: "d" },
    ]);

    expect(result).toEqual({ ok: false, reason: "unknown-status" });
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).not.toBe("fail");
  });

  test("a failure never echoes a sentinel planted in the offending field", () => {
    const result = parseDoctorChecks([
      { name: SENTINEL, status: "not-a-real-status", detail: "d" },
    ]);

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });

  test("a failure never echoes a sentinel planted as a whole row's content", () => {
    const result = parseDoctorChecks([SENTINEL]);

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });

  test("rejects a row whose own prototype was replaced via object-literal __proto__ (isPlainObject catches it, unlike a bare typeof check)", () => {
    const polluted = { polluted: true };
    // Literal `__proto__: polluted` syntax sets the object's prototype to
    // `polluted` rather than creating an own property named "__proto__" —
    // Object.getPrototypeOf(row) is `polluted`, not Object.prototype, so
    // Core.isPlainObject must reject it.
    const row: unknown = Object.assign(Object.create(polluted), {
      name: "a",
      status: "ok",
      detail: "d",
    });
    expect(Object.getPrototypeOf(row)).toBe(polluted);

    const result = parseDoctorChecks([row]);

    expect(result).toEqual({ ok: false, reason: "row-not-an-object" });
  });

  test("a row built via JSON.parse with an own '__proto__' key parses cleanly, and pollution never reaches the output", () => {
    // Unlike object-literal syntax, JSON.parse creates "__proto__" as a
    // plain OWN data property (CreateDataProperty semantics) — the row's
    // actual prototype stays Object.prototype, so it is a normal valid row
    // as far as isPlainObject and the three read fields are concerned.
    const row: unknown = JSON.parse(
      '{"__proto__":{"polluted":true},"name":"a","status":"ok","detail":"d"}',
    );
    expect(Object.getPrototypeOf(row)).toBe(Object.prototype);

    const result = parseDoctorChecks([row]);

    expect(result).toEqual({
      ok: true,
      value: [{ name: "a", status: "ok", detail: "d" }],
    });
    if (!result.ok) throw new Error("unreachable");
    const [parsedRow] = result.value;
    expect(parsedRow).toBeDefined();
    expect(Object.hasOwn(parsedRow as object, "polluted")).toBe(false);
    expect(Object.hasOwn(parsedRow as object, "__proto__")).toBe(false);
    expect(Object.getPrototypeOf(parsedRow)).toBe(Object.prototype);
  });
});

describe("ParseResult (type level)", () => {
  test("is a discriminated union on 'ok', never a wider shape", () => {
    expectTypeOf<ParseResult<number>>().toEqualTypeOf<
      | { readonly ok: true; readonly value: number }
      | { readonly ok: false; readonly reason: EnvelopeParseFailure }
    >();
  });

  test("EnvelopeParseFailure is the exact closed set this slice documents", () => {
    expectTypeOf<EnvelopeParseFailure>().toEqualTypeOf<
      | "not-json"
      | "not-an-array"
      | "row-not-an-object"
      | "missing-field"
      | "field-not-a-string"
      | "unknown-status"
    >();
  });

  test("M3LMcpDoctorCheck matches the producer's row shape", () => {
    expectTypeOf<M3LMcpDoctorCheck>().toEqualTypeOf<{
      readonly name: string;
      readonly status: "ok" | "warn" | "fail";
      readonly detail: string;
    }>();
  });
});
