import { describe, expect, test } from "vitest";

import type {
  M3LCliOperationDescriptor,
  M3LCliParameterDescriptor,
} from "../src/discovery/load-config.js";
import {
  collectScopedParameterNames,
  isRequiredForOperation,
  resolveCanonicalName,
  shouldPromptParameter,
} from "../src/commands/wizard-operations.js";

/**
 * Contract: `src/commands/wizard-operations.ts` (m3l-cli U8 PR2, issue #532) —
 * pure helpers that scope the interactive wizard's per-parameter prompting by
 * the chosen operation (ADR-0055). `resolveCanonicalName` mirrors
 * `core/config/deriveOperationValidators`'s exact-name-first, two-pass
 * alias resolution; `collectScopedParameterNames` unions every declared
 * operation's resolved `requiredParameters`; `shouldPromptParameter` and
 * `isRequiredForOperation` apply that union against one descriptor and the
 * caller's chosen operation.
 */

/** Builds a minimal `M3LCliParameterDescriptor` fixture; only `name` is required. */
function makeDescriptor(
  overrides: Partial<M3LCliParameterDescriptor> &
    Pick<M3LCliParameterDescriptor, "name">,
): M3LCliParameterDescriptor {
  return {
    aliases: [],
    type: "STRING",
    required: false,
    defaultValue: undefined,
    description: "",
    secret: false,
    operations: [],
    ...overrides,
  };
}

/** Builds a minimal `M3LCliOperationDescriptor` fixture; only `name` is required. */
function makeOperation(
  overrides: Partial<M3LCliOperationDescriptor> &
    Pick<M3LCliOperationDescriptor, "name">,
): M3LCliOperationDescriptor {
  return {
    description: "",
    requiredParameters: [],
    ...overrides,
  };
}

describe("resolveCanonicalName", () => {
  test("resolves an entry naming a descriptor's own canonical name (exact match)", () => {
    const descriptors = [
      makeDescriptor({ name: "key" }),
      makeDescriptor({ name: "bucket" }),
    ];

    expect(resolveCanonicalName(descriptors, "key")).toBe("key");
  });

  test("resolves an entry naming a descriptor's declared alias", () => {
    const descriptors = [
      makeDescriptor({ name: "key", aliases: ["k", "objectKey"] }),
    ];

    expect(resolveCanonicalName(descriptors, "objectKey")).toBe("key");
  });

  test("[collision] an exact canonical-name match always wins over another descriptor's alias, regardless of declaration order", () => {
    // Descriptor B declares "target" as one of its OWN aliases, while
    // descriptor A is canonically named "target" itself. A single combined
    // pass (name-or-alias) could misroute to B if B is checked first; the
    // exact-name pass must resolve to A unconditionally.
    const descriptorB = makeDescriptor({
      name: "targetAlias",
      aliases: ["target"],
    });
    const descriptorA = makeDescriptor({ name: "target" });
    const descriptors = [descriptorB, descriptorA];

    expect(resolveCanonicalName(descriptors, "target")).toBe("target");
  });

  test("returns undefined when no descriptor matches by name or alias", () => {
    const descriptors = [makeDescriptor({ name: "key" })];

    expect(resolveCanonicalName(descriptors, "nonexistent")).toBeUndefined();
  });

  test("treats a malformed string aliases field as no aliases, resolving to the correct value rather than a coincidental match", () => {
    // `aliases` is declared `readonly string[]`, but this simulates a
    // malformed script export bypassing the type system (the cast convention
    // `tests/load-config.test.ts` already uses for duck-typed input). The
    // malformed value is deliberately a STRING containing the lookup name:
    // `String.prototype.includes` also exists, so without the
    // `Array.isArray` guard `"objectKey".includes("objectKey")` would
    // wrongly resolve to `"bucket"` instead of `undefined`. A string can
    // never trigger a raw crash here (it always has its own `.includes`), so
    // this case only proves value-correctness — see the `null` case below
    // for the crash-prevention half of the guard.
    const malformedDescriptor = {
      ...makeDescriptor({ name: "bucket" }),
      aliases: "objectKey",
    } as unknown as M3LCliParameterDescriptor;
    const descriptors = [malformedDescriptor];

    expect(resolveCanonicalName(descriptors, "objectKey")).toBeUndefined();
  });

  test("treats a malformed null aliases field as no aliases, returning undefined rather than throwing", () => {
    // `null` is the realistic duck-typed-export failure mode (a script
    // accidentally assigning `aliases: null` instead of omitting the field
    // or using `[]`). Unlike a string, `null` has no `.includes` method at
    // all: without the `Array.isArray` guard,
    // `descriptor.aliases.includes(name)` throws a raw `TypeError` here —
    // this fixture is the one that actually discriminates the guard's
    // crash-prevention behavior, not just its value-correctness.
    const malformedDescriptor = {
      ...makeDescriptor({ name: "bucket" }),
      aliases: null,
    } as unknown as M3LCliParameterDescriptor;
    const descriptors = [malformedDescriptor];

    expect(() => resolveCanonicalName(descriptors, "objectKey")).not.toThrow();
    expect(resolveCanonicalName(descriptors, "objectKey")).toBeUndefined();
  });
});

describe("collectScopedParameterNames", () => {
  const keyDescriptor = makeDescriptor({ name: "key", aliases: ["k"] });
  const bucketDescriptor = makeDescriptor({ name: "bucket" });
  const tokenDescriptor = makeDescriptor({ name: "token" });
  const regionDescriptor = makeDescriptor({ name: "region" });
  const descriptors = [
    keyDescriptor,
    bucketDescriptor,
    tokenDescriptor,
    regionDescriptor,
  ];

  test("a single operation's requiredParameters resolve into the returned set", () => {
    const operations = [
      makeOperation({ name: "get", requiredParameters: ["key"] }),
    ];

    const scoped = collectScopedParameterNames(operations, descriptors);

    expect(scoped).toEqual(new Set(["key"]));
  });

  test("multiple operations with overlapping requiredParameters union without duplicates", () => {
    const operations = [
      makeOperation({ name: "get", requiredParameters: ["key"] }),
      makeOperation({
        name: "put",
        requiredParameters: ["key", "bucket", "token"],
      }),
    ];

    const scoped = collectScopedParameterNames(operations, descriptors);

    expect(scoped).toEqual(new Set(["key", "bucket", "token"]));
    expect(scoped.size).toBe(3);
  });

  test("an operation declaring no requiredParameters contributes nothing", () => {
    const operations = [
      makeOperation({ name: "list", requiredParameters: [] }),
    ];

    const scoped = collectScopedParameterNames(operations, descriptors);

    expect(scoped.size).toBe(0);
  });

  test("resolves requiredParameters entries through their declared aliases", () => {
    const operations = [
      makeOperation({ name: "get", requiredParameters: ["k"] }),
    ];

    const scoped = collectScopedParameterNames(operations, descriptors);

    expect(scoped).toEqual(new Set(["key"]));
  });

  test("an unresolvable requiredParameters entry is silently dropped, not thrown", () => {
    const operations = [
      makeOperation({
        name: "get",
        requiredParameters: ["key", "doesNotExist"],
      }),
    ];

    expect(() =>
      collectScopedParameterNames(operations, descriptors),
    ).not.toThrow();
    const scoped = collectScopedParameterNames(operations, descriptors);
    expect(scoped).toEqual(new Set(["key"]));
  });
});

describe("shouldPromptParameter", () => {
  const getOperation = makeOperation({
    name: "get",
    requiredParameters: ["key"],
  });
  const putOperation = makeOperation({
    name: "put",
    requiredParameters: ["bucket"],
  });
  const keyDescriptor = makeDescriptor({ name: "key" });
  const bucketDescriptor = makeDescriptor({ name: "bucket" });
  const regionDescriptor = makeDescriptor({ name: "region" });
  const descriptors = [keyDescriptor, bucketDescriptor, regionDescriptor];
  const scoped = new Set(["key", "bucket"]);

  test("an unscoped parameter is always prompted, regardless of the chosen operation", () => {
    expect(
      shouldPromptParameter(
        regionDescriptor,
        getOperation,
        scoped,
        descriptors,
      ),
    ).toBe(true);
    expect(
      shouldPromptParameter(
        regionDescriptor,
        putOperation,
        scoped,
        descriptors,
      ),
    ).toBe(true);
  });

  test("a scoped parameter required by the chosen operation is prompted", () => {
    expect(
      shouldPromptParameter(keyDescriptor, getOperation, scoped, descriptors),
    ).toBe(true);
  });

  test("a scoped parameter required by a DIFFERENT operation than the one chosen is NOT prompted", () => {
    expect(
      shouldPromptParameter(
        bucketDescriptor,
        getOperation,
        scoped,
        descriptors,
      ),
    ).toBe(false);
    expect(
      shouldPromptParameter(keyDescriptor, putOperation, scoped, descriptors),
    ).toBe(false);
  });

  test("when no operation is chosen yet, every parameter is prompted", () => {
    expect(
      shouldPromptParameter(keyDescriptor, undefined, scoped, descriptors),
    ).toBe(true);
    expect(
      shouldPromptParameter(bucketDescriptor, undefined, scoped, descriptors),
    ).toBe(true);
    expect(
      shouldPromptParameter(regionDescriptor, undefined, scoped, descriptors),
    ).toBe(true);
  });

  test("a descriptor declared required: true is ALWAYS prompted, even when it is scoped to a DIFFERENT operation than the one chosen (required wins over scoping)", () => {
    // "bucket" is in `scoped` and required only by `putOperation`, not
    // `getOperation` — under pure scoping precedence this descriptor would be
    // skipped entirely once "get" is chosen. Marking it `required: true`
    // must override that: `descriptor.required` is checked FIRST, before any
    // scoping logic, so it is prompted regardless. Pre-fix, the scoping check
    // ran before `descriptor.required`, so this exact fixture would have
    // returned `false`.
    const requiredBucketDescriptor = makeDescriptor({
      name: "bucket",
      required: true,
    });

    expect(
      shouldPromptParameter(
        requiredBucketDescriptor,
        getOperation,
        scoped,
        descriptors,
      ),
    ).toBe(true);
  });
});

describe("isRequiredForOperation", () => {
  const getOperation = makeOperation({
    name: "get",
    requiredParameters: ["key"],
  });
  const putOperation = makeOperation({
    name: "put",
    requiredParameters: ["bucket"],
  });

  test("returns true when the chosen operation requires the descriptor, even though the descriptor itself declares required: false", () => {
    const keyDescriptor = makeDescriptor({ name: "key", required: false });
    const descriptors = [keyDescriptor];

    expect(
      isRequiredForOperation(keyDescriptor, getOperation, descriptors),
    ).toBe(true);
  });

  test("returns false when the chosen operation does not require the descriptor", () => {
    const keyDescriptor = makeDescriptor({ name: "key", required: false });
    const descriptors = [keyDescriptor];

    expect(
      isRequiredForOperation(keyDescriptor, putOperation, descriptors),
    ).toBe(false);
  });

  test("returns false when no operation is chosen", () => {
    const keyDescriptor = makeDescriptor({ name: "key", required: false });
    const descriptors = [keyDescriptor];

    expect(isRequiredForOperation(keyDescriptor, undefined, descriptors)).toBe(
      false,
    );
  });

  test("[collision] resolves requiredParameters through canonical-name-first precedence: a descriptor whose alias collides with another descriptor's canonical name is NOT reported as required", () => {
    // Descriptor A is canonically named "key"; descriptor B is a DIFFERENT
    // parameter that happens to declare "key" as one of its own aliases (an
    // authoring collision `resolveCanonicalName`'s own docs call out as
    // possible). The chosen operation's requiredParameters: ["key"] must
    // resolve to A only (exact-name pass wins), so only A is reported as
    // required — B must NOT be, even though "key" is literally one of B's
    // declared aliases.
    const descriptorA = makeDescriptor({ name: "key" });
    const descriptorB = makeDescriptor({
      name: "otherParam",
      aliases: ["key"],
    });
    const descriptors = [descriptorA, descriptorB];
    const chosenOperation = makeOperation({
      name: "get",
      requiredParameters: ["key"],
    });

    expect(
      isRequiredForOperation(descriptorA, chosenOperation, descriptors),
    ).toBe(true);
    expect(
      isRequiredForOperation(descriptorB, chosenOperation, descriptors),
    ).toBe(false);
  });
});
