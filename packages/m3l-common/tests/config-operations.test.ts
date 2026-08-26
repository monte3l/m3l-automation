/**
 * Tests for U4 — declarative, enumerable operations in `core/config`
 * (ADR-0055). RED until implemented.
 *
 * Contract source: scratchpad/U4-CONTRACT.md (frozen for this change set).
 *
 * New exports under test (all added to `packages/m3l-common/src/core/config`):
 *   M3LOperationDeclaration (type), M3LOperationDeclarationList (type),
 *   deriveOperationNames, deriveOperationValidators.
 *
 * Plus the surrounding edits this change set makes to already-tested
 * modules: `M3LConfigParameter`'s new `operations` constructor option and
 * `getOperations()` getter, and `M3LConfigHelpFormatter`'s new operations
 * block. Those modules' PRE-EXISTING behavior is covered by
 * `config.test.ts` (untouched here, per the file-budget pin) — this file
 * covers only the NEW `operations` surface area.
 *
 * `scripts/ecs-ops/src/config.ts` is read-only reference material for the
 * fleet-parity cases below (never imported — `m3l-common` does not depend
 * on `scripts/**`); its operation set/order is mirrored as inline literals.
 */

import { describe, expect, expectTypeOf, test, vi } from "vitest";

import {
  deriveOperationNames,
  deriveOperationValidators,
  M3LConfig,
  M3LConfigHelpFormatter,
  M3LConfigMissingError,
  M3LConfigParameter,
  M3LConfigParameterType,
  M3LConfigReader,
  M3LConfigSchema,
  M3LConfigValidationError,
  M3LConfigValidators,
  M3LInMemoryConfigProvider,
} from "../src/core/config/index.js";
import type {
  M3LConfigValidator,
  M3LOperationDeclaration,
  M3LOperationDeclarationList,
} from "../src/core/config/index.js";
import { Core } from "../src/index.js";

// =============================================================================
// M3LOperationDeclaration / M3LOperationDeclarationList — type-level contract
// =============================================================================

describe("M3LOperationDeclaration — type-level contract", () => {
  test("requiredParameters is readonly string[] | undefined", () => {
    expectTypeOf<M3LOperationDeclaration["requiredParameters"]>().toEqualTypeOf<
      readonly string[] | undefined
    >();
  });

  test("operations: [] is a compile error — the non-empty tuple forbids it", () => {
    // @ts-expect-error -- M3LOperationDeclarationList is a non-empty tuple; [] is not assignable
    const empty: M3LOperationDeclarationList = [];
    expect(empty).toBeDefined();
  });

  test("operations type-checks on a STRING parameter, standalone", () => {
    const operations: M3LOperationDeclarationList = [
      { name: "get", description: "Fetch one item by key." },
    ];
    const parameter = new M3LConfigParameter({
      name: "operation",
      type: M3LConfigParameterType.STRING,
      operations,
    });
    // `getOperations()` returns a fresh, normalised projection, not the
    // caller's array by reference — see the dedicated projection-semantics
    // tests below for why. This test's job is the type-check above; content
    // equality is enough to confirm it type-checked and constructed.
    expect(parameter.getOperations()).toEqual(operations);
  });

  test("operations type-checks on a STRING parameter inside a readonly M3LConfigParameter[] annotation (the fleet shape)", () => {
    const operations: M3LOperationDeclarationList = [
      { name: "get", description: "Fetch one item by key." },
    ];
    const parameters: readonly M3LConfigParameter[] = [
      new M3LConfigParameter({
        name: "operation",
        type: M3LConfigParameterType.STRING,
        operations,
      }),
    ];
    expect(parameters).toHaveLength(1);
  });

  test("operations on a non-STRING (INT) parameter is a compile error, and the runtime guard throws M3LConfigValidationError, standalone", () => {
    const operations: M3LOperationDeclarationList = [
      { name: "get", description: "Fetch one item by key." },
    ];
    expect(
      () =>
        new M3LConfigParameter({
          name: "count",
          type: M3LConfigParameterType.INT,
          // @ts-expect-error -- operations requires type STRING; on INT the options field type is `never`
          operations,
        }),
    ).toThrow(M3LConfigValidationError);
  });

  test("operations on a non-STRING (INT) parameter is a compile error, and the runtime guard throws M3LConfigValidationError, inside a readonly M3LConfigParameter[] annotation", () => {
    const operations: M3LOperationDeclarationList = [
      { name: "get", description: "Fetch one item by key." },
    ];
    const build = (): readonly M3LConfigParameter[] => [
      new M3LConfigParameter({
        name: "count",
        type: M3LConfigParameterType.INT,
        // @ts-expect-error -- operations requires type STRING; on INT the options field type is `never`
        operations,
      }),
    ];
    expect(build).toThrow(M3LConfigValidationError);
  });

  test("operations + an explicit validate type-check together", () => {
    const operations: M3LOperationDeclarationList = [
      { name: "get", description: "Fetch one item by key." },
    ];
    const validate: M3LConfigValidator<string> = (value) =>
      value.length > 0 ? true : "must not be empty";
    const parameter = new M3LConfigParameter({
      name: "operation",
      type: M3LConfigParameterType.STRING,
      operations,
      validate,
    });
    // See the projection-semantics tests below: getOperations() no longer
    // returns the caller's array by reference.
    expect(parameter.getOperations()).toEqual(operations);
  });

  test("deriveOperationNames preserves the literal name union", () => {
    // `as const satisfies` (rather than a `: M3LOperationDeclarationList`
    // annotation) keeps the literal "get"/"put" name types intact so
    // `deriveOperationNames`'s `const TName` type parameter can actually
    // infer the literal union — an explicit annotation here would widen
    // both names to `string` before the call ever sees them.
    const operations = [
      { name: "get", description: "Fetch one item by key." },
      { name: "put", description: "Write one item." },
    ] as const satisfies M3LOperationDeclarationList;
    const names = deriveOperationNames(operations);

    type ExpectedNames = readonly [
      "get" | "put",
      ...(readonly ("get" | "put")[]),
    ];
    expectTypeOf(names).toEqualTypeOf<ExpectedNames>();
  });
});

describe("deriveOperationNames — runtime contract", () => {
  test("maps the declaration list to its name list in declaration order, no dedup", () => {
    const operations: M3LOperationDeclarationList = [
      { name: "get", description: "Fetch one item by key." },
      { name: "get", description: "Fetch again — deliberately not deduped." },
      { name: "put", description: "Write one item." },
    ];
    expect(deriveOperationNames(operations)).toEqual(["get", "get", "put"]);
  });

  test("an empty operation list throws M3LConfigValidationError, not a bare TypeError", () => {
    // `M3LOperationDeclarationList` is a non-empty tuple, so `[]` is a
    // compile error (see the type-level test above) — this cast models a
    // plain JavaScript caller bypassing that compile-time guard, the same
    // way the `M3LConfigParameter` malformed-shape tests do elsewhere in
    // this file.
    const empty = [] as unknown as M3LOperationDeclarationList;

    expect(() => deriveOperationNames(empty)).toThrow(M3LConfigValidationError);

    let thrown: unknown;
    try {
      deriveOperationNames(empty);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(M3LConfigValidationError);
    // The regression being locked down: this must never again surface as
    // a bare `TypeError` from destructuring `first` off an empty array.
    expect(thrown).not.toBeInstanceOf(TypeError);
    expect((thrown as M3LConfigValidationError).code).toBe(
      "ERR_CONFIG_VALIDATION",
    );
    expect((thrown as Error).message).toBe(
      "deriveOperationNames received an empty operation list",
    );
  });
});

// =============================================================================
// Serialisability — ADR-0042 discovery-cache constraint
// =============================================================================

describe("operations declaration serialisability (ADR-0042)", () => {
  test("JSON.parse(JSON.stringify(getOperations())) deep-equals the source declaration list, including an entry that omits requiredParameters", () => {
    const operations: M3LOperationDeclarationList = [
      { name: "get", description: "Fetch one item by key." },
      {
        name: "put",
        description: "Write one item.",
        requiredParameters: ["key", "value"],
      },
    ];
    const parameter = new M3LConfigParameter({
      name: "operation",
      type: M3LConfigParameterType.STRING,
      operations,
    });

    const roundTripped: unknown = JSON.parse(
      JSON.stringify(parameter.getOperations()),
    );
    expect(roundTripped).toEqual(operations);
  });
});

// =============================================================================
// M3LConfigParameter.getOperations()
// =============================================================================

describe("M3LConfigParameter.getOperations()", () => {
  test("returns a projection equal in content to the declared operations, but never the caller's array by reference", () => {
    const operations: M3LOperationDeclarationList = [
      { name: "get", description: "Fetch one item by key." },
    ];
    const parameter = new M3LConfigParameter({
      name: "operation",
      type: M3LConfigParameterType.STRING,
      operations,
    });

    // The declared content is still the contract.
    expect(parameter.getOperations()).toEqual(operations);
    // The new contract: this is a fresh, normalised projection, never the
    // caller's own array — see `validateOperationDeclarations`'s TSDoc for
    // why (an accessor property could otherwise pass validation and then
    // hand back something else to a later re-read).
    expect(parameter.getOperations()).not.toBe(operations);
  });

  test("returns undefined when no operations were declared", () => {
    const parameter = new M3LConfigParameter({
      name: "region",
      type: M3LConfigParameterType.STRING,
    });
    expect(parameter.getOperations()).toBeUndefined();
  });

  test("the accessor-property escape is closed: a name re-observed after validation cannot disagree with what was validated", () => {
    // Models a declaration whose `name` is a getter that returns a valid
    // string for validation's read(s) (at most 2, to tolerate either the
    // current or a prior read-count inside `validateOperationEntryShape`),
    // then `undefined` on every subsequent read. Against the old
    // reference-returning `validateOperationDeclarations` (which stored and
    // returned the caller's own entry objects verbatim), `getOperations()`
    // hands back the SAME live-getter object, so `M3LConfigHelpFormatter`'s
    // `operations.map((op) => op.name.length)` re-triggers the getter a
    // third time, observes `undefined`, and throws a bare `TypeError`
    // reading `.length` off it — asserted below via `format(schema)`, which
    // must run first so that TypeError (not a later assertion mismatch) is
    // what fails this test against the old code. The fixed implementation
    // reads `name` at most twice, at validation time, and projects the
    // already-read value into a fresh plain object — so nothing downstream
    // ever re-triggers the getter.
    let reads = 0;
    const entry: unknown = {
      get name(): unknown {
        reads += 1;
        return reads <= 2 ? "get" : undefined;
      },
      description: "Fetch one item by key.",
    };
    // Cast models a plain JavaScript caller bypassing the compile-time
    // M3LOperationDeclarationList shape, per this file's established
    // pattern for malformed/adversarial `operations` fixtures.
    const operations = [entry] as unknown as M3LOperationDeclarationList;

    const parameter = new M3LConfigParameter({
      name: "operation",
      type: M3LConfigParameterType.STRING,
      operations,
    });

    const schema = new M3LConfigSchema([parameter]);
    const formatter = new M3LConfigHelpFormatter();
    let formatted = "";
    expect(() => {
      formatted = formatter.format(schema);
    }).not.toThrow();
    expect(formatted).toContain("get");

    expect(parameter.getOperations()?.[0].name).toBe("get");
  });

  test("mutating the caller's array after construction does not affect the parameter", async () => {
    const operations: M3LOperationDeclarationList = [
      { name: "get", description: "Fetch one item by key." },
    ];
    const parameter = new M3LConfigParameter({
      name: "operation",
      type: M3LConfigParameterType.STRING,
      operations,
    });

    // Cast past the readonly tuple type — the same JavaScript-caller-bypass
    // pattern used elsewhere in this file — to mutate the original array
    // after construction.
    (operations as unknown as M3LOperationDeclaration[]).push({
      name: "put",
      description: "Write one item.",
    });

    expect(parameter.getOperations()).toEqual([
      { name: "get", description: "Fetch one item by key." },
    ]);

    const reader = new M3LConfigReader([
      new M3LInMemoryConfigProvider({ operation: "put" }),
    ]);
    await expect(parameter.getValueAsync(reader)).rejects.toBeInstanceOf(
      M3LConfigValidationError,
    );
  });

  test("the returned projection is deep-frozen: the array, each entry, and a present requiredParameters copy", () => {
    const operations: M3LOperationDeclarationList = [
      {
        name: "get",
        description: "Fetch one item by key.",
        requiredParameters: ["key"],
      },
    ];
    const parameter = new M3LConfigParameter({
      name: "operation",
      type: M3LConfigParameterType.STRING,
      operations,
    });

    const projected = parameter.getOperations();
    expect(projected).toBeDefined();
    expect(Object.isFrozen(projected)).toBe(true);

    const entry = projected?.[0];
    expect(entry).toBeDefined();
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry?.requiredParameters)).toBe(true);
  });

  test("all six existing getters plus isSecret() are unchanged on a declaring parameter", () => {
    const operations: M3LOperationDeclarationList = [
      { name: "get", description: "Fetch one item by key." },
    ];
    const parameter = new M3LConfigParameter({
      name: "operation",
      type: M3LConfigParameterType.STRING,
      aliases: ["op"],
      description: "Which operation to run.",
      required: true,
      secret: false,
      defaultValue: "get",
      operations,
    });

    expect(parameter.getName()).toBe("operation");
    expect(parameter.getAliases()).toEqual(["op"]);
    expect(parameter.getType()).toBe(M3LConfigParameterType.STRING);
    expect(parameter.isRequired()).toBe(true);
    expect(parameter.getDefaultValue()).toBe("get");
    expect(parameter.getDescription()).toBe("Which operation to run.");
    expect(parameter.isSecret()).toBe(false);
  });
});

// =============================================================================
// Derived membership validation
// =============================================================================

describe("derived membership validation", () => {
  const operations: M3LOperationDeclarationList = [
    { name: "get", description: "Fetch one item by key." },
    { name: "put", description: "Write one item." },
  ];

  test("an in-set value resolves", async () => {
    const reader = new M3LConfigReader([
      new M3LInMemoryConfigProvider({ operation: "get" }),
    ]);
    const parameter = new M3LConfigParameter({
      name: "operation",
      type: M3LConfigParameterType.STRING,
      operations,
    });

    await expect(parameter.getValueAsync(reader)).resolves.toBe("get");
  });

  test("an out-of-set value throws M3LConfigValidationError whose reason is M3LConfigValidators.oneOf(names)(value)", async () => {
    const reader = new M3LConfigReader([
      new M3LInMemoryConfigProvider({ operation: "delete" }),
    ]);
    const parameter = new M3LConfigParameter({
      name: "operation",
      type: M3LConfigParameterType.STRING,
      operations,
    });
    const names = operations.map(
      (operation: M3LOperationDeclaration) => operation.name,
    );
    const expectedReason = M3LConfigValidators.oneOf(names)("delete");

    let thrown: unknown;
    try {
      await parameter.getValueAsync(reader);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConfigValidationError);
    expect((thrown as M3LConfigValidationError).context).toEqual({
      parameter: "operation",
      reason: expectedReason,
      valueType: "string",
    });
  });

  test("an out-of-set defaultValue throws eagerly at construction", () => {
    let thrown: unknown;
    try {
      new M3LConfigParameter({
        name: "operation",
        type: M3LConfigParameterType.STRING,
        operations,
        defaultValue: "delete",
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(M3LConfigValidationError);
  });

  test("an out-of-set asyncFallback result throws at getValueAsync", async () => {
    const reader = new M3LConfigReader([new M3LInMemoryConfigProvider({})]);
    const parameter = new M3LConfigParameter({
      name: "operation",
      type: M3LConfigParameterType.STRING,
      operations,
      asyncFallback: () => Promise.resolve("delete"),
    });

    await expect(parameter.getValueAsync(reader)).rejects.toBeInstanceOf(
      M3LConfigValidationError,
    );
  });

  test("required: true with no value anywhere still throws M3LConfigMissingError (missing beats membership)", async () => {
    const reader = new M3LConfigReader([new M3LInMemoryConfigProvider({})]);
    const parameter = new M3LConfigParameter({
      name: "operation",
      type: M3LConfigParameterType.STRING,
      operations,
      required: true,
    });

    await expect(parameter.getValueAsync(reader)).rejects.toBeInstanceOf(
      M3LConfigMissingError,
    );
  });
});

// =============================================================================
// Composition with an explicit `validate`
// =============================================================================

describe("composition with an explicit validate", () => {
  const operations: M3LOperationDeclarationList = [
    { name: "get", description: "Fetch one item by key." },
    { name: "put", description: "Write one item." },
  ];

  test("membership and explicit validate both pass -> resolves", async () => {
    const explicit = vi.fn((value: string): true | string =>
      value === "get" ? true : "must be get",
    );
    const reader = new M3LConfigReader([
      new M3LInMemoryConfigProvider({ operation: "get" }),
    ]);
    const parameter = new M3LConfigParameter({
      name: "operation",
      type: M3LConfigParameterType.STRING,
      operations,
      validate: explicit,
    });

    await expect(parameter.getValueAsync(reader)).resolves.toBe("get");
    expect(explicit).toHaveBeenCalledWith("get");
  });

  test("an explicit validator rejecting an in-set value surfaces its own reason", async () => {
    const explicit: M3LConfigValidator<string> = (value) =>
      value === "get" ? "get is disabled today" : true;
    const reader = new M3LConfigReader([
      new M3LInMemoryConfigProvider({ operation: "get" }),
    ]);
    const parameter = new M3LConfigParameter({
      name: "operation",
      type: M3LConfigParameterType.STRING,
      operations,
      validate: explicit,
    });

    let thrown: unknown;
    try {
      await parameter.getValueAsync(reader);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConfigValidationError);
    expect((thrown as M3LConfigValidationError).context).toMatchObject({
      reason: "get is disabled today",
    });
  });

  test("load-bearing: an explicit oneOf naming an extra value beyond the declared set still rejects that value, with the membership reason", async () => {
    const explicitOneOf = M3LConfigValidators.oneOf(["get", "put", "delete"]);
    const reader = new M3LConfigReader([
      new M3LInMemoryConfigProvider({ operation: "delete" }),
    ]);
    const parameter = new M3LConfigParameter({
      name: "operation",
      type: M3LConfigParameterType.STRING,
      operations,
      validate: explicitOneOf,
    });
    const membershipReason = M3LConfigValidators.oneOf(
      operations.map((operation: M3LOperationDeclaration) => operation.name),
    )("delete");

    let thrown: unknown;
    try {
      await parameter.getValueAsync(reader);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConfigValidationError);
    expect((thrown as M3LConfigValidationError).context).toMatchObject({
      reason: membershipReason,
    });
  });

  test("a redundant identical oneOf is a no-op", async () => {
    const redundant = M3LConfigValidators.oneOf(["get", "put"]);
    const reader = new M3LConfigReader([
      new M3LInMemoryConfigProvider({ operation: "get" }),
    ]);
    const parameter = new M3LConfigParameter({
      name: "operation",
      type: M3LConfigParameterType.STRING,
      operations,
      validate: redundant,
    });

    await expect(parameter.getValueAsync(reader)).resolves.toBe("get");
  });
});

// =============================================================================
// Declaration boundary, adversarial
// =============================================================================

describe("declaration boundary, adversarial", () => {
  test("a duplicate operation name throws M3LConfigValidationError coded ERR_CONFIG_VALIDATION", () => {
    let thrown: unknown;
    try {
      new M3LConfigParameter({
        name: "operation",
        type: M3LConfigParameterType.STRING,
        operations: [
          { name: "get", description: "Fetch one item by key." },
          { name: "get", description: "Fetch again." },
        ],
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(M3LConfigValidationError);
    expect((thrown as M3LConfigValidationError).code).toBe(
      "ERR_CONFIG_VALIDATION",
    );
  });

  test("a blank/whitespace-only operation name throws M3LConfigValidationError", () => {
    expect(
      () =>
        new M3LConfigParameter({
          name: "operation",
          type: M3LConfigParameterType.STRING,
          operations: [{ name: "   ", description: "Blank name." }],
        }),
    ).toThrow(M3LConfigValidationError);
  });

  test("a blank/whitespace-only operation description throws M3LConfigValidationError", () => {
    expect(
      () =>
        new M3LConfigParameter({
          name: "operation",
          type: M3LConfigParameterType.STRING,
          operations: [{ name: "get", description: "   " }],
        }),
    ).toThrow(M3LConfigValidationError);
  });

  test("operations: [] forced past the tuple type throws — models a JavaScript caller bypassing the compile-time guard", () => {
    expect(
      () =>
        new M3LConfigParameter({
          name: "operation",
          type: M3LConfigParameterType.STRING,
          // Cast bypasses the non-empty-tuple type: a plain JavaScript
          // caller has no `tsc` enforcing the tuple, so the runtime guard is
          // the only thing that catches this.
          operations: [] as unknown as M3LOperationDeclarationList,
        }),
    ).toThrow(M3LConfigValidationError);
  });

  test("an INT parameter declaring operations (bypassing the type guard via a cast) throws M3LConfigValidationError at construction", () => {
    const bypassed = {
      name: "count",
      type: M3LConfigParameterType.INT,
      operations: [{ name: "get", description: "Fetch one item by key." }],
    } as unknown as ConstructorParameters<typeof M3LConfigParameter>[0];

    expect(() => new M3LConfigParameter(bypassed)).toThrow(
      M3LConfigValidationError,
    );
  });

  test("'__proto__' and 'constructor' operation names behave as ordinary strings: accepted when declared, rejected when not — nothing is read off Object.prototype", async () => {
    const operations: M3LOperationDeclarationList = [
      { name: "__proto__", description: "Ordinary string operation." },
      { name: "constructor", description: "Also an ordinary string." },
    ];
    const parameter = new M3LConfigParameter({
      name: "operation",
      type: M3LConfigParameterType.STRING,
      operations,
    });

    const protoReader = new M3LConfigReader([
      new M3LInMemoryConfigProvider({ operation: "__proto__" }),
    ]);
    await expect(parameter.getValueAsync(protoReader)).resolves.toBe(
      "__proto__",
    );

    const ctorReader = new M3LConfigReader([
      new M3LInMemoryConfigProvider({ operation: "constructor" }),
    ]);
    await expect(parameter.getValueAsync(ctorReader)).resolves.toBe(
      "constructor",
    );

    // "toString" is an Object.prototype member but is NOT a declared
    // operation — an implementation that read membership off the array as
    // an object index (rather than Array.includes) could resolve this
    // wrongly instead of rejecting it.
    const undeclaredReader = new M3LConfigReader([
      new M3LInMemoryConfigProvider({ operation: "toString" }),
    ]);
    await expect(
      parameter.getValueAsync(undeclaredReader),
    ).rejects.toBeInstanceOf(M3LConfigValidationError);
  });

  test("a declaration object whose name is a throwing getter propagates the throw rather than half-constructing", () => {
    class NameGetterError extends Error {}
    const throwingOperation = {
      get name(): string {
        throw new NameGetterError("boom");
      },
      description: "d",
    };

    expect(
      () =>
        new M3LConfigParameter({
          name: "operation",
          type: M3LConfigParameterType.STRING,
          operations: [
            throwingOperation,
          ] as unknown as M3LOperationDeclarationList,
        }),
    ).toThrow(NameGetterError);
  });
});

// =============================================================================
// Malformed `operations` shapes (silent-failure audit) — every case below
// models a plain-JavaScript caller with no `tsc` enforcing
// M3LOperationDeclarationList, via a cast. Before this audit's fix, each of
// these escaped construction as a bare, untyped TypeError instead of the
// documented M3LConfigValidationError (code ERR_CONFIG_VALIDATION).
// =============================================================================

/**
 * Constructs an `operation`-named STRING parameter with `operations` cast
 * past its declared type, and returns whatever it throws (or `undefined` if
 * construction did not throw).
 */
function constructWithMalformedOperations(operations: unknown): unknown {
  let thrown: unknown;
  try {
    new M3LConfigParameter({
      name: "operation",
      type: M3LConfigParameterType.STRING,
      // Cast models a plain JavaScript caller with no `tsc` enforcing the
      // M3LOperationDeclarationList shape.
      operations: operations as M3LOperationDeclarationList,
    });
  } catch (error) {
    thrown = error;
  }
  return thrown;
}

/**
 * Asserts `operations` throws the documented, typed failure — never the
 * pre-fix bare `TypeError` — with the exact message the fix is specified to
 * produce.
 */
function expectMalformedOperationsError(
  operations: unknown,
  expectedMessage: string,
): void {
  const thrown = constructWithMalformedOperations(operations);
  expect(thrown).toBeInstanceOf(M3LConfigValidationError);
  expect(thrown).not.toBeInstanceOf(TypeError);
  expect((thrown as M3LConfigValidationError).code).toBe(
    "ERR_CONFIG_VALIDATION",
  );
  expect((thrown as Error).message).toBe(expectedMessage);
}

describe("malformed operations shapes throw M3LConfigValidationError, never a bare TypeError", () => {
  test("a non-array operations object throws (not a TypeError from a missing .length/iteration)", () => {
    expectMalformedOperationsError(
      { name: "get", description: "d" },
      "configuration parameter 'operation' declares operations that are not an array",
    );
  });

  test("operations: [null] throws (not a TypeError reading .name off null)", () => {
    expectMalformedOperationsError(
      [null],
      "configuration parameter 'operation' declares a non-object operation",
    );
  });

  test("operations: [undefined] throws (not a TypeError reading .name off undefined)", () => {
    expectMalformedOperationsError(
      [undefined],
      "configuration parameter 'operation' declares a non-object operation",
    );
  });

  test("a non-string operation name throws (not a TypeError calling .trim() on a number)", () => {
    expectMalformedOperationsError(
      [{ name: 123, description: "d" }],
      "configuration parameter 'operation' declares an operation with a non-string name",
    );
  });

  test("a missing operation description throws (not a TypeError calling .trim() on undefined)", () => {
    expectMalformedOperationsError(
      [{ name: "get" }],
      "configuration parameter 'operation' declares an operation with a non-string description: 'get'",
    );
  });

  test("a non-string operation description throws (not a TypeError calling .trim() on a number)", () => {
    expectMalformedOperationsError(
      [{ name: "get", description: 42 }],
      "configuration parameter 'operation' declares an operation with a non-string description: 'get'",
    );
  });

  test("a non-array requiredParameters throws (not a TypeError iterating a number)", () => {
    expectMalformedOperationsError(
      [{ name: "get", description: "d", requiredParameters: 42 }],
      "configuration parameter 'operation' declares an operation with non-array requiredParameters: 'get'",
    );
  });

  // Dedicated case: a bare string is iterable, so the pre-fix code walked it
  // character-by-character ('c', 'l', 'u', ...) as if each character were a
  // separate required-parameter name, surfacing the misleading
  // "requiring unknown parameter 'l'" — a shape error, not a per-character
  // iteration, is now expected at construction instead.
  test("requiredParameters as a bare string (not a one-element list) throws a shape error, not a per-character 'unknown parameter' error", () => {
    const thrown = constructWithMalformedOperations([
      { name: "get", description: "d", requiredParameters: "cluster" },
    ]);
    expect(thrown).toBeInstanceOf(M3LConfigValidationError);
    expect(thrown).not.toBeInstanceOf(TypeError);
    expect((thrown as M3LConfigValidationError).code).toBe(
      "ERR_CONFIG_VALIDATION",
    );
    expect((thrown as Error).message).toBe(
      "configuration parameter 'operation' declares an operation with non-array requiredParameters: 'get'",
    );
    expect((thrown as Error).message).not.toContain("unknown parameter");
  });

  test("a non-string requiredParameters entry throws (not a TypeError resolving a number as a parameter name)", () => {
    expectMalformedOperationsError(
      [{ name: "get", description: "d", requiredParameters: [42] }],
      "configuration parameter 'operation' declares an operation with a non-string required parameter: 'get'",
    );
  });
});

// =============================================================================
// Validation ordering — shape checks must run before blank/duplicate checks
// (otherwise .trim() is called on a non-string, throwing a raw TypeError
// before the typed shape guard ever gets a chance to fire).
// =============================================================================

describe("operation entry validation ordering", () => {
  test("an entry that is both non-string-named AND would collide as a 'duplicate' reports the non-string-name error, not a duplicate error", () => {
    const thrown = constructWithMalformedOperations([
      { name: 123, description: "First." },
      { name: 123, description: "Second." },
    ]);

    expect(thrown).toBeInstanceOf(M3LConfigValidationError);
    expect(thrown).not.toBeInstanceOf(TypeError);
    expect((thrown as Error).message).toBe(
      "configuration parameter 'operation' declares an operation with a non-string name",
    );
    expect((thrown as Error).message).not.toContain("duplicate");
  });
});

// =============================================================================
// deriveOperationValidators — happy path + grouping + ordering
//
// The fixture below mirrors scripts/ecs-ops/src/config.ts's `operation`
// parameter (ECS_OPERATIONS) and its four requiredForOperations() guards
// (cluster/service/services/input) — read-only reference, never imported.
// =============================================================================

const ECS_LIKE_OPERATIONS: M3LOperationDeclarationList = [
  { name: "list-services", description: "List running services." },
  {
    name: "describe-service",
    description: "Describe one service.",
    requiredParameters: ["cluster", "service"],
  },
  {
    name: "create-service",
    description: "Create a service.",
    requiredParameters: ["input"],
  },
  {
    name: "update-service",
    description: "Update a service.",
    requiredParameters: ["input"],
  },
  {
    name: "delete-service",
    description: "Delete a service.",
    requiredParameters: ["cluster", "service"],
  },
  {
    name: "wait-services-stable",
    description: "Wait for services to stabilize.",
    requiredParameters: ["cluster", "services"],
  },
  { name: "list-clusters", description: "List clusters." },
  {
    name: "describe-cluster",
    description: "Describe one cluster.",
    requiredParameters: ["cluster"],
  },
];

function buildEcsLikeParameters(): readonly M3LConfigParameter[] {
  return [
    new M3LConfigParameter({
      name: "operation",
      type: M3LConfigParameterType.STRING,
      operations: ECS_LIKE_OPERATIONS,
    }),
    new M3LConfigParameter({
      name: "cluster",
      type: M3LConfigParameterType.STRING,
    }),
    new M3LConfigParameter({
      name: "service",
      type: M3LConfigParameterType.STRING,
    }),
    new M3LConfigParameter({
      name: "services",
      type: M3LConfigParameterType.STRING,
    }),
    new M3LConfigParameter({
      name: "input",
      type: M3LConfigParameterType.STRING,
    }),
  ];
}

describe("deriveOperationValidators", () => {
  test("returns [] when no parameter declares operations", () => {
    const parameters = [
      new M3LConfigParameter({
        name: "region",
        type: M3LConfigParameterType.STRING,
      }),
    ];
    expect(deriveOperationValidators(parameters)).toEqual([]);
  });

  test("vacuous pass when the selector is unset", () => {
    const [clusterValidator] = deriveOperationValidators(
      buildEcsLikeParameters(),
    );
    if (clusterValidator === undefined) throw new Error("validator missing");

    const config = new M3LConfig();
    expect(clusterValidator(config)).toBe(true);
  });

  test("vacuous pass when the current operation does not require the parameter", () => {
    const [clusterValidator] = deriveOperationValidators(
      buildEcsLikeParameters(),
    );
    if (clusterValidator === undefined) throw new Error("validator missing");

    const config = new M3LConfig();
    config.set("operation", "list-services");
    expect(clusterValidator(config)).toBe(true);
  });

  test("correct failure reason when the current operation requires the unset parameter", () => {
    const [clusterValidator] = deriveOperationValidators(
      buildEcsLikeParameters(),
    );
    if (clusterValidator === undefined) throw new Error("validator missing");

    const config = new M3LConfig();
    config.set("operation", "wait-services-stable");
    expect(clusterValidator(config)).toBe(
      "'cluster' is required for operation(s): describe-service, delete-service, wait-services-stable, describe-cluster",
    );
  });

  test("grouping: two operations requiring the same parameter produce ONE validator naming both, in declaration order", () => {
    const validators = deriveOperationValidators(buildEcsLikeParameters());
    const serviceValidator = validators[1];
    if (serviceValidator === undefined) throw new Error("validator missing");

    const config = new M3LConfig();
    config.set("operation", "delete-service");
    expect(serviceValidator(config)).toBe(
      "'service' is required for operation(s): describe-service, delete-service",
    );
  });

  test("deterministic emission order: cluster, service, input, services — first-encounter order walking operations in declaration order", () => {
    const validators = deriveOperationValidators(buildEcsLikeParameters());
    expect(validators).toHaveLength(4);

    const failureFor = (index: number, operation: string): unknown => {
      const validator = validators[index];
      if (validator === undefined) throw new Error("validator missing");
      const config = new M3LConfig();
      config.set("operation", operation);
      return validator(config);
    };

    expect(failureFor(0, "describe-service")).toContain("'cluster'");
    expect(failureFor(1, "describe-service")).toContain("'service'");
    expect(failureFor(2, "create-service")).toContain("'input'");
    expect(failureFor(3, "wait-services-stable")).toContain("'services'");
  });

  test("returns a fresh array on every call", () => {
    const parameters = buildEcsLikeParameters();
    const first = deriveOperationValidators(parameters);
    const second = deriveOperationValidators(parameters);

    expect(first).not.toBe(second);
    expect(first).toHaveLength(second.length);
  });

  test("end-to-end through the real seam: new M3LConfigSchema(params, deriveOperationValidators(params)).validate(config) throws with { validatorIndex, reason }", () => {
    const parameters = buildEcsLikeParameters();
    const schema = new M3LConfigSchema(
      parameters,
      deriveOperationValidators(parameters),
    );
    const config = new M3LConfig();
    config.set("operation", "create-service");

    let thrown: unknown;
    try {
      schema.validate(config);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConfigValidationError);
    // input is the 3rd emitted validator (index 2): cluster, service, input, services.
    expect((thrown as M3LConfigValidationError).context).toEqual({
      validatorIndex: 2,
      reason:
        "'input' is required for operation(s): create-service, update-service",
    });
  });

  test("fleet parity: the derived 'cluster' reason matches scripts/ecs-ops/src/config.ts's requiredForOperations() output byte-for-byte", () => {
    const [clusterValidator] = deriveOperationValidators(
      buildEcsLikeParameters(),
    );
    if (clusterValidator === undefined) throw new Error("validator missing");

    const config = new M3LConfig();
    config.set("operation", "describe-service");
    expect(clusterValidator(config)).toBe(
      "'cluster' is required for operation(s): describe-service, delete-service, wait-services-stable, describe-cluster",
    );
  });
});

// =============================================================================
// deriveOperationValidators, adversarial
// =============================================================================

describe("deriveOperationValidators, adversarial", () => {
  test("an undeclared requiredParameters entry throws at derive time", () => {
    const parameters = [
      new M3LConfigParameter({
        name: "operation",
        type: M3LConfigParameterType.STRING,
        operations: [
          {
            name: "op",
            description: "d",
            requiredParameters: ["doesNotExist"],
          },
        ],
      }),
    ];

    expect(() => deriveOperationValidators(parameters)).toThrow(
      M3LConfigValidationError,
    );
  });

  test("a requiredParameters entry naming a declared alias resolves to the canonical key, and fails when the canonical value is unset (M3LScriptConfigLoader.ts:87 trap)", () => {
    const parameters = [
      new M3LConfigParameter({
        name: "operation",
        type: M3LConfigParameterType.STRING,
        operations: [
          {
            name: "op",
            description: "d",
            requiredParameters: ["clusterAlias"],
          },
        ],
      }),
      new M3LConfigParameter({
        name: "cluster",
        type: M3LConfigParameterType.STRING,
        aliases: ["clusterAlias"],
      }),
    ];
    const [validator] = deriveOperationValidators(parameters);
    if (validator === undefined) throw new Error("validator missing");

    // Resolves to the CANONICAL name: setting only the canonical value
    // (never the alias) satisfies the guard.
    const passingConfig = new M3LConfig();
    passingConfig.set("operation", "op");
    passingConfig.set("cluster", "prod");
    expect(validator(passingConfig)).toBe(true);

    // Leaving the canonical value unset still fails — a validator that
    // literally used the alias string "clusterAlias" as its lookup key
    // (never resolving it) would ALSO fail here, so the passing case above
    // is what actually discriminates correct resolution from the trap.
    const failingConfig = new M3LConfig();
    failingConfig.set("operation", "op");
    expect(validator(failingConfig)).toBe(
      "'cluster' is required for operation(s): op",
    );
  });

  test("a non-string value stored under the selector key passes vacuously with no TypeError", () => {
    const [clusterValidator] = deriveOperationValidators(
      buildEcsLikeParameters(),
    );
    if (clusterValidator === undefined) throw new Error("validator missing");

    const config = new M3LConfig();
    config.set("operation", 42);
    expect(() => clusterValidator(config)).not.toThrow();
    expect(clusterValidator(config)).toBe(true);
  });

  test("the reason string never contains a resolved config value", () => {
    const [clusterValidator] = deriveOperationValidators(
      buildEcsLikeParameters(),
    );
    if (clusterValidator === undefined) throw new Error("validator missing");

    const config = new M3LConfig();
    config.set("operation", "describe-service");
    config.set("service", "top-secret-service-name");

    const reason = clusterValidator(config);
    expect(typeof reason).toBe("string");
    expect(reason).not.toContain("top-secret-service-name");
  });
});

// =============================================================================
// deriveOperationValidators — alias-collision misroute (silent-failure
// audit). `resolveCanonicalName` must resolve a `requiredParameters` entry
// to an EXACT canonical-name match anywhere in the parameter list before
// ever falling back to an alias match — a one-pass `.find()` that returns
// whichever parameter comes first in the array can misroute to an
// unrelated parameter that merely happens to declare the real name as one
// of ITS aliases.
// =============================================================================

describe("deriveOperationValidators — alias-collision misroute", () => {
  // Order is the whole point here — do not reorder this list. `region` (an
  // unrelated, accidental alias-holder) is declared FIRST; the real,
  // canonically-named `cluster` parameter is declared LAST. A one-pass
  // resolver that takes the first array match would misroute
  // `requiredParameters: ["cluster"]` to `region` instead.
  function buildAliasCollisionParameters(): readonly M3LConfigParameter[] {
    return [
      new M3LConfigParameter({
        name: "region",
        type: M3LConfigParameterType.STRING,
        aliases: ["cluster"],
      }),
      new M3LConfigParameter({
        name: "operation",
        type: M3LConfigParameterType.STRING,
        operations: [
          {
            name: "describe-service",
            description: "Describe one service.",
            requiredParameters: ["cluster"],
          },
        ],
      }),
      new M3LConfigParameter({
        name: "cluster",
        type: M3LConfigParameterType.STRING,
      }),
    ];
  }

  test("resolves to the canonically-named 'cluster', not the alias-holding 'region' — failing (never a silent vacuous pass) even when 'region' IS set and the real 'cluster' is completely unset", () => {
    const [validator] = deriveOperationValidators(
      buildAliasCollisionParameters(),
    );
    if (validator === undefined) throw new Error("validator missing");

    const config = new M3LConfig();
    config.set("operation", "describe-service");
    // `region` is deliberately SET — this is exactly what makes the old
    // one-pass misroute dangerous: it resolves to `region`, sees it IS set,
    // and reports a silent vacuous pass while `cluster` (never set below)
    // was the parameter actually required.
    config.set("region", "us-east-1");

    const result = validator(config);
    expect(result).not.toBe(true);
    expect(result).toBe(
      "'cluster' is required for operation(s): describe-service",
    );
    expect(result).not.toContain("region");
  });

  test("passes once the real 'cluster' (not 'region') is set", () => {
    const [validator] = deriveOperationValidators(
      buildAliasCollisionParameters(),
    );
    if (validator === undefined) throw new Error("validator missing");

    const config = new M3LConfig();
    config.set("operation", "describe-service");
    config.set("cluster", "prod");

    expect(validator(config)).toBe(true);
  });

  test("mirror case: an entry naming an alias that collides with nothing still resolves to its owning parameter's canonical name (the two-pass fix must not break plain alias resolution)", () => {
    const parameters = [
      new M3LConfigParameter({
        name: "operation",
        type: M3LConfigParameterType.STRING,
        operations: [
          {
            name: "op",
            description: "d",
            requiredParameters: ["clusterAlias"],
          },
        ],
      }),
      new M3LConfigParameter({
        name: "cluster",
        type: M3LConfigParameterType.STRING,
        aliases: ["clusterAlias"],
      }),
    ];
    const [validator] = deriveOperationValidators(parameters);
    if (validator === undefined) throw new Error("validator missing");

    const config = new M3LConfig();
    config.set("operation", "op");

    expect(validator(config)).toBe(
      "'cluster' is required for operation(s): op",
    );
  });
});

// =============================================================================
// M3LConfigHelpFormatter — operations block
// =============================================================================

describe("M3LConfigHelpFormatter — operations block", () => {
  test("renders the operations block per the exact formatting rules", () => {
    const operations: M3LOperationDeclarationList = [
      {
        name: "list-clusters",
        description: "List all available clusters.",
      },
      {
        name: "get",
        description: "Fetch.",
        requiredParameters: ["key"],
      },
    ];
    const schema = new M3LConfigSchema([
      new M3LConfigParameter({
        name: "operation",
        type: M3LConfigParameterType.STRING,
        description: "Which operation this run performs.",
        required: true,
        operations,
      }),
    ]);
    const formatter = new M3LConfigHelpFormatter();

    const output = formatter.format(schema);
    const lines = output.split("\n");

    // nameWidth = 13 (length of "list-clusters"); descWidth = 28 (length of
    // "List all available clusters.") — the longer entry needs no padding
    // itself, which is why it was placed first (easy to verify by eye).
    const nameWidth = 13;
    const descWidth = 28;

    expect(lines[0]).toBe("--operation <STRING> (required)");
    expect(lines[1]).toBe("    Which operation this run performs.");
    expect(lines[2]).toBe("    operations:");
    expect(lines[3]).toBe(
      `      ${"list-clusters".padEnd(nameWidth)}  List all available clusters.`,
    );
    expect(lines[4]).toBe(
      `      ${"get".padEnd(nameWidth)}  ${"Fetch.".padEnd(descWidth)}  requires: key`,
    );
    expect(lines).toHaveLength(5);

    for (const line of lines) {
      expect(line).not.toMatch(/[ \t]$/);
    }
  });

  test("no rendered line ends in whitespace when requiredParameters is absent (no requires: cell, no padding added)", () => {
    const operations: M3LOperationDeclarationList = [
      { name: "get", description: "Fetch one item." },
    ];
    const schema = new M3LConfigSchema([
      new M3LConfigParameter({
        name: "operation",
        type: M3LConfigParameterType.STRING,
        operations,
      }),
    ]);
    const output = new M3LConfigHelpFormatter().format(schema);
    const lines = output.split("\n");

    for (const line of lines) {
      expect(line).not.toMatch(/[ \t]$/);
    }
    expect(lines.at(-1)).toBe("      get  Fetch one item.");
  });

  test("omits the operations block entirely for a non-declaring parameter (byte-identical to today's output — regression guard)", () => {
    const schema = new M3LConfigSchema([
      new M3LConfigParameter({
        name: "region",
        type: M3LConfigParameterType.STRING,
        description: "AWS region.",
        required: true,
      }),
    ]);
    const output = new M3LConfigHelpFormatter().format(schema);

    expect(output).toBe("--region <STRING> (required)\n    AWS region.");
    expect(output).not.toContain("operations:");
  });

  test("requires: is omitted when requiredParameters is absent", () => {
    const operations: M3LOperationDeclarationList = [
      { name: "get", description: "Fetch." },
    ];
    const schema = new M3LConfigSchema([
      new M3LConfigParameter({
        name: "operation",
        type: M3LConfigParameterType.STRING,
        operations,
      }),
    ]);
    const output = new M3LConfigHelpFormatter().format(schema);
    expect(output).not.toContain("requires:");
  });

  test("requires: is omitted when requiredParameters is an empty array", () => {
    const operations = [
      { name: "get", description: "Fetch.", requiredParameters: [] },
    ] as unknown as M3LOperationDeclarationList;
    const schema = new M3LConfigSchema([
      new M3LConfigParameter({
        name: "operation",
        type: M3LConfigParameterType.STRING,
        operations,
      }),
    ]);
    const output = new M3LConfigHelpFormatter().format(schema);
    expect(output).not.toContain("requires:");
  });
});

// =============================================================================
// Barrel reachability — the 4 new symbols resolve through ../src/index.js
// =============================================================================

/**
 * Reads a value off a namespace object by string key, without a static
 * property-access type dependency. Mirrors `tests/index.test.ts`'s
 * `readNamespaceMember`: a static `Core.deriveOperationNames` access would
 * fail this whole file at `tsc` time the moment ANY of the four new symbols
 * is missing from the barrel, instead of failing just the one targeted
 * assertion for the right reason.
 */
function readNamespaceMember(namespace: object, key: string): unknown {
  return (namespace as Record<string, unknown>)[key];
}

describe("barrel reachability", () => {
  test("deriveOperationNames is reachable through the public namespace (submodule core/config)", () => {
    expect(typeof readNamespaceMember(Core, "deriveOperationNames")).toBe(
      "function",
    );
  });

  test("deriveOperationValidators is reachable through the public namespace (submodule core/config)", () => {
    expect(typeof readNamespaceMember(Core, "deriveOperationValidators")).toBe(
      "function",
    );
  });

  test("type-level: M3LOperationDeclaration and M3LOperationDeclarationList resolve through the Core namespace", () => {
    const declaration: Core.M3LOperationDeclaration = {
      name: "get",
      description: "Fetch one item by key.",
    };
    const list: Core.M3LOperationDeclarationList = [declaration];
    expect(list).toHaveLength(1);
  });
});
