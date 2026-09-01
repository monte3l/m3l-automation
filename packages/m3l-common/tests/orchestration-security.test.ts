/**
 * Tests for core/orchestration's HOSTILE-INPUT surface — the fail-closed
 * screens that stand between a caller-supplied (typically deserialized)
 * `M3LStepReference` and the walk/emit logic, and the typed-error contract
 * that surface must never escape.
 *
 * WHY THIS IS A SEPARATE FILE. Two reasons, one mechanical and one about
 * cohesion. Mechanically, `pnpm check:file-budget` (ADR-0072) caps a test
 * file at 60,000 bytes, and the combined suite crossed that ceiling; the
 * ratchet's own rule is that a file created by the PR that trips it lands
 * under the ceiling rather than joining
 * `bin/file-budget-baseline.json`'s day-one debt list. For cohesion, this
 * half is a genuinely different kind of test from its sibling: every block
 * here drives a value the public types forbid — a getter-backed field, a
 * `valueOf`/`toString`-divergent index, a `__proto__` property name, a
 * malformed `segments[]` element — and asserts the module refuses it as a
 * typed `M3LStepReferenceError`. The sibling
 * `packages/m3l-common/tests/orchestration.test.ts` owns the grammar
 * (`parseStepReference`/`formatStepReference` valid input, emission,
 * canonicalization, round-tripping), the walk's happy/absent/impossible
 * paths, `validateBindingValue`, and the type-level contracts. Between them
 * they cover the same nine exports; neither is a subset of the other.
 *
 * Contract source: docs/plans/2026-09-01-orchestration-engine.md § "Slice 2
 * — the promoted surface", plus the behavioral source of truth this module
 * is promoted from —
 * `packages/m3l-console-server/src/sessions/reference.ts` and
 * `packages/m3l-console-server/src/sessions/binding.ts` (ADR-0068).
 *
 * Exports exercised here: `M3LStepReference`, `M3LStepReferenceSegment`,
 *   `parseStepReference`, `formatStepReference`, `resolveStepReference`,
 *   `M3LStepReferenceError`.
 *
 * The through-line: the prototype-pollution vector names (`__proto__`,
 * `constructor`, `prototype` — this repo's standard `isDangerousKey` guard)
 * are screened at parse time, walk time AND format time independently, and
 * every rejection is an `M3LStepReferenceError` carrying
 * `ERR_STEP_REFERENCE_INVALID` rather than a raw `TypeError` (which the
 * console adapter would misclassify as a 500 rather than a 400). The blocks
 * below are ordered by the boundary they defend: parse time, walk time,
 * format time, the typed-error narrowing at each entry point, and finally
 * the validated-snapshot discipline in `shape.ts` that makes all of the
 * above non-bypassable.
 */
import { describe, expect, test } from "vitest";

import {
  formatStepReference,
  M3LStepReferenceError,
  parseStepReference,
  resolveStepReference,
} from "../src/core/orchestration/index.js";
import type {
  M3LStepReference,
  M3LStepReferenceSegment,
} from "../src/core/orchestration/index.js";

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
  // undetected. AFTER: the test.each below proves that specific claim, and
  // passes GREEN — a `valueOf`/`toString`-divergent index is rejected
  // outright, before the index is ever used as a property key. Which layer
  // rejects it moves with the snapshot fix (from `resolveIndexSegment`'s
  // `typeof index !== "number"` clause to `assertSegmentShape`'s single
  // validated read), so these assertions deliberately pin only the
  // observable `M3LStepReferenceError`, not the layer.
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

/**
 * DEFECT 2 — `formatStepReference` must apply the SAME fail-closed screens
 * `parseStepReference` applies (the `isDangerousKey` prototype-pollution
 * guard, the 15-digit run cap, and a safe-integer check), so it can never
 * emit reference text the parser turns around and rejects. Before this fix
 * the format guard only checked `Number.isInteger`/`>= 0`, so a hand-built
 * or deserialized `M3LStepReference` — most seriously one carrying a
 * `__proto__`/`constructor`/`prototype` property segment, which
 * `parseStepReference` refuses to produce and `resolveStepReference`
 * refuses to walk — could format into text that LOOKS like a legitimate
 * reference but is actually unparseable/unwalkable. `formatStepReference`
 * now re-applies the same `isDangerousKey`/digit-run/safe-integer screens
 * the parser applies, so this can no longer happen.
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
    // The rows above are all NON-objects, so they only ever reach
    // `assertStepReferenceShape`'s `isPlainObject` rejection. These two are
    // plain objects that fail the SECOND screen — one per operand of its
    // `typeof ordinal !== "number" || !Array.isArray(segments)` test — which
    // no case reached before.
    [
      "a plain object whose `ordinal` is not a number",
      { ordinal: "1", segments: [] },
    ],
    [
      "a plain object whose `segments` is not an array",
      { ordinal: 1, segments: "not-an-array" },
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
    // The rows above are all NON-objects, so they only ever reach
    // `assertStepReferenceShape`'s `isPlainObject` rejection. These two are
    // plain objects that fail the SECOND screen — one per operand of its
    // `typeof ordinal !== "number" || !Array.isArray(segments)` test — which
    // no case reached before.
    [
      "a plain object whose `ordinal` is not a number",
      { ordinal: "1", segments: [] },
    ],
    [
      "a plain object whose `segments` is not an array",
      { ordinal: 1, segments: "not-an-array" },
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

/**
 * MUST-FIX — `assertStepReferenceShape` (used by both `formatStepReference`
 * and `resolveStepReference`) validates only the OUTER object — that
 * `ordinal` is a number and `segments` is an array — and never validates
 * the array's ELEMENTS. A malformed segment therefore escapes the
 * documented `@throws M3LStepReferenceError` contract entirely: today it
 * surfaces as a raw `TypeError` (e.g. `formatStepReference` reading
 * `.length` off an `undefined` segment name), or — worse, for
 * `resolveStepReference` walking a `{ kind: "property" }` segment with a
 * missing/non-string `name` — as no error at all, silently resolving to
 * `undefined` via the "absent" sentinel instead of rejecting the malformed
 * input. Both manifestations misclassify caller input as a server fault at
 * the console adapter boundary, and both are reachable from a deserialized
 * flow/session definition. Every case below must throw
 * `M3LStepReferenceError` (code `ERR_STEP_REFERENCE_INVALID`) once element
 * validation lands; the index-segment rows already do today (assert
 * anyway, to lock that in against a future regression).
 */
const MALFORMED_SEGMENT_CASES: [string, unknown][] = [
  ["null", null],
  ["undefined", undefined],
  ["a number", 42],
  ["a string", "oops"],
  ["an array", []],
  ["a plain object with kind missing entirely", {}],
  ['an unrecognised discriminant (kind: "bogus")', { kind: "bogus" }],
  ["a property segment missing `name`", { kind: "property" }],
  [
    "a property segment with a non-string `name`",
    { kind: "property", name: 123 },
  ],
  [
    "an index segment missing `index` (already screened today — assert anyway)",
    { kind: "index" },
  ],
  [
    "an index segment with a non-number `index` (already screened today — assert anyway)",
    { kind: "index", index: "abc" },
  ],
];

describe("formatStepReference — narrows a malformed SEGMENT (array element), not just the outer object, to M3LStepReferenceError", () => {
  test.each<[string, unknown]>(MALFORMED_SEGMENT_CASES)(
    "throws M3LStepReferenceError (code ERR_STEP_REFERENCE_INVALID), not a raw TypeError, for a segments array containing %s",
    (_label, malformedSegment) => {
      const reference = {
        ordinal: 1,
        segments: [malformedSegment],
      } as unknown as M3LStepReference;

      expectReferenceInvalid(() => formatStepReference(reference));
    },
  );
});

describe("resolveStepReference — narrows a malformed SEGMENT (array element), not just the outer object, to M3LStepReferenceError", () => {
  test.each<[string, unknown]>(MALFORMED_SEGMENT_CASES)(
    "throws M3LStepReferenceError (code ERR_STEP_REFERENCE_INVALID), not a raw TypeError (and never silently resolves to undefined), for a segments array containing %s",
    (_label, malformedSegment) => {
      const reference = {
        ordinal: 1,
        segments: [malformedSegment],
      } as unknown as M3LStepReference;

      expectReferenceInvalid(() =>
        resolveStepReference(reference, { safe: "val" }),
      );
    },
  );
});

describe("formatStepReference / resolveStepReference — element validation does not over-tighten a well-formed segment list", () => {
  test("a valid mixed property/index segment list still formats and resolves normally", () => {
    const reference: M3LStepReference = {
      ordinal: 1,
      segments: [
        { kind: "property", name: "messages" },
        { kind: "index", index: 0 },
      ],
    };

    expect(formatStepReference(reference)).toBe("step-1.output.messages[0]");
    expect(resolveStepReference(reference, { messages: ["hi"] })).toBe("hi");
  });
});
/**
 * DEFECT 3 (2026-09-01 security review), REOPENED as a MUST-FIX by the
 * 2026-09-01 PR review — TOCTOU between shape validation and use, on BOTH
 * `segment.name` and `segment.kind`.
 *
 * The original DEFECT 3 fix hoisted `segment.name` into a local inside
 * `resolvePropertySegment` and rejected any change observed between two
 * reads. That guard is not sufficient: `assertSegmentShape` hands the
 * caller's LIVE object back, so every downstream re-read is another
 * observable call into caller-controlled code, and the review found two
 * reachable bypasses.
 *
 * 1. `name` divergence. The validating read in `assertSegmentShape` consumes
 *    the getter's FIRST read, so the stability guard's own two reads are the
 *    second and third — a getter that returns a string once and then a
 *    STABLE non-string object forever after compares equal to itself, and
 *    the guard never re-checks `typeof name === "string"`. That object also
 *    passes `isDangerousKey` (a `Set.has`, which does not coerce), then
 *    reaches `Object.hasOwn(current, name)` / `current[name]`, where
 *    `ToPropertyKey` invokes its `toString()` and yields `"__proto__"` — a
 *    prototype-pollution READ of a JSON-created own `__proto__` property.
 * 2. `kind` divergence. `kind` is validated once but re-read for dispatch in
 *    `resolveStepReference` and in `formatStepReference`, so a getter can
 *    report `"index"` to the validator (satisfying its `index` check) and
 *    `"property"` to the dispatcher, routing a never-validated `name` into
 *    `resolvePropertySegment` — or, in `formatStepReference`, into
 *    `isIdentSafe(undefined)`, a raw `TypeError` outside the typed-error
 *    contract.
 *
 * THE FIX PINNED BELOW: `assertSegmentShape` returns a FRESH FROZEN
 * own-property literal — `Object.freeze({ kind: "property", name })` or
 * `Object.freeze({ kind: "index", index })` — built from the single
 * validated read of each field. Consequences: every caller-supplied
 * `kind`/`name`/`index` is read EXACTLY ONCE, the validated read is the one
 * the walk and the emitter use, and no later read can influence dispatch,
 * the dangerous-key screen, or the emitted text.
 *
 * `resolvePropertySegment`'s two-read stability guard and
 * `resolveIndexSegment`'s `typeof index !== "number"` clause both become
 * dead code once the snapshot lands. The tests that used to pin them (a
 * divergent-getter `name` THROWING "changed between reads") are re-pointed
 * here onto the snapshot semantics: first read wins, no pollution, read
 * count is 1.
 */

/** Counts how many times a caller-supplied segment field was read. */
interface FieldReadCounter {
  /** Read count so far. */
  count: number;
}

/** A caller-supplied segment object plus the counter for the field under observation. */
interface CountedSegment {
  /**
   * The hostile segment, typed `unknown` on purpose: the whole point is to
   * smuggle values past the boundary that `M3LStepReferenceSegment` forbids.
   */
  readonly segment: unknown;
  /** Read counter for the diverging field. */
  readonly reads: FieldReadCounter;
}

/**
 * Builds a property segment whose `name` getter returns `first` on its first
 * read and `later` on every read after that, counting the reads.
 */
function divergentNameSegment(first: unknown, later: unknown): CountedSegment {
  const reads: FieldReadCounter = { count: 0 };
  const segment = {
    kind: "property",
    get name(): unknown {
      reads.count += 1;
      return reads.count === 1 ? first : later;
    },
  };
  return { segment, reads };
}

/**
 * Builds an index segment whose `index` getter returns `first` on its first
 * read and `later` on every read after that, counting the reads.
 */
function divergentIndexSegment(first: unknown, later: unknown): CountedSegment {
  const reads: FieldReadCounter = { count: 0 };
  const segment = {
    kind: "index",
    get index(): unknown {
      reads.count += 1;
      return reads.count === 1 ? first : later;
    },
  };
  return { segment, reads };
}

/**
 * Builds a segment whose `kind` getter returns `first` on its first read and
 * `later` on every read after that, counting the reads, with `rest` supplying
 * whatever `name`/`index` payload the scenario needs.
 */
function divergentKindSegment(
  first: unknown,
  later: unknown,
  rest: Readonly<Record<string, unknown>>,
): CountedSegment {
  const reads: FieldReadCounter = { count: 0 };
  const segment = {
    get kind(): unknown {
      reads.count += 1;
      return reads.count === 1 ? first : later;
    },
    ...rest,
  };
  return { segment, reads };
}

/** Wraps a hostile segment into a reference, bypassing the compile-time segment type. */
function referenceWithSegment(segment: unknown): M3LStepReference {
  return { ordinal: 1, segments: [segment] } as unknown as M3LStepReference;
}

describe("resolveStepReference — reads each caller-supplied segment field exactly once, off a validated snapshot", () => {
  test("a name getter returning a stable toString-coercing object after its validated read cannot redirect the walk into __proto__", () => {
    // The live exploit: read 1 (the validator's) is "safe"; reads 2 and 3
    // (the deleted stability guard's) are the SAME object, so they compare
    // equal, the object is not in the dangerous-key Set, and
    // `Object.hasOwn(current, name)` coerces it to "__proto__".
    const { segment, reads } = divergentNameSegment("safe", {
      toString: (): string => "__proto__",
    });
    // JSON.parse creates "__proto__" as a literal OWN property (via
    // CreateDataProperty), not the object's actual prototype — exactly the
    // shape a deserialized step output can legitimately have, and what makes
    // the leak observable.
    const source: unknown = JSON.parse(
      '{"__proto__":{"leak":"PWNED"},"safe":"ok"}',
    );

    const result = resolveStepReference(referenceWithSegment(segment), source);

    expect(result).toBe("ok");
    expect(result).not.toEqual({ leak: "PWNED" });
    expect(reads.count).toBe(1);
    // Nothing may have been written to the real prototype either.
    expect(Object.hasOwn(Object.prototype, "leak")).toBe(false);
  });

  test("the dangerous-key screen runs on the validated read: a name whose FIRST read is __proto__ throws even when every later read is safe", () => {
    // A ONE-SHOT hostile segment must be driven exactly once. This case
    // deliberately does NOT route through `expectReferenceInvalid`, which
    // calls its subject twice (once inside `expect().toThrow()`, once to
    // inspect the thrown instance): the second call would read the benign
    // `"safe"` name and resolve normally. Re-validating on every call is the
    // correct semantics — see "validation snapshots rather than freezing or
    // mutating the caller's own segment object" below — so the fix belongs
    // here, in the invocation count, and every assertion is made off the
    // single `thrown` captured from the single call.
    const { segment, reads } = divergentNameSegment("__proto__", "safe");

    let thrown: unknown;
    try {
      resolveStepReference(referenceWithSegment(segment), { safe: "ok" });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LStepReferenceError);
    expect((thrown as M3LStepReferenceError).code).toBe(
      "ERR_STEP_REFERENCE_INVALID",
    );
    expect((thrown as M3LStepReferenceError).message).toContain(
      'forbidden property name "__proto__"',
    );
    // The deleted two-read stability guard must not be what rejects this.
    expect((thrown as M3LStepReferenceError).message).not.toContain(
      "changed between reads",
    );
    // One read total, so the benign `"safe"` value was never even observed:
    // the screen ran on the validated read, not on a later one.
    expect(reads.count).toBe(1);
  });

  test("an index getter that diverges after its validated read cannot move the bounds check or the element actually read", () => {
    const { segment, reads } = divergentIndexSegment(0, 5);

    const result = resolveStepReference(referenceWithSegment(segment), [
      "first",
      "second",
    ]);

    expect(result).toBe("first");
    expect(reads.count).toBe(1);
  });

  test("a kind getter reporting index to the validator and property to the dispatcher cannot reach resolvePropertySegment", () => {
    const { segment, reads } = divergentKindSegment("index", "property", {
      index: 0,
      name: { toString: (): string => "__proto__" },
    });
    // An array carrying an OWN "__proto__" data property (shadowing the
    // accessor it inherits) makes the bypass observable rather than merely
    // mis-dispatched: the validated `kind` says "index" (element 0 is "ok"),
    // while a re-read saying "property" walks the coerced "__proto__" name
    // instead and hands back the leaked object.
    const source: unknown[] = ["ok"];
    Object.defineProperty(source, "__proto__", {
      value: { leak: "PWNED" },
      enumerable: true,
      configurable: true,
      writable: true,
    });

    const result = resolveStepReference(referenceWithSegment(segment), source);

    expect(result).toBe("ok");
    expect(result).not.toEqual({ leak: "PWNED" });
    expect(reads.count).toBe(1);
  });

  test("a kind getter reporting property to the validator and index to the dispatcher cannot reach resolveIndexSegment", () => {
    const { segment, reads } = divergentKindSegment("property", "index", {
      name: "safe",
    });

    const result = resolveStepReference(referenceWithSegment(segment), {
      safe: "ok",
    });

    expect(result).toBe("ok");
    expect(reads.count).toBe(1);
  });

  test("a name getter that mutates its own segment's kind mid-validation cannot redirect dispatch: the validated kind wins", () => {
    const segment: Record<string, unknown> = { kind: "property" };
    Object.defineProperty(segment, "name", {
      get(): string {
        // `assertSegmentShape` reads `kind` BEFORE `name`, so this write
        // lands after the validated `kind` read and can only be observed by
        // a later re-read — which the snapshot removes.
        segment["kind"] = "index";
        return "safe";
      },
      enumerable: true,
      configurable: true,
    });

    expect(
      resolveStepReference(referenceWithSegment(segment), { safe: "ok" }),
    ).toBe("ok");
  });

  test("a segment.name getter that returns a STABLE value across every read still resolves normally (the snapshot must not reject well-behaved getters)", () => {
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

  test("a segment.index getter that returns a STABLE number still resolves normally", () => {
    const segment: M3LStepReferenceSegment = {
      kind: "index",
      get index(): number {
        return 1;
      },
    };
    const reference: M3LStepReference = { ordinal: 1, segments: [segment] };

    expect(resolveStepReference(reference, ["a", "b"])).toBe("b");
  });

  test("validation snapshots rather than freezing or mutating the caller's own segment object", () => {
    // Regression lock (passes pre-fix too): the snapshot must be a FRESH
    // literal, so the caller's object stays untouched and a LATER call —
    // which re-validates from scratch — legitimately sees the new value.
    const segment: Record<string, unknown> = { kind: "property", name: "safe" };
    const reference = referenceWithSegment(segment);

    expect(resolveStepReference(reference, { safe: "ok" })).toBe("ok");
    expect(Object.isFrozen(segment)).toBe(false);

    segment["name"] = "other";

    expect(resolveStepReference(reference, { other: "second" })).toBe("second");
  });
});

describe("formatStepReference — emits text built from the validated snapshot, never a later re-read", () => {
  test("a name getter that diverges after its validated read cannot change the emitted text", () => {
    const { segment, reads } = divergentNameSegment("safe", "__proto__");

    expect(formatStepReference(referenceWithSegment(segment))).toBe(
      "step-1.output.safe",
    );
    expect(reads.count).toBe(1);
  });

  test("an index getter that diverges after its validated read cannot change the emitted digits", () => {
    const { segment, reads } = divergentIndexSegment(0, 5);

    expect(formatStepReference(referenceWithSegment(segment))).toBe(
      "step-1.output[0]",
    );
    expect(reads.count).toBe(1);
  });

  test("a kind getter reporting index to the validator and property to the emitter cannot escape as a raw TypeError from isIdentSafe(undefined)", () => {
    const { segment, reads } = divergentKindSegment("index", "property", {
      index: 0,
    });

    expect(formatStepReference(referenceWithSegment(segment))).toBe(
      "step-1.output[0]",
    );
    expect(reads.count).toBe(1);
  });

  test("a kind getter reporting property to the validator and index to the emitter cannot reach the index branch with an undefined index", () => {
    const { segment, reads } = divergentKindSegment("property", "index", {
      name: "safe",
    });

    expect(formatStepReference(referenceWithSegment(segment))).toBe(
      "step-1.output.safe",
    );
    expect(reads.count).toBe(1);
  });
});

/**
 * `resolveIndexSegment`'s `typeof index !== "number"` clause is unreachable
 * once `assertSegmentShape` snapshots a validated number, and is dropped —
 * leaving `!Number.isSafeInteger(index) || index < 0`. Both surviving
 * branches are pinned here (they already pass; this is the coverage lock
 * that keeps them exercised after the dead clause goes away).
 */
describe("resolveStepReference — the two numeric index screens that survive the shape snapshot", () => {
  test.each<[string, number]>([
    ["a non-integer index (1.5)", 1.5],
    ["a negative index (-1)", -1],
  ])(
    "throws ERR_STEP_REFERENCE_INVALID for %s, before any array access",
    (_label, index) => {
      const reference: M3LStepReference = {
        ordinal: 1,
        segments: [{ kind: "index", index }],
      };

      expectReferenceInvalid(() =>
        resolveStepReference(reference, ["a", "b", "c"]),
      );
    },
  );
});
