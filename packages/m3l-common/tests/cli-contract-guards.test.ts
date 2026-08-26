/**
 * `core/cli-contract/guards` — the runtime descriptor/outcome guards (U7 PR1).
 *
 * ADR-0072 slice split: this file owns `isM3LCommandModule` and
 * `isM3LCommandOutcome` and nothing else.
 *
 * Both guards sit on a genuinely hostile boundary: a host `import()`s a
 * foreign `dist/command.js` it did not compile and reads properties off
 * whatever that module exported. The values crossing the guard are therefore
 * caller-controlled in the strongest sense — a `Proxy`, a throwing getter, a
 * revoked handle, or a plain `undefined` from a missing `await` are all
 * reachable — so the contract is absolute: **a guard never throws**, and it
 * reads each caller-controlled property **at most once**.
 *
 * The read-once property is locked the way `cli-contract-exit-code.test.ts`
 * already locks it for `mapCommandOutcomeToExitCode`: with a non-idempotent
 * getter, asserting BOTH the read count and that the verdict matches the FIRST
 * read. An inert getter passes under either implementation and proves nothing.
 *
 * Deliberately NOT asserted: that `configParameters`' elements are real
 * `M3LConfigParameter` instances. The class is nominal, and a foreign `dist/`
 * build cannot be proven to have gone through its constructor — `Array.isArray`
 * is the honest check, and a stricter one would reject every legitimate
 * cross-build descriptor.
 */

import { describe, expect, test } from "vitest";

import {
  isM3LCommandModule,
  isM3LCommandOutcome,
} from "../src/core/cli-contract/index.js";
import type {
  M3LCommandModule,
  M3LCommandOutcome,
} from "../src/core/cli-contract/index.js";
import {
  M3LConfigParameter,
  M3LConfigParameterType,
} from "../src/core/config/index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A minimally-valid descriptor: the four required members, no description. */
function minimalDescriptor(): unknown {
  return {
    name: "s3-export",
    version: "1.0.0",
    configParameters: [],
    execute: () => Promise.resolve({ status: "success" }),
  };
}

/** A revoked `Proxy` — every operation on it throws a `TypeError`. */
function revokedProxy(): unknown {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy;
}

/** A `Proxy` whose `get` trap throws for every key. */
function hostileProxy(): unknown {
  return new Proxy(
    {},
    {
      get(): never {
        throw new Error("trap");
      },
    },
  );
}

// ---------------------------------------------------------------------------
// isM3LCommandModule — the accepting side
// ---------------------------------------------------------------------------

describe("isM3LCommandModule — valid descriptors", () => {
  test("accepts a minimal descriptor carrying the four required members", () => {
    expect(isM3LCommandModule(minimalDescriptor())).toBe(true);
  });

  test("accepts a descriptor carrying a string description", () => {
    expect(
      isM3LCommandModule({
        ...(minimalDescriptor() as object),
        description: "Exports a bucket listing.",
      }),
    ).toBe(true);
  });

  test("accepts a real, fully-populated descriptor built against the type", () => {
    const commandModule: M3LCommandModule<object> = {
      name: "s3-export",
      version: "1.0.0",
      description: "Exports a bucket listing.",
      configParameters: [
        new M3LConfigParameter({
          name: "bucket",
          type: M3LConfigParameterType.STRING,
        }),
      ],
      execute(): Promise<M3LCommandOutcome> {
        return Promise.resolve({ status: "success" });
      },
    };

    expect(isM3LCommandModule(commandModule)).toBe(true);
  });

  // The guard is deliberately structural, not nominal: a descriptor loaded
  // from a foreign `dist/` build carries `M3LConfigParameter` instances from a
  // DIFFERENT copy of the library, so an `instanceof` element check would
  // reject exactly the case the guard exists for.
  test("accepts hand-rolled configParameters elements — the element type is not checked", () => {
    expect(
      isM3LCommandModule({
        ...(minimalDescriptor() as object),
        configParameters: [{ name: "bucket", type: "STRING" }],
      }),
    ).toBe(true);
  });

  test("narrows to M3LCommandModule<object> for the caller", () => {
    const value: unknown = minimalDescriptor();
    if (isM3LCommandModule(value)) {
      // Reachable only through the narrowing, which is the point of the guard.
      expect(value.name).toBe("s3-export");
      expect(typeof value.execute).toBe("function");
    } else {
      expect.unreachable("the minimal descriptor must pass the guard");
    }
  });
});

// ---------------------------------------------------------------------------
// isM3LCommandModule — the rejecting side
// ---------------------------------------------------------------------------

const INVALID_MODULES: readonly {
  readonly label: string;
  readonly make: () => unknown;
}[] = [
  { label: "null", make: () => null },
  { label: "undefined (a missing await)", make: () => undefined },
  { label: "a plain string", make: () => "s3-export" },
  { label: "a number", make: () => 42 },
  { label: "an array", make: () => [] },
  { label: "an empty object", make: () => ({}) },
  {
    label: "a descriptor whose name is not a string",
    make: () => ({ ...(minimalDescriptor() as object), name: 42 }),
  },
  {
    label: "a descriptor whose version is missing",
    make: () => {
      const value = minimalDescriptor() as Record<string, unknown>;
      delete value["version"];
      return value;
    },
  },
  {
    label: "a descriptor whose configParameters is an object, not an array",
    make: () => ({ ...(minimalDescriptor() as object), configParameters: {} }),
  },
  {
    label: "a descriptor whose execute is not a function",
    make: () => ({ ...(minimalDescriptor() as object), execute: "run" }),
  },
  {
    label: "a descriptor whose description is present but not a string",
    make: () => ({ ...(minimalDescriptor() as object), description: 7 }),
  },
  {
    label: "a descriptor whose name getter throws",
    make: () => ({
      ...(minimalDescriptor() as object),
      get name(): never {
        throw new Error("boom");
      },
    }),
  },
  {
    label: "a descriptor whose version getter throws",
    make: () => ({
      ...(minimalDescriptor() as object),
      get version(): never {
        throw new Error("boom");
      },
    }),
  },
  {
    label: "a descriptor whose execute getter throws",
    make: () => ({
      ...(minimalDescriptor() as object),
      get execute(): never {
        throw new Error("boom");
      },
    }),
  },
  { label: "a revoked Proxy", make: revokedProxy },
  { label: "a Proxy whose get trap throws for every key", make: hostileProxy },
];

describe("isM3LCommandModule — hostile and malformed input", () => {
  test.each(INVALID_MODULES)(
    "rejects $label without throwing",
    ({ make }: { readonly make: () => unknown }) => {
      const value = make();
      expect(() => isM3LCommandModule(value)).not.toThrow();
      expect(isM3LCommandModule(value)).toBe(false);
    },
  );

  test("the hostile-module table names every documented vector", () => {
    expect(new Set(INVALID_MODULES.map((row) => row.label)).size).toBe(
      INVALID_MODULES.length,
    );
  });
});

// ---------------------------------------------------------------------------
// isM3LCommandModule — one read per caller-controlled property
// ---------------------------------------------------------------------------

describe("isM3LCommandModule — one read per caller-controlled property", () => {
  test("reads each of the five members at most once", () => {
    const reads: Record<string, number> = {
      name: 0,
      version: 0,
      description: 0,
      configParameters: 0,
      execute: 0,
    };
    const descriptor = {
      get name(): string {
        reads["name"] = (reads["name"] ?? 0) + 1;
        return "s3-export";
      },
      get version(): string {
        reads["version"] = (reads["version"] ?? 0) + 1;
        return "1.0.0";
      },
      get description(): string {
        reads["description"] = (reads["description"] ?? 0) + 1;
        return "Exports a bucket listing.";
      },
      get configParameters(): unknown[] {
        reads["configParameters"] = (reads["configParameters"] ?? 0) + 1;
        return [];
      },
      get execute(): () => Promise<M3LCommandOutcome> {
        reads["execute"] = (reads["execute"] ?? 0) + 1;
        return () => Promise.resolve({ status: "success" });
      },
    };

    expect(isM3LCommandModule(descriptor)).toBe(true);
    for (const [property, count] of Object.entries(reads)) {
      expect({ property, count }).toEqual({ property, count: 1 });
    }
  });

  test("verdicts on the FIRST read of a non-idempotent name getter", () => {
    let reads = 0;
    const descriptor = {
      ...(minimalDescriptor() as object),
      get name(): unknown {
        reads += 1;
        // The first read is a valid string; every later read is not. An
        // implementation that validates `name` and then re-reads it would
        // disagree with itself and return `false`.
        return reads === 1 ? "s3-export" : 42;
      },
    };

    expect(isM3LCommandModule(descriptor)).toBe(true);
    expect(reads).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// isM3LCommandOutcome — the accepting side
// ---------------------------------------------------------------------------

const VALID_OUTCOMES: readonly {
  readonly label: string;
  readonly value: M3LCommandOutcome;
}[] = [
  { label: "success", value: { status: "success" } },
  { label: "dry-run", value: { status: "dry-run" } },
  { label: "interrupted", value: { status: "interrupted" } },
  {
    label: "partial with a positive count",
    value: { status: "partial", recovered: 3 },
  },
  {
    label: "partial with zero recovered",
    value: { status: "partial", recovered: 0 },
  },
  // `NaN` and `Infinity` are accepted for the same reason `-1` and `1.5` are:
  // `recovered` is declared as a bare `number`, and the type system does not
  // distinguish a non-finite `number` from any other one. A `Number.isFinite`
  // check here would be a runtime rule the type explicitly disclaims, so the
  // guard would start rejecting values the compiler hands it.
  {
    label: "partial with a NaN recovered count",
    value: { status: "partial", recovered: Number.NaN },
  },
  {
    label: "partial with an Infinite recovered count",
    value: { status: "partial", recovered: Number.POSITIVE_INFINITY },
  },
  {
    label: "failure carrying a real error",
    value: { status: "failure", error: new Error("boom") },
  },
];

describe("isM3LCommandOutcome — valid outcomes", () => {
  test.each(VALID_OUTCOMES)(
    "accepts $label",
    ({ value }: { readonly value: M3LCommandOutcome }) => {
      expect(isM3LCommandOutcome(value)).toBe(true);
    },
  );

  test("the valid-outcome table enumerates all five status arms", () => {
    const covered = new Set(VALID_OUTCOMES.map((row) => row.value.status));
    expect([...covered].sort()).toEqual([
      "dry-run",
      "failure",
      "interrupted",
      "partial",
      "success",
    ]);
  });

  // The guard accepts what the TYPE accepts, not a stricter runtime rule the
  // type disclaims: `M3LCommandOutcome`'s own TSDoc notes that `-3` and `1.5`
  // compile just as readily as `3`. Inventing a non-negative-integer rule here
  // would make the guard disagree with the compiler.
  test.each([-1, -3, 1.5, 0.5, Number.MAX_SAFE_INTEGER])(
    "accepts a partial outcome whose recovered count is %p — the type admits it",
    (recovered: number) => {
      expect(isM3LCommandOutcome({ status: "partial", recovered })).toBe(true);
    },
  );

  // `error: undefined` is representable: a thrown `undefined` is a real value,
  // and the guard checks presence of the key, never its content.
  test("accepts a failure outcome whose error is undefined but present", () => {
    expect(isM3LCommandOutcome({ status: "failure", error: undefined })).toBe(
      true,
    );
  });

  test("narrows to M3LCommandOutcome for the caller", () => {
    const value: unknown = { status: "partial", recovered: 2 };
    if (isM3LCommandOutcome(value) && value.status === "partial") {
      expect(value.recovered).toBe(2);
    } else {
      expect.unreachable("the partial outcome must pass the guard");
    }
  });
});

// ---------------------------------------------------------------------------
// isM3LCommandOutcome — the rejecting side
// ---------------------------------------------------------------------------

const INVALID_OUTCOMES: readonly {
  readonly label: string;
  readonly make: () => unknown;
}[] = [
  { label: "null", make: () => null },
  { label: "undefined (a missing await)", make: () => undefined },
  { label: "a plain string", make: () => "success" },
  { label: "an array", make: () => [] },
  { label: "an empty object", make: () => ({}) },
  { label: "an out-of-vocabulary status", make: () => ({ status: "bogus" }) },
  { label: "a numeric status", make: () => ({ status: 5 }) },
  {
    label: "a partial outcome with no recovered field",
    make: () => ({ status: "partial" }),
  },
  {
    label: "a partial outcome whose recovered is a string",
    make: () => ({ status: "partial", recovered: "3" }),
  },
  {
    label: "a failure outcome with no error key at all",
    make: () => ({ status: "failure" }),
  },
  {
    label: "an outcome whose status getter throws",
    make: () => ({
      get status(): never {
        throw new Error("boom");
      },
    }),
  },
  {
    label: "a partial outcome whose recovered getter throws",
    make: () => ({
      status: "partial",
      get recovered(): never {
        throw new Error("boom");
      },
    }),
  },
  { label: "a revoked Proxy", make: revokedProxy },
  { label: "a Proxy whose get trap throws for every key", make: hostileProxy },
];

describe("isM3LCommandOutcome — hostile and malformed input", () => {
  test.each(INVALID_OUTCOMES)(
    "rejects $label without throwing",
    ({ make }: { readonly make: () => unknown }) => {
      const value = make();
      expect(() => isM3LCommandOutcome(value)).not.toThrow();
      expect(isM3LCommandOutcome(value)).toBe(false);
    },
  );

  test("the hostile-outcome table names every documented vector", () => {
    expect(new Set(INVALID_OUTCOMES.map((row) => row.label)).size).toBe(
      INVALID_OUTCOMES.length,
    );
  });
});

// ---------------------------------------------------------------------------
// isM3LCommandOutcome — never reads `error`'s value
// ---------------------------------------------------------------------------

describe("isM3LCommandOutcome — the failure arm checks presence, never content", () => {
  // Mirrors `mapCommandOutcomeToExitCode`'s own hostile-getter fix: reading
  // `error` inside a guard that only needs to know the key exists hands a
  // hostile `Proxy` a free re-entry point. `Object.hasOwn` answers the
  // question without touching caller code.
  test("a failure outcome whose error getter throws is still accepted", () => {
    const outcome = {
      status: "failure",
      get error(): never {
        throw new Error("the guard must not read this");
      },
    };

    expect(() => isM3LCommandOutcome(outcome)).not.toThrow();
    expect(isM3LCommandOutcome(outcome)).toBe(true);
  });

  test("does not read `error` at all on a failure outcome", () => {
    let reads = 0;
    const outcome = {
      status: "failure",
      get error(): unknown {
        reads += 1;
        return new Error("boom");
      },
    };

    expect(isM3LCommandOutcome(outcome)).toBe(true);
    expect(reads).toBe(0);
  });

  test("does not read `recovered` at all on a non-partial outcome", () => {
    let reads = 0;
    const outcome = {
      status: "success",
      get recovered(): number {
        reads += 1;
        throw new Error("the success arm must not touch caller data");
      },
    };

    expect(isM3LCommandOutcome(outcome)).toBe(true);
    expect(reads).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// isM3LCommandOutcome — one read per caller-controlled property
// ---------------------------------------------------------------------------

describe("isM3LCommandOutcome — one read per caller-controlled property", () => {
  test("reads `status` exactly once, and verdicts on that first read", () => {
    let reads = 0;
    const outcome = {
      // The first read is in vocabulary; the second is not. A validate-then-
      // re-read implementation would return `false`.
      get status(): string {
        reads += 1;
        return reads === 1 ? "success" : "bogus";
      },
    };

    expect(isM3LCommandOutcome(outcome)).toBe(true);
    expect(reads).toBe(1);
  });

  test("reads `recovered` exactly once on the partial arm", () => {
    let reads = 0;
    const outcome = {
      status: "partial",
      get recovered(): unknown {
        reads += 1;
        return reads === 1 ? 3 : "not a number";
      },
    };

    expect(isM3LCommandOutcome(outcome)).toBe(true);
    expect(reads).toBe(1);
  });
});
