/**
 * Tests for core/orchestration submodule — the GRAMMAR and BINDING half:
 * `parseStepReference`/`formatStepReference` over valid input (emission,
 * canonicalization, round-tripping), `resolveStepReference`'s happy,
 * absent-but-well-formed and impossible-walk paths, `validateBindingValue`,
 * and the type-level contracts. Some `describe` blocks document fail-open
 * defects found during the U10 security review (2026-09-01) and since fixed
 * in `src/core/orchestration/{binding,step-reference,shape}.ts` — each
 * block's BEFORE/AFTER comment records what the defect was and why the test
 * exists, even though the defect no longer reproduces against the shipped
 * module. Every test in this file passes GREEN.
 *
 * The HOSTILE-INPUT half lives in the sibling
 * `packages/m3l-common/tests/orchestration-security.test.ts`: the
 * `isDangerousKey` prototype-pollution screens at parse, walk and format
 * time; the `valueOf`/`toString`-divergent index and array-prototype leak
 * blocks; the throwing-getter/Proxy-trap blocks; the typed-error narrowing
 * for a non-reference argument or a malformed `segments[]` element; and the
 * validated-snapshot (TOCTOU) discipline in `shape.ts`. It was split out
 * because the combined suite crossed `pnpm check:file-budget`'s 60,000-byte
 * per-test-file ceiling (ADR-0072), and because that surface is cohesive in
 * its own right — every block there drives a value the public types forbid.
 * Neither file is a subset of the other; assertions about hostile input
 * belong there, not here.
 *
 * Contract source: docs/plans/2026-09-01-orchestration-engine.md § "Slice 2
 * — the promoted surface", plus the behavioral source of truth this module
 * is promoted from —
 * `packages/m3l-console-server/src/sessions/reference.ts` and
 * `packages/m3l-console-server/src/sessions/binding.ts` (ADR-0068). Both
 * files together are a port of those two modules' test suites
 * (`sessions-reference.test.ts`, `sessions-binding.test.ts`), retargeted at
 * the promoted surface.
 *
 * Exports under test here: `M3LStepReference`, `parseStepReference`,
 *   `formatStepReference`, `resolveStepReference`, `M3LStepReferenceError`,
 *   `M3LBindingExpectedType`, `M3LStepBinding`, `validateBindingValue` —
 *   plus `M3LStepReferenceSegment`'s discriminated shape, pinned
 *   structurally through `M3LStepReference.segments` rather than by naming
 *   the type.
 *
 * The ONE behavioral change from the console originals: the console throws
 * `M3LConsoleError` with code `ERR_CONSOLE_SESSION_REFERENCE_INVALID`
 * (a console-specific class that cannot live in m3l-common); the promoted
 * surface throws `M3LStepReferenceError` (an `M3LError` subclass) with the
 * library-owned code `ERR_STEP_REFERENCE_INVALID`. Every message, every
 * accepted/rejected input, the ordinal base, and the segment kinds are
 * otherwise unchanged. `M3LSessionBinding` is also renamed `M3LStepBinding`
 * on the way in ("session" is a console concept).
 *
 * `parseStepReference`/`formatStepReference` are exact inverses in the
 * `parse(format(x))` direction — formatting a parsed reference and parsing
 * it again always reproduces the original parsed value, byte-identical
 * text or not. The `format(parse(text))` direction is canonicalizing rather
 * than byte-identical: text using a bracket-quoted but identifier-safe key
 * (e.g. `["messages"]`) reformats to the equivalent dotted form
 * (`.messages`), while a non-identifier-safe key (e.g. `["total count"]`)
 * has no dotted equivalent and so does round-trip byte-identically. See the
 * canonicalization `describe` blocks below for both properties pinned
 * explicitly.
 */
import { describe, expect, expectTypeOf, test } from "vitest";

import { M3LError } from "../src/core/errors/index.js";
import {
  formatStepReference,
  M3LStepReferenceError,
  parseStepReference,
  resolveStepReference,
  validateBindingValue,
} from "../src/core/orchestration/index.js";
import type {
  M3LBindingExpectedType,
  M3LStepBinding,
  M3LStepReference,
} from "../src/core/orchestration/index.js";

/** A binding-shape pick, ignoring `reference` (not consumed by `validateBindingValue`). */
type BindingShape = Pick<M3LStepBinding, "expectedType" | "multiSelect">;

/** Asserts that `fn` throws an `M3LStepReferenceError` with the reference-invalid code. */
function expectReferenceInvalid(fn: () => unknown): void {
  expect(fn).toThrow(M3LStepReferenceError);
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(M3LStepReferenceError);
  expect((thrown as M3LStepReferenceError).code).toBe(
    "ERR_STEP_REFERENCE_INVALID",
  );
}

describe("parseStepReference — valid grammar", () => {
  test("parses a bare step-output reference with no path", () => {
    const reference = parseStepReference("step-3.output");

    expect(reference.ordinal).toBe(3);
    expect(reference.segments).toEqual([]);
  });

  test("parses a single dotted property segment", () => {
    const reference = parseStepReference("step-3.output.messages");

    expect(reference.ordinal).toBe(3);
    expect(reference.segments).toEqual([
      { kind: "property", name: "messages" },
    ]);
  });

  test("parses a dotted property followed by a numeric index", () => {
    const reference = parseStepReference("step-1.output.Queues[0]");

    expect(reference.ordinal).toBe(1);
    expect(reference.segments).toEqual([
      { kind: "property", name: "Queues" },
      { kind: "index", index: 0 },
    ]);
  });

  test("parses a bracket-quoted property containing a colon", () => {
    const reference = parseStepReference(
      'step-2.output.tags["aws:cloudformation:stack"]',
    );

    expect(reference.ordinal).toBe(2);
    expect(reference.segments).toEqual([
      { kind: "property", name: "tags" },
      { kind: "property", name: "aws:cloudformation:stack" },
    ]);
  });

  test("parses a mix of property, index, and property segments", () => {
    const reference = parseStepReference("step-3.output.messages[7].userId");

    expect(reference.ordinal).toBe(3);
    expect(reference.segments).toEqual([
      { kind: "property", name: "messages" },
      { kind: "index", index: 7 },
      { kind: "property", name: "userId" },
    ]);
  });

  test("accepts a large multi-digit ordinal with no leading zero", () => {
    const reference = parseStepReference("step-123.output");

    expect(reference.ordinal).toBe(123);
  });

  test("parses an escaped double-quote inside a bracket-quoted segment", () => {
    // Source text: step-1.output["has\"quote"] — the backslash-quote pair is
    // a literal escape sequence in the source, decoding to a single `"`
    // inside the property name.
    const reference = parseStepReference('step-1.output["has\\"quote"]');

    expect(reference.segments).toEqual([
      { kind: "property", name: 'has"quote' },
    ]);
  });

  test("accepts a literal single-digit zero index (not a leading-zero violation)", () => {
    const reference = parseStepReference("step-1.output[0]");

    expect(reference.segments).toEqual([{ kind: "index", index: 0 }]);
  });
});

describe("parseStepReference — rejected input", () => {
  test("throws for ordinal 0 (must be >= 1)", () => {
    expectReferenceInvalid(() => parseStepReference("step-0.output"));
  });

  test("throws for a leading-zero ordinal", () => {
    expectReferenceInvalid(() => parseStepReference("step-01.output"));
  });

  test("throws for a leading-zero index segment, mirroring the ordinal's leading-zero rule", () => {
    expectReferenceInvalid(() => parseStepReference("step-1.output[007]"));
  });

  test("throws for an empty segment (double dot)", () => {
    expectReferenceInvalid(() => parseStepReference("step-3.output..foo"));
  });

  test("throws for an unterminated bracket", () => {
    expectReferenceInvalid(() => parseStepReference("step-3.output.messages["));
  });

  test("throws for an unterminated quoted segment", () => {
    expectReferenceInvalid(() =>
      parseStepReference('step-3.output.messages["unterminated'),
    );
  });

  test("throws for an ident segment starting with a digit", () => {
    expectReferenceInvalid(() => parseStepReference("step-3.output.9abc"));
  });

  test("throws for a bare step reference with no .output", () => {
    expectReferenceInvalid(() => parseStepReference("step-3"));
  });

  test("throws for trailing garbage after a valid parse", () => {
    expectReferenceInvalid(() => parseStepReference("step-3.output.foo bar"));
  });

  test("throws for a completely empty string", () => {
    expectReferenceInvalid(() => parseStepReference(""));
  });

  test("throws for an invalid escape sequence inside a bracket-quoted segment", () => {
    expectReferenceInvalid(() =>
      parseStepReference('step-1.output["bad\\nescape"]'),
    );
  });

  test("throws for a bracket-quoted segment missing its closing bracket", () => {
    expectReferenceInvalid(() => parseStepReference('step-1.output["ok"'));
  });

  test("throws for a step prefix with no ordinal digits at all", () => {
    expectReferenceInvalid(() => parseStepReference("step-.output"));
  });

  test("throws for an index segment whose digits are present but whose closing bracket is missing", () => {
    // Distinct from "step-1.output[" (no digits at all, rejected as
    // "expected a numeric index inside [...]"): here the digits parse fine
    // and the cursor runs out where "]" must be.
    expectReferenceInvalid(() => parseStepReference("step-1.output[0"));
  });

  test("throws for a quoted segment that ends on a dangling backslash, with no character left to escape", () => {
    // The text is: step-1.output["a\  — the escape handler peeks past the
    // backslash and finds end-of-input, distinct from the unterminated-quote
    // case above where a real character follows.
    expectReferenceInvalid(() => parseStepReference('step-1.output["a\\'));
  });

  test("never returns a partial/best-effort result — throws rather than truncating at the failure point", () => {
    // "step-3.output.foo bar" has a fully valid prefix ("step-3.output.foo")
    // — a best-effort parser might silently return that prefix. Assert it
    // throws instead, which the block above already covers; this test names
    // the guarantee explicitly so a future refactor cannot regress it.
    expect(() => parseStepReference("step-3.output.foo bar")).toThrow();
  });
});

describe("formatStepReference / parseStepReference — round trip", () => {
  test.each<[string]>([
    ["step-3.output"],
    ["step-3.output.messages"],
    ["step-1.output.Queues[0]"],
    ['step-2.output.tags["aws:cloudformation:stack"]'],
    ["step-3.output.messages[7].userId"],
    ["step-9.output.a.b.c"],
    ["step-1.output[0]"],
  ])(
    "formatStepReference(parseStepReference(%s)) round-trips to the exact original text",
    (text) => {
      const reference = parseStepReference(text);

      expect(formatStepReference(reference)).toBe(text);
    },
  );

  test.each<[M3LStepReference]>([
    [{ ordinal: 3, segments: [] }],
    [{ ordinal: 1, segments: [{ kind: "property", name: "messages" }] }],
    [
      {
        ordinal: 2,
        segments: [
          { kind: "property", name: "Queues" },
          { kind: "index", index: 0 },
        ],
      },
    ],
    [
      {
        ordinal: 4,
        segments: [{ kind: "property", name: "aws:cloudformation:stack" }],
      },
    ],
  ])(
    "parseStepReference(formatStepReference(%o)) round-trips to a deep-equal value",
    (reference) => {
      const formatted = formatStepReference(reference);

      expect(parseStepReference(formatted)).toEqual(reference);
    },
  );

  test("round-trips a property name containing a literal double-quote character", () => {
    const reference: M3LStepReference = {
      ordinal: 5,
      segments: [{ kind: "property", name: 'has"quote' }],
    };

    expect(parseStepReference(formatStepReference(reference))).toEqual(
      reference,
    );
  });
});

describe("parseStepReference — integer-safety ceiling on ordinal/index digit runs (defensive limit: no digit run longer than 15 digits)", () => {
  test("throws for an ordinal digit run longer than 15 digits instead of producing Infinity", () => {
    const hugeOrdinal = "1".repeat(320);

    expectReferenceInvalid(() =>
      parseStepReference(`step-${hugeOrdinal}.output`),
    );
  });

  test("throws for an index digit run longer than 15 digits instead of producing Infinity", () => {
    const hugeIndex = "1".repeat(320);

    expectReferenceInvalid(() =>
      parseStepReference(`step-1.output.items[${hugeIndex}]`),
    );
  });
});

describe("formatStepReference — canonicalization: bracket-quoted only when required", () => {
  test("a plain identifier-safe key formats as dotted, not bracket-quoted", () => {
    const reference: M3LStepReference = {
      ordinal: 1,
      segments: [{ kind: "property", name: "messages" }],
    };

    const formatted = formatStepReference(reference);

    expect(formatted).toBe("step-1.output.messages");
    expect(formatted).not.toContain("[");
  });

  test("a key containing a colon (not ident-safe) formats as bracket-quoted", () => {
    const reference: M3LStepReference = {
      ordinal: 2,
      segments: [{ kind: "property", name: "aws:cloudformation:stack" }],
    };

    const formatted = formatStepReference(reference);

    expect(formatted).toBe('step-2.output["aws:cloudformation:stack"]');
  });

  test("a key starting with a digit (not ident-safe) formats as bracket-quoted", () => {
    const reference: M3LStepReference = {
      ordinal: 5,
      segments: [{ kind: "property", name: "9lives" }],
    };

    const formatted = formatStepReference(reference);

    expect(formatted).toBe('step-5.output["9lives"]');
  });

  test("an index segment always formats as a bracketed integer", () => {
    const reference: M3LStepReference = {
      ordinal: 1,
      segments: [{ kind: "index", index: 42 }],
    };

    expect(formatStepReference(reference)).toBe("step-1.output[42]");
  });
});

describe("formatStepReference — rejects a malformed M3LStepReference before building any output", () => {
  test.each<[string, M3LStepReference]>([
    ["ordinal 0 (not a positive integer)", { ordinal: 0, segments: [] }],
    ["ordinal -1 (not a positive integer)", { ordinal: -1, segments: [] }],
    ["ordinal 1.5 (not an integer)", { ordinal: 1.5, segments: [] }],
    [
      "an index segment with index -1 (not non-negative)",
      {
        ordinal: 1,
        segments: [{ kind: "index", index: -1 }],
      },
    ],
    [
      "an index segment with index 1.5 (not an integer)",
      {
        ordinal: 1,
        segments: [{ kind: "index", index: 1.5 }],
      },
    ],
  ])("throws ERR_STEP_REFERENCE_INVALID for %s", (_description, reference) => {
    expectReferenceInvalid(() => formatStepReference(reference));
  });
});

describe("resolveStepReference — happy paths", () => {
  test("walks a plain nested object", () => {
    const reference = parseStepReference("step-1.output.userId");
    const source = { userId: "abc-123" };

    expect(resolveStepReference(reference, source)).toBe("abc-123");
  });

  test("walks an array index", () => {
    const reference = parseStepReference("step-1.output.Queues[0]");
    const source = { Queues: ["queue-a", "queue-b"] };

    expect(resolveStepReference(reference, source)).toBe("queue-a");
  });

  test("walks a bracket-quoted key containing special characters", () => {
    const reference = parseStepReference(
      'step-1.output.tags["aws:cloudformation:stack"]',
    );
    const source = { tags: { "aws:cloudformation:stack": "my-stack" } };

    expect(resolveStepReference(reference, source)).toBe("my-stack");
  });

  test("walks a mix of property/index/property segments", () => {
    const reference = parseStepReference("step-1.output.messages[1].userId");
    const source = {
      messages: [{ userId: "first" }, { userId: "second" }],
    };

    expect(resolveStepReference(reference, source)).toBe("second");
  });

  test("resolves the bare step-output reference to the whole source value", () => {
    const reference = parseStepReference("step-1.output");
    const source = { anything: true };

    expect(resolveStepReference(reference, source)).toBe(source);
  });
});

describe("resolveStepReference — absent-but-well-formed path", () => {
  test("returns undefined when a property segment is absent from an otherwise well-formed object", () => {
    const reference = parseStepReference("step-1.output.missing");
    const source = { present: "value" };

    expect(resolveStepReference(reference, source)).toBeUndefined();
  });

  test("returns undefined when an array index is out of bounds", () => {
    const reference = parseStepReference("step-1.output.items[5]");
    const source = { items: ["only-one"] };

    expect(resolveStepReference(reference, source)).toBeUndefined();
  });
});

describe("resolveStepReference — impossible walk (data/reference mismatch)", () => {
  test("throws when a mid-path segment resolves to a non-object/non-array value (property read on a non-object)", () => {
    const reference = parseStepReference("step-1.output.foo.bar");
    const source = { foo: 42 };

    expect(() => resolveStepReference(reference, source)).toThrow(
      M3LStepReferenceError,
    );
    expectReferenceInvalid(() => resolveStepReference(reference, source));
  });

  test("throws when indexing into a non-array value", () => {
    const reference = parseStepReference("step-1.output.foo[0]");
    const source = { foo: "not-an-array" };

    expectReferenceInvalid(() => resolveStepReference(reference, source));
  });
});

describe("M3LStepReferenceError — pinned code and M3LError lineage", () => {
  test("is an M3LError subclass whose code is pinned to ERR_STEP_REFERENCE_INVALID", () => {
    const error = new M3LStepReferenceError("malformed step reference");

    expect(error).toBeInstanceOf(M3LError);
    expect(error.code).toBe("ERR_STEP_REFERENCE_INVALID");
  });

  test("code narrows to the literal ERR_STEP_REFERENCE_INVALID at the type level", () => {
    expectTypeOf<
      M3LStepReferenceError["code"]
    >().toEqualTypeOf<"ERR_STEP_REFERENCE_INVALID">();
  });

  test("is assignable to M3LError at the type level", () => {
    expectTypeOf<M3LStepReferenceError>().toExtend<M3LError>();
  });
});

describe("M3LStepReference — discriminated segment shape", () => {
  test("a segment is either a property-name segment or an array-index segment, tagged by kind", () => {
    expectTypeOf<M3LStepReference>().toExtend<{
      readonly ordinal: number;
      readonly segments: readonly (
        | { readonly kind: "property"; readonly name: string }
        | { readonly kind: "index"; readonly index: number }
      )[];
    }>();
  });
});

describe("M3LBindingExpectedType — closed four-member vocabulary", () => {
  test("has exactly string | number | boolean | object, no array member", () => {
    // `toEqualTypeOf` is an exact-equality check, so this single assertion
    // already rules out an "array" member (or any other extra/missing
    // member) without needing a separate negative-literal test — a
    // `// @ts-expect-error`-based negative test would be a RED-state-only
    // false defect here: while `M3LBindingExpectedType` does not yet exist,
    // the import falls back to `any`, so a literal assignment never
    // actually errors and the directive would report itself unused.
    expectTypeOf<M3LBindingExpectedType>().toEqualTypeOf<
      "string" | "number" | "boolean" | "object"
    >();
  });
});

describe("M3LStepBinding — domain shape (renamed from the console's M3LSessionBinding)", () => {
  test("reference is the parsed M3LStepReference, not a raw string", () => {
    expectTypeOf<M3LStepBinding>().toExtend<{
      readonly reference: M3LStepReference;
      readonly expectedType: M3LBindingExpectedType;
      readonly multiSelect: boolean;
    }>();
  });

  test("reference field type is exactly M3LStepReference", () => {
    expectTypeOf<
      M3LStepBinding["reference"]
    >().toEqualTypeOf<M3LStepReference>();
  });
});

describe("validateBindingValue — multiSelect: false, scalar/object shape checks", () => {
  test.each<[BindingShape, unknown, boolean]>([
    [{ expectedType: "string", multiSelect: false }, "hello", true],
    [{ expectedType: "string", multiSelect: false }, 42, false],
    [{ expectedType: "number", multiSelect: false }, 42, true],
    [{ expectedType: "number", multiSelect: false }, "42", false],
    [{ expectedType: "boolean", multiSelect: false }, true, true],
    [{ expectedType: "boolean", multiSelect: false }, "true", false],
    [{ expectedType: "object", multiSelect: false }, { a: 1 }, true],
    [{ expectedType: "object", multiSelect: false }, null, false],
    [{ expectedType: "object", multiSelect: false }, [1, 2, 3], false],
    [{ expectedType: "object", multiSelect: false }, "not-an-object", false],
  ])(
    "validateBindingValue(%o scalar, %j) returns %s",
    (binding, value, expected) => {
      expect(validateBindingValue(value, binding)).toBe(expected);
    },
  );
});

describe("validateBindingValue — multiSelect: true, array-of-shape checks", () => {
  test.each<[BindingShape, unknown, boolean]>([
    [{ expectedType: "string", multiSelect: true }, ["a", "b"], true],
    [{ expectedType: "string", multiSelect: true }, ["a", 1], false],
    [{ expectedType: "string", multiSelect: true }, "not-an-array", false],
    [{ expectedType: "number", multiSelect: true }, [1, 2, 3], true],
    [{ expectedType: "number", multiSelect: true }, [1, "2"], false],
    [{ expectedType: "boolean", multiSelect: true }, [true, false], true],
    [{ expectedType: "boolean", multiSelect: true }, [true, 1], false],
    [{ expectedType: "object", multiSelect: true }, [{ a: 1 }, { b: 2 }], true],
    [{ expectedType: "object", multiSelect: true }, [{ a: 1 }, null], false],
    [{ expectedType: "object", multiSelect: true }, [{ a: 1 }, [1]], false],
  ])(
    "validateBindingValue(%o array, %j) returns %s",
    (binding, value, expected) => {
      expect(validateBindingValue(value, binding)).toBe(expected);
    },
  );

  test("an empty array satisfies multiSelect for every expectedType (vacuously true)", () => {
    expect(
      validateBindingValue([], { expectedType: "string", multiSelect: true }),
    ).toBe(true);
    expect(
      validateBindingValue([], { expectedType: "object", multiSelect: true }),
    ).toBe(true);
  });
});

describe("validateBindingValue — expectedType outside the compile-time union", () => {
  test("exercises the exhaustiveness-check default branch, unreachable through the typed public API — coverage only", () => {
    const offUnionExpectedType =
      "unknown-type" as unknown as M3LBindingExpectedType;

    expect(() =>
      validateBindingValue("anything", {
        expectedType: offUnionExpectedType,
        multiSelect: false,
      }),
    ).not.toThrow();

    // Fail-closed, not fail-open: an off-union expectedType (e.g.
    // deserialized from a stored flow/session definition) must never be
    // treated as truthy just because the `never`-typed default branch
    // happens to return its raw string argument at runtime.
    const result = validateBindingValue("anything", {
      expectedType: offUnionExpectedType,
      multiSelect: false,
    });

    expect(result).toBe(false);
    expect(typeof result).toBe("boolean");
  });
});

describe("validateBindingValue — never throws", () => {
  test.each<[unknown]>([
    [undefined],
    [null],
    [Symbol("weird")],
    [() => undefined],
  ])("returns a boolean, never throws, for the unusual value %o", (value) => {
    expect(() =>
      validateBindingValue(value, {
        expectedType: "string",
        multiSelect: false,
      }),
    ).not.toThrow();
    expect(
      typeof validateBindingValue(value, {
        expectedType: "string",
        multiSelect: false,
      }),
    ).toBe("boolean");
  });
});

/**
 * DEFECT 1 — `validateBindingValue` must fail CLOSED (return exactly
 * `false`) for an `expectedType` outside the closed compile-time union,
 * not fail open by returning the raw off-union string. A binding is
 * deserialized from a stored flow/session definition, so a JS caller or a
 * malformed JSON blob can hand in a vocabulary member TypeScript never
 * sees; the `default:` branch's `const exhaustive: never = expectedType;
 * return exhaustive;` typechecks (`never` is assignable to `boolean`) but
 * at runtime returns the untouched string, which is truthy for every
 * non-empty value and — worse — `""` is falsy only by accident, not by
 * design. `toBe(false)` (never `toBeFalsy()`) is required here specifically
 * because a `toBeFalsy()` assertion cannot distinguish the fail-open bug
 * (returns the input string, e.g. `"bogus-type"`, which IS truthy) from a
 * correct fail-closed `false` — and would also pass on the accidental `""`
 * case, hiding the defect on every other off-union value.
 */
describe("validateBindingValue — off-union expectedType fails CLOSED (returns exactly false, not the raw string)", () => {
  test.each<[string, unknown]>([
    ["a bogus string", "bogus-type"],
    ["an empty string", ""],
    ["null", null],
    ["undefined", undefined],
    ["a number", 42],
    ["an object", { weird: true }],
  ])(
    "multiSelect: false — returns exactly false, never the off-union value itself, for expectedType %s",
    (_label, offUnionExpectedType) => {
      const binding: BindingShape = {
        expectedType: offUnionExpectedType as M3LBindingExpectedType,
        multiSelect: false,
      };

      const result = validateBindingValue("anything", binding);

      expect(result).toBe(false);
      expect(typeof result).toBe("boolean");
    },
  );

  test.each<[string, unknown]>([
    ["a bogus string", "bogus-type"],
    ["an empty string", ""],
    ["null", null],
    ["undefined", undefined],
    ["a number", 42],
    ["an object", { weird: true }],
  ])(
    "multiSelect: true — the per-element map also fails closed (returns exactly false) for expectedType %s",
    (_label, offUnionExpectedType) => {
      const binding: BindingShape = {
        expectedType: offUnionExpectedType as M3LBindingExpectedType,
        multiSelect: true,
      };

      // A non-empty array so the per-element predicate actually runs —
      // an empty array would pass vacuously regardless of this defect.
      const result = validateBindingValue(["a", "b"], binding);

      expect(result).toBe(false);
      expect(typeof result).toBe("boolean");
    },
  );
});

/** Every reference text `parseStepReference` accepts, reused below for the format/parse round-trip property assertion. */
const VALID_REFERENCE_TEXTS: readonly string[] = [
  "step-3.output",
  "step-3.output.messages",
  "step-1.output.Queues[0]",
  'step-2.output.tags["aws:cloudformation:stack"]',
  "step-3.output.messages[7].userId",
  "step-9.output.a.b.c",
  "step-1.output[0]",
  'step-1.output[""]',
  // Bracket-quoted but identifier-safe — the canonicalizing case Task 2
  // closes: `format(parse(text))` produces `.messages`, not this text back,
  // yet `parse(format(parse(text)))` still deep-equals `parse(text)` (the
  // property this describe block actually pins).
  'step-1.output["messages"]',
];

describe("formatStepReference / parseStepReference — property round trip holds in both directions", () => {
  test.each<[string]>(VALID_REFERENCE_TEXTS.map((text) => [text]))(
    "parseStepReference(formatStepReference(parseStepReference(%s))) equals parseStepReference(%s)",
    (text) => {
      const original = parseStepReference(text);

      expect(
        parseStepReference(formatStepReference(parseStepReference(text))),
      ).toEqual(original);
    },
  );

  test("does not over-tighten: a property segment with an empty name still formats to the bracket-quoted empty-string form and round-trips", () => {
    const reference: M3LStepReference = {
      ordinal: 1,
      segments: [{ kind: "property", name: "" }],
    };

    const formatted = formatStepReference(reference);

    expect(formatted).toBe('step-1.output[""]');
    expect(parseStepReference(formatted)).toEqual(reference);
  });
});

/**
 * The `parse(format(x))` round trip (above) is STABLE — semantically
 * idempotent — but `format(parse(text))` is CANONICALIZING, not
 * byte-identical: a bracket-quoted key that would also re-parse as a
 * dotted identifier is reformatted to the dotted form. This describe pins
 * both halves of that claim explicitly, so the "byte-identical for every
 * valid input" overclaim this file's docblock used to make cannot silently
 * return.
 */
describe("formatStepReference — text→format canonicalizes a bracket-quoted but identifier-safe key (not byte-identical, but stable once canonical)", () => {
  test("a bracket-quoted identifier-safe key canonicalizes to the dotted form on format, rather than round-tripping byte-identically", () => {
    const reference = parseStepReference('step-1.output["messages"]');

    expect(formatStepReference(reference)).toBe("step-1.output.messages");
  });

  test("canonicalizing a second time is stable: re-parsing and re-formatting the already-canonical text reproduces it exactly", () => {
    const onceCanonical = formatStepReference(
      parseStepReference('step-1.output["messages"]'),
    );

    expect(onceCanonical).toBe("step-1.output.messages");
    expect(formatStepReference(parseStepReference(onceCanonical))).toBe(
      onceCanonical,
    );
  });

  test("a bracket-quoted key that is NOT identifier-safe has no dotted equivalent, so it stays bracket-quoted and round-trips byte-identically", () => {
    const text = 'step-1.output["total count"]';

    expect(formatStepReference(parseStepReference(text))).toBe(text);
  });
});

/**
 * DEFECT 5 — sparse arrays fail open in `validateBindingValue`'s
 * `multiSelect: true` path (2026-09-01 security review).
 * `Array.prototype.every` skips holes entirely rather than visiting
 * `undefined` for them, so an array with N holes and zero real elements
 * vacuously satisfies every `expectedType` — a hole is not a real value of
 * any shape, and must fail closed like the dense all-`undefined`
 * equivalent already correctly does.
 */
describe("validateBindingValue — multiSelect: true fails closed on sparse arrays (Array.prototype.every skips holes)", () => {
  test("a 3-hole sparse array does not vacuously satisfy multiSelect: string", () => {
    const sparse: unknown[] = new Array(3);

    expect(
      validateBindingValue(sparse, {
        expectedType: "string",
        multiSelect: true,
      }),
    ).toBe(false);
  });

  test("contrast case (already correct, not itself the defect): the fully-dense all-undefined equivalent already fails", () => {
    const dense: unknown[] = [undefined, undefined, undefined];

    expect(
      validateBindingValue(dense, {
        expectedType: "string",
        multiSelect: true,
      }),
    ).toBe(false);
  });

  test("a hole created via delete on an otherwise-valid array does not vacuously satisfy multiSelect: number", () => {
    const withHole: unknown[] = [1, 2, 3];
    // `Reflect.deleteProperty` (rather than a `delete` expression, which
    // `@typescript-eslint/no-array-delete` flags as unsafe) removes index 1
    // entirely, leaving a genuine hole rather than an assigned `undefined`.
    Reflect.deleteProperty(withHole, 1);

    expect(
      validateBindingValue(withHole, {
        expectedType: "number",
        multiSelect: true,
      }),
    ).toBe(false);
  });

  test("a sparse array with leading/trailing holes around one real element does not vacuously satisfy multiSelect: string", () => {
    const sparseLeadingTrailing: unknown[] = new Array(3);
    sparseLeadingTrailing[1] = "x";

    expect(
      validateBindingValue(sparseLeadingTrailing, {
        expectedType: "string",
        multiSelect: true,
      }),
    ).toBe(false);
  });
});
