/**
 * Tests for src/sessions/reference.ts — the addressable step-result
 * reference grammar (m3l-console-server X6 workbench-sessions module, slice
 * 2, ADR-0068).
 *
 * `parseStepReference`/`formatStepReference` must be exact inverses of each
 * other (byte-identical round-trip for every valid input), and
 * `resolveStepReference` must refuse the three prototype-pollution vector
 * names outright rather than silently walking them — this repo's standard
 * `isDangerousKey` guard (`packages/m3l-common/src/core/security/DangerousKeys.ts`)
 * applied to a new untrusted-path surface.
 */
import { describe, expect, expectTypeOf, test } from "vitest";

import { M3LConsoleError } from "../src/errors/console-error.js";
import {
  formatStepReference,
  parseStepReference,
  resolveStepReference,
} from "../src/sessions/reference.js";
import type { M3LStepReference } from "../src/sessions/reference.js";

/** Asserts that `fn` throws an `M3LConsoleError` with the reference-invalid code. */
function expectReferenceInvalid(fn: () => unknown): void {
  expect(fn).toThrow(M3LConsoleError);
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(M3LConsoleError);
  expect((thrown as M3LConsoleError).code).toBe(
    "ERR_CONSOLE_SESSION_REFERENCE_INVALID",
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
  test.each<[string, string]>([
    ["__proto__", "dotted"],
    ["constructor", "dotted"],
    ["prototype", "dotted"],
  ])("throws for the dotted dangerous segment .%s", (dangerousName) => {
    expectReferenceInvalid(() =>
      parseStepReference(`step-1.output.${dangerousName}`),
    );
  });

  test.each<[string, string]>([
    ["__proto__", "bracket-quoted"],
    ["constructor", "bracket-quoted"],
    ["prototype", "bracket-quoted"],
  ])(
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
  ])(
    "throws ERR_CONSOLE_SESSION_REFERENCE_INVALID for %s",
    (_description, reference) => {
      expectReferenceInvalid(() => formatStepReference(reference));
    },
  );
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
  test("throws when a mid-path segment resolves to a non-object/non-array value", () => {
    const reference = parseStepReference("step-1.output.foo.bar");
    const source = { foo: 42 };

    expect(() => resolveStepReference(reference, source)).toThrow(
      M3LConsoleError,
    );
    expectReferenceInvalid(() => resolveStepReference(reference, source));
  });

  test("throws when indexing into a non-array value", () => {
    const reference = parseStepReference("step-1.output.foo[0]");
    const source = { foo: "not-an-array" };

    expectReferenceInvalid(() => resolveStepReference(reference, source));
  });
});

describe("resolveStepReference — forbidden prototype-pollution segments", () => {
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
});

describe("resolveStepReference — hostile (throwing) getters surface as a typed M3LConsoleError", () => {
  test("wraps a throwing property getter as M3LConsoleError with the reference-invalid code, not the raw thrown value", () => {
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
    expect((thrown as M3LConsoleError).message).not.toContain("boom");
  });

  test("wraps a throwing Proxy get trap as M3LConsoleError with the reference-invalid code, not the raw thrown value", () => {
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
    expect((thrown as M3LConsoleError).message).not.toContain(
      "proxy trap boom",
    );
  });
});

describe("M3LStepReference — discriminated segment shape", () => {
  test("a segment is either a property-name segment or an array-index segment, tagged by kind", () => {
    expectTypeOf<M3LStepReference>().toMatchTypeOf<{
      readonly ordinal: number;
      readonly segments: readonly (
        | { readonly kind: "property"; readonly name: string }
        | { readonly kind: "index"; readonly index: number }
      )[];
    }>();
  });
});
