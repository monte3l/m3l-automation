/**
 * Tests for core/orchestration submodule. The module is implemented and
 * these tests pass GREEN; the additional `describe` blocks appended below
 * the original port are RED-by-design proofs of fail-open defects found
 * during the U10 security review (2026-09-01) — the defects live in
 * `src/core/orchestration/{binding,step-reference}.ts`, which this test
 * file does not modify.
 *
 * Contract source: docs/plans/2026-09-01-orchestration-engine.md § "Slice 2
 * — the promoted surface", plus the behavioral source of truth this module
 * is promoted from —
 * `packages/m3l-console-server/src/sessions/reference.ts` and
 * `packages/m3l-console-server/src/sessions/binding.ts` (ADR-0068). This
 * file is a port of those two modules' test suites
 * (`sessions-reference.test.ts`, `sessions-binding.test.ts`), retargeted at
 * the promoted surface.
 *
 * Exports under test: `M3LStepReference`, `M3LStepReferenceSegment`,
 *   `parseStepReference`, `formatStepReference`, `resolveStepReference`,
 *   `M3LStepReferenceError`, `M3LBindingExpectedType`, `M3LStepBinding`,
 *   `validateBindingValue`.
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
 * `parseStepReference`/`formatStepReference` must be exact inverses of each
 * other (byte-identical round-trip for every valid input), and
 * `resolveStepReference` must refuse the three prototype-pollution vector
 * names outright rather than silently walking them — this repo's standard
 * `isDangerousKey` guard applied to this promoted surface, screened at BOTH
 * parse time and walk time independently.
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
  M3LStepReferenceSegment,
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

describe("parseStepReference — rejects dangerous segment names at parse time (fail-closed, not only at resolve time)", () => {
  test.each<[string]>([["__proto__"], ["constructor"], ["prototype"]])(
    "throws for the dotted dangerous segment .%s",
    (dangerousName) => {
      expectReferenceInvalid(() =>
        parseStepReference(`step-1.output.${dangerousName}`),
      );
    },
  );

  test.each<[string]>([["__proto__"], ["constructor"], ["prototype"]])(
    'throws for the bracket-quoted dangerous segment ["%s"]',
    (dangerousName) => {
      expectReferenceInvalid(() =>
        parseStepReference(`step-1.output["${dangerousName}"]`),
      );
    },
  );
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

describe("resolveStepReference — forbidden prototype-pollution segments (walk-time, independent of parse-time)", () => {
  // These construct an `M3LStepReference` object literal directly rather
  // than going through `parseStepReference`, so they exercise the walk-time
  // guard (inside the resolver) independently of the parse-time guard.
  test.each<[string]>([["__proto__"], ["constructor"], ["prototype"]])(
    "throws rather than walking the forbidden property-name segment %s",
    (forbiddenName) => {
      const reference: M3LStepReference = {
        ordinal: 1,
        segments: [{ kind: "property", name: forbiddenName }],
      };
      const source = { safe: "value" };

      expectReferenceInvalid(() => resolveStepReference(reference, source));
    },
  );

  test("refuses a forbidden segment even when it appears mid-path, before reaching a well-formed remainder", () => {
    const reference: M3LStepReference = {
      ordinal: 1,
      segments: [
        { kind: "property", name: "__proto__" },
        { kind: "property", name: "polluted" },
      ],
    };
    const source = { safe: "value" };

    expectReferenceInvalid(() => resolveStepReference(reference, source));
  });

  // Regression lock-in for the module's own TSDoc claim ("checked... at
  // every segment, not just the first"): unlike the test above, the
  // forbidden segment here is NOT the first one — the walk passes through
  // two real, well-formed intermediate objects (`a`, then `b`) before
  // reaching `__proto__`. A guard that only checked segment index 0 would
  // let this walk through undetected.
  test("refuses a forbidden segment reached mid-path, after walking through real well-formed intermediate objects", () => {
    const reference: M3LStepReference = {
      ordinal: 1,
      segments: [
        { kind: "property", name: "a" },
        { kind: "property", name: "b" },
        { kind: "property", name: "__proto__" },
        { kind: "property", name: "c" },
      ],
    };
    const source = { a: { b: {} } };

    expectReferenceInvalid(() => resolveStepReference(reference, source));
  });
});

describe("resolveStepReference — array-prototype leak prevention for index segments", () => {
  // BEFORE (2026-09-01 security review): this describe's only test proved
  // prototype pollution is screened for a real numeric index into an empty
  // array — `segment.index < array.length` correctly gates that one case.
  // It never constructed an index whose `valueOf`/`toString` disagree, so
  // the describe's own title ("leak prevention for index segments",
  // general) was unproven for the actual leak vector: `resolveIndexSegment`
  // does a raw `array[segment.index]`, and property-key coercion
  // (`ToPropertyKey`) consults `toString()` — not `valueOf()` — when the
  // index is an object, not a `number`. An index object that reports `0` to
  // `valueOf` (passing the bounds check) but a dangerous name to
  // `toString` reaches `Array.prototype`/the `Array` constructor
  // undetected. AFTER: the test.each below proves that specific claim; it
  // is RED against the current `array[segment.index]` implementation,
  // which does not screen the index at all before using it as a property
  // key.
  test("never returns a value inherited from Array.prototype for an index that has no real element", () => {
    const pollutedPrototype = Array.prototype as unknown as Record<
      string,
      unknown
    >;
    pollutedPrototype[0] = "LEAKED";

    try {
      const reference = parseStepReference("step-1.output.items[0]");
      const source = { items: [] as unknown[] };

      expect(resolveStepReference(reference, source)).toBeUndefined();
    } finally {
      delete pollutedPrototype[0];
    }
  });

  test.each<[string, unknown]>([
    [
      "toString diverges from valueOf to name the Array constructor",
      { valueOf: () => 0, toString: () => "constructor" },
    ],
    [
      "toString diverges from valueOf to name an inherited Array.prototype method",
      { valueOf: () => 0, toString: () => "at" },
    ],
  ])(
    "throws rather than resolving to an Array.prototype/constructor member when an index segment's %s",
    (_label, coercingIndex) => {
      const reference: M3LStepReference = {
        ordinal: 1,
        segments: [
          {
            kind: "index",
            index: coercingIndex as number,
          },
        ],
      };
      const source = ["a"];

      expectReferenceInvalid(() => resolveStepReference(reference, source));
    },
  );
});

describe("resolveStepReference — hostile (throwing) getters surface as a typed M3LStepReferenceError", () => {
  test("wraps a throwing property getter as M3LStepReferenceError with the reference-invalid code, not the raw thrown value", () => {
    const source: Record<string, unknown> = {};
    Object.defineProperty(source, "x", {
      get(): never {
        throw new Error("boom");
      },
      enumerable: true,
      configurable: true,
    });
    const reference = parseStepReference("step-1.output.x");

    expectReferenceInvalid(() => resolveStepReference(reference, source));

    let thrown: unknown;
    try {
      resolveStepReference(reference, source);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as M3LStepReferenceError).message).not.toContain("boom");
  });

  test("wraps a throwing Proxy get trap as M3LStepReferenceError with the reference-invalid code, not the raw thrown value", () => {
    const target = { x: "value" };
    const hostile = new Proxy(target, {
      get(): never {
        throw new Error("proxy trap boom");
      },
    });
    const reference = parseStepReference("step-1.output.x");

    expectReferenceInvalid(() => resolveStepReference(reference, hostile));

    let thrown: unknown;
    try {
      resolveStepReference(reference, hostile);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as M3LStepReferenceError).message).not.toContain(
      "proxy trap boom",
    );
  });

  test("wraps a throwing array-index getter as M3LStepReferenceError with the reference-invalid code", () => {
    const array: unknown[] = [];
    Object.defineProperty(array, 0, {
      get(): never {
        throw new Error("index getter boom");
      },
      enumerable: true,
      configurable: true,
    });
    const reference = parseStepReference("step-1.output.items[0]");
    const source = { items: array };

    expectReferenceInvalid(() => resolveStepReference(reference, source));

    let thrown: unknown;
    try {
      resolveStepReference(reference, source);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as M3LStepReferenceError).message).not.toContain(
      "index getter boom",
    );
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

/**
 * DEFECT 2 — `formatStepReference` must apply the SAME fail-closed screens
 * `parseStepReference` applies (the `isDangerousKey` prototype-pollution
 * guard, the 15-digit run cap, and a safe-integer check), so it can never
 * emit reference text the parser turns around and rejects. Today the
 * format guard only checks `Number.isInteger`/`>= 0`, so a hand-built or
 * deserialized `M3LStepReference` — most seriously one carrying a
 * `__proto__`/`constructor`/`prototype` property segment, which
 * `parseStepReference` refuses to produce and `resolveStepReference`
 * refuses to walk — formats into text that LOOKS like a legitimate
 * reference but is actually unparseable/unwalkable.
 */
describe("formatStepReference — fails closed on inputs parseStepReference would reject (screens must match the parser exactly)", () => {
  test.each<[string]>([["__proto__"], ["constructor"], ["prototype"]])(
    "throws ERR_STEP_REFERENCE_INVALID for a dangerous property-segment name %s, instead of emitting text the parser (and resolver) refuse",
    (dangerousName) => {
      const reference: M3LStepReference = {
        ordinal: 1,
        segments: [{ kind: "property", name: dangerousName }],
      };

      expectReferenceInvalid(() => formatStepReference(reference));
    },
  );

  test("throws ERR_STEP_REFERENCE_INVALID for an ordinal beyond the safe-integer ceiling (1e21), instead of emitting exponential-notation text the parser rejects", () => {
    const reference: M3LStepReference = { ordinal: 1e21, segments: [] };

    expectReferenceInvalid(() => formatStepReference(reference));
  });

  test("throws ERR_STEP_REFERENCE_INVALID for an index beyond the 15-digit run cap (2**53), instead of emitting a 16-digit run the parser's ceiling rejects", () => {
    const reference: M3LStepReference = {
      ordinal: 1,
      segments: [{ kind: "index", index: 2 ** 53 }],
    };

    expectReferenceInvalid(() => formatStepReference(reference));
  });
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
 * DEFECT 3 — TOCTOU on `segment.name` (2026-09-01 security review). The
 * resolver's `resolvePropertySegment` reads `segment.name` three times: the
 * `isDangerousKey` guard, the `Object.hasOwn` check, and the actual
 * property read. A segment whose `name` is a getter that returns a safe
 * value on the guard's read and `"__proto__"` on the subsequent reads
 * defeats the guard entirely — the check-then-use gap between the read the
 * guard inspects and the read the walk actually uses.
 */
describe("resolveStepReference — TOCTOU on a getter-backed segment.name defeats the dangerous-key guard", () => {
  test("a segment.name getter that returns a safe name to the guard but __proto__ to the actual read must still throw, not leak the polluted value", () => {
    let reads = 0;
    const segment: M3LStepReferenceSegment = {
      kind: "property",
      get name(): string {
        reads += 1;
        return reads === 1 ? "safe" : "__proto__";
      },
    };
    const reference: M3LStepReference = { ordinal: 1, segments: [segment] };
    // JSON.parse creates "__proto__" as a literal OWN property (via
    // CreateDataProperty), not the object's actual prototype — this is
    // exactly the shape a deserialized step output can legitimately have.
    const source: unknown = JSON.parse(
      '{"__proto__":{"leak":"PWNED"},"safe":"ok"}',
    );

    let thrown: unknown;
    try {
      resolveStepReference(reference, source);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LStepReferenceError);
    expect((thrown as M3LStepReferenceError).code).toBe(
      "ERR_STEP_REFERENCE_INVALID",
    );
  });

  test("a segment.name getter that returns a STABLE value across every read still resolves normally (the guard must not reject well-behaved getters)", () => {
    const segment: M3LStepReferenceSegment = {
      kind: "property",
      get name(): string {
        return "safe";
      },
    };
    const reference: M3LStepReference = { ordinal: 1, segments: [segment] };
    const source = { safe: "ok" };

    expect(resolveStepReference(reference, source)).toBe("ok");
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

/**
 * DEFECT 6 — no argument narrowing at the three public entry points
 * (2026-09-01 security review). `parseStepReference`, `formatStepReference`,
 * and `resolveStepReference` all document `@throws {@link
 * M3LStepReferenceError}` with code `ERR_STEP_REFERENCE_INVALID`, but a
 * non-string `text` / non-object `reference` argument currently reaches a
 * raw, un-narrowed `TypeError` (or similar) instead — violating the
 * documented contract and, at the console adapter boundary, misclassifying
 * caller input as a server fault.
 */
describe("parseStepReference — narrows a non-string argument to M3LStepReferenceError instead of a raw TypeError", () => {
  test.each<[string, unknown]>([
    ["null", null],
    ["undefined", undefined],
    ["a number", 42],
    ["an object", { not: "text" }],
  ])(
    "throws M3LStepReferenceError (code ERR_STEP_REFERENCE_INVALID), not a raw TypeError, for text = %s",
    (_label, badText) => {
      expectReferenceInvalid(() => parseStepReference(badText as string));
    },
  );
});

describe("formatStepReference — narrows a non-M3LStepReference argument to M3LStepReferenceError instead of a raw TypeError", () => {
  test.each<[string, unknown]>([
    ["null", null],
    ["undefined", undefined],
    ["a number", 42],
    [
      "a string (raw reference text, not a parsed M3LStepReference)",
      "step-1.output",
    ],
  ])(
    "throws M3LStepReferenceError (code ERR_STEP_REFERENCE_INVALID), not a raw TypeError, for reference = %s",
    (_label, badReference) => {
      expectReferenceInvalid(() =>
        formatStepReference(badReference as M3LStepReference),
      );
    },
  );
});

describe("resolveStepReference — narrows a non-M3LStepReference `reference` argument to M3LStepReferenceError instead of a raw TypeError", () => {
  test.each<[string, unknown]>([
    ["null", null],
    ["undefined", undefined],
    ["a number", 42],
    [
      "a string (raw reference text, not a parsed M3LStepReference)",
      "step-1.output",
    ],
  ])(
    "throws M3LStepReferenceError (code ERR_STEP_REFERENCE_INVALID), not a raw TypeError, for reference = %s",
    (_label, badReference) => {
      expectReferenceInvalid(() =>
        resolveStepReference(badReference as M3LStepReference, {}),
      );
    },
  );
});
