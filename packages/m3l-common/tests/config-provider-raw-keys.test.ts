/**
 * Tests for the config providers' key-enumeration surface:
 * `M3LConfigProvider.rawKeys()` and its `M3LYAMLConfigProvider` override.
 *
 * Why a sibling file rather than an addition to `config.test.ts`:
 * `packages/m3l-common/tests/config.test.ts` is recorded in
 * `bin/file-budget-baseline.json` and `bin/check-file-budget.mjs` lets a
 * baselined file shrink but never grow past its recorded size, so appending
 * there would fail the gate.
 *
 * Contract under test:
 *  - `rawKeys(): readonly string[]` is a CONCRETE base-class method with a
 *    default returning `[]` — deliberately not `abstract`, matching the
 *    `getSourceLabel()` precedent: `M3LConfigProvider` documents external
 *    subclassing, so a new abstract member would be a source-breaking change.
 *  - `M3LYAMLConfigProvider` overrides it to report its parsed mapping's own
 *    top-level keys, unfiltered by value type, in source order.
 *
 * Filesystem discipline: no real filesystem mutations. ESLint's
 * `no-restricted-syntax` block for the test globs bans
 * `mkdtempSync`/`writeFileSync`/`rmSync`, so YAML fixtures are supplied the
 * same way `config.test.ts` already supplies them — a pass-through `vi.mock`
 * of `fs` (so the ESM namespace is configurable) plus a per-test
 * `vi.spyOn(fs, "readFileSync")`.
 */

import * as fs from "fs";
import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

// Make the 'fs' module configurable so vi.spyOn can intercept individual
// functions (ESM namespace objects are non-writable by default). This factory
// is a pure pass-through spread of the real module — it installs no vi.fn(),
// so `vi.restoreAllMocks()` in afterEach is sufficient teardown.
vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof fs>("fs");
  return { ...actual };
});

import {
  M3LConfigParseError,
  M3LConfigProvider,
  M3LUnsafeConfigKeyError,
  M3LYAMLConfigProvider,
} from "../src/core/config/index.js";

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Installs `content` as the body of every YAML file read in this test.
 */
function stubYamlFile(content: string): void {
  vi.spyOn(fs, "readFileSync").mockReturnValue(content);
}

/**
 * Makes every file read fail with ENOENT, which the provider tolerates.
 */
function stubMissingFile(): void {
  vi.spyOn(fs, "readFileSync").mockImplementation(() => {
    throw Object.assign(new Error("ENOENT: no such file or directory"), {
      code: "ENOENT",
    });
  });
}

// =============================================================================
// M3LConfigProvider.rawKeys — the concrete default
// =============================================================================
describe("M3LConfigProvider.rawKeys (base-class default)", () => {
  test("returns an empty array on a subclass that does not override it", () => {
    // A direct instance is impossible (getRawValue is abstract), so the
    // smallest possible concrete subclass stands in for the base default.
    class OnlyGetRawValueProvider extends M3LConfigProvider {
      override getRawValue(key: string): unknown {
        return key === "known" ? "value" : undefined;
      }
    }

    const provider = new OnlyGetRawValueProvider();
    expect(provider.rawKeys()).toEqual([]);
  });

  test("a subclass overriding only getRawValue still compiles and inherits the [] default", () => {
    // THIS is the test that makes the "concrete, not abstract" decision
    // load-bearing: an existing external subclass that implements nothing but
    // `getRawValue` must keep type-checking (source compatibility) and must
    // get a usable `rawKeys()` for free. If `rawKeys` were declared
    // `abstract`, this class declaration itself would be a compile error.
    class LegacyExternalProvider extends M3LConfigProvider {
      constructor(private readonly values: Record<string, unknown>) {
        super();
      }
      override getRawValue(key: string): unknown {
        return this.values[key];
      }
    }

    const provider = new LegacyExternalProvider({ region: "eu-west-1" });

    // The subclass is genuinely functional — it is not a hollow fixture.
    expect(provider.getRawValue("region")).toBe("eu-west-1");
    // ...and it inherits both concrete defaults untouched.
    expect(provider.rawKeys()).toEqual([]);
    expect(provider.getSourceLabel()).toBe("other");
  });

  test("the declared signature is () => readonly string[]", () => {
    // The readonly modifier is part of the contract: a caller must not be
    // handed a mutable handle on provider state. `toEqualTypeOf` is exact, so
    // a `string[]` return would fail here.
    expectTypeOf<M3LConfigProvider["rawKeys"]>().toEqualTypeOf<
      () => readonly string[]
    >();
    expectTypeOf<ReturnType<M3LConfigProvider["rawKeys"]>>().toEqualTypeOf<
      readonly string[]
    >();
  });
});

// =============================================================================
// M3LYAMLConfigProvider.rawKeys — the override
// =============================================================================
describe("M3LYAMLConfigProvider.rawKeys", () => {
  test("returns exactly the file's top-level keys for a multi-key mapping", () => {
    // KEY-ORDER DECISION: source order (the order the keys are declared in the
    // YAML document), NOT sorted.
    //
    // Reasoning:
    //  1. It is what the existing pipeline already produces for free — the
    //     parsed store is a Map built by `buildSafeValueMap` from
    //     `Object.keys(parsed)`, and both `Object.keys` and `Map` iteration
    //     preserve insertion order. Sorting would be extra code with no
    //     caller asking for it.
    //  2. It is deterministic per file, which is the property the flow
    //     loader's "unknown top-level key" messages need: the same
    //     `<name>.yaml` always yields the same key order, so the same error
    //     text.
    //  3. Between two deterministic options, source order is the more useful
    //     one for a human fixing the file — reported keys appear in the order
    //     they wrote them, preserving authoring locality.
    //
    // The fixture below is deliberately NOT in alphabetical order, so a
    // sorted implementation fails this assertion rather than passing by
    // coincidence.
    stubYamlFile(
      ["version: 1", "steps: []", "name: deploy", "description: ship it"].join(
        "\n",
      ) + "\n",
    );

    const provider = new M3LYAMLConfigProvider("/fixtures/flow.yaml");

    expect(provider.rawKeys()).toEqual([
      "version",
      "steps",
      "name",
      "description",
    ]);
  });

  test("the same key set declared in a different order yields that different order (source order, not sorted)", () => {
    // Discriminates source order from any canonicalising implementation: the
    // two fixtures carry an identical key SET, so a sorted implementation
    // would return the same array for both and fail one of the two.
    stubYamlFile("beta: 1\nalpha: 2\n");
    expect(new M3LYAMLConfigProvider("/fixtures/a.yaml").rawKeys()).toEqual([
      "beta",
      "alpha",
    ]);

    vi.restoreAllMocks();

    stubYamlFile("alpha: 2\nbeta: 1\n");
    expect(new M3LYAMLConfigProvider("/fixtures/b.yaml").rawKeys()).toEqual([
      "alpha",
      "beta",
    ]);
  });

  test("returns an empty array for a missing file", () => {
    // The provider already treats ENOENT as an empty map; pin that
    // enumeration agrees, because the flow loader distinguishes "file absent"
    // from "file present but declaring nothing" by its own existence check and
    // must not have rawKeys() throw out from under it.
    stubMissingFile();

    const provider = new M3LYAMLConfigProvider("/fixtures/does-not-exist.yaml");

    expect(provider.rawKeys()).toEqual([]);
  });

  test("returns an empty array for an empty mapping", () => {
    stubYamlFile("{}\n");

    const provider = new M3LYAMLConfigProvider("/fixtures/empty.yaml");

    expect(provider.rawKeys()).toEqual([]);
  });

  test("enumerates keys for values of every shape and does not filter by value type", () => {
    stubYamlFile(
      [
        "str: hello",
        "num: 42",
        "bool: true",
        "nil: null",
        "nested:",
        "  inner: value",
        "seq:",
        "  - one",
        "  - two",
      ].join("\n") + "\n",
    );

    const provider = new M3LYAMLConfigProvider("/fixtures/shapes.yaml");

    expect(provider.rawKeys()).toEqual([
      "str",
      "num",
      "bool",
      "nil",
      "nested",
      "seq",
    ]);
  });

  test("reports a key written with no value under it (`steps:`) as declared", () => {
    // The motivating flow-definition case: `steps:` with nothing beneath it
    // parses to null, but it is still a DECLARED key and must be reportable as
    // such — otherwise a flow file that declares `steps` but leaves it blank
    // looks identical to one that never mentioned `steps` at all.
    stubYamlFile("name: demo\nsteps:\n");

    const provider = new M3LYAMLConfigProvider("/fixtures/blank-steps.yaml");

    expect(provider.rawKeys()).toEqual(["name", "steps"]);
    expect(provider.getRawValue("steps")).toBeNull();
  });

  test("every enumerated key resolves to a defined raw value via getRawValue", () => {
    // rawKeys() and getRawValue() must agree: enumeration is only useful to
    // the flow loader if each reported key is actually readable.
    stubYamlFile("name: demo\ncount: 0\nflag: false\nblank:\n");

    const provider = new M3LYAMLConfigProvider("/fixtures/agree.yaml");

    for (const key of provider.rawKeys()) {
      expect(provider.getRawValue(key)).not.toBeUndefined();
    }
  });

  test("does not include inherited object keys", () => {
    stubYamlFile("name: demo\n");

    const provider = new M3LYAMLConfigProvider("/fixtures/own-keys.yaml");
    const keys = provider.rawKeys();

    expect(keys).toEqual(["name"]);
    for (const inherited of [
      "__proto__",
      "constructor",
      "prototype",
      "toString",
      "valueOf",
      "hasOwnProperty",
    ]) {
      expect(keys).not.toContain(inherited);
    }
  });

  test("still throws M3LUnsafeConfigKeyError at construction for a prototype-pollution vector key", () => {
    // Adding rawKeys() must not create a back door: the guard fires at
    // construction, so a dangerous key can never reach enumeration at all.
    // Pinning the unchanged behaviour is the honest way to cover this rather
    // than trying to smuggle a __proto__ key through to rawKeys().
    stubYamlFile("__proto__:\n  polluted: true\n");

    let thrown: unknown;
    try {
      new M3LYAMLConfigProvider("/fixtures/dangerous.yaml");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LUnsafeConfigKeyError);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  test("mutating the returned array does not change what the provider reports", () => {
    stubYamlFile("first: 1\nsecond: 2\n");

    const provider = new M3LYAMLConfigProvider("/fixtures/mutate.yaml");
    const keys = provider.rawKeys();

    // Deliberately mechanism-agnostic: a defensive copy lets the push succeed
    // while a frozen view makes it throw, and either satisfies the contract.
    // The assertion that matters is the SECOND rawKeys() call.
    try {
      (keys as string[]).push("injected");
      (keys as string[])[0] = "clobbered";
    } catch {
      // A frozen return rejects mutation in strict mode; that is acceptable.
    }

    expect(provider.rawKeys()).toEqual(["first", "second"]);
  });

  test("malformed YAML still throws M3LConfigParseError before any key can be enumerated", () => {
    stubYamlFile("a: [unterminated\n  - b");

    expect(() => new M3LYAMLConfigProvider("/fixtures/bad.yaml")).toThrow(
      M3LConfigParseError,
    );
  });

  test("the override keeps the readonly string[] return type", () => {
    expectTypeOf<ReturnType<M3LYAMLConfigProvider["rawKeys"]>>().toEqualTypeOf<
      readonly string[]
    >();
  });
});
