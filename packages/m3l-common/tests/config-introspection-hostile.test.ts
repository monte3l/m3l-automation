/**
 * Security-hardening tests for `core/config`'s `describeConfigParameters`
 * and `loadScriptConfigDescriptors` (X10a). Split out of
 * `config-introspection-describe.test.ts` / `config-introspection-module.test.ts`
 * to stay under `pnpm check:file-budget`'s per-file ceiling — see this
 * task's instructions.
 *
 * A security audit executed probes against the built `dist/` and
 * demonstrated concrete ways a hostile or broken script config module
 * defeats the seam's masking and validation guarantees. These descriptors
 * will shortly be served over HTTP by `m3l-console-server`
 * (`GET /api/v1/scripts/:name`) and rendered in a browser, so
 * `describeConfigParameters` must be an unconditional choke point: it always
 * masks a secret default and always validates every element, regardless of
 * how a foreign `configParameters` export is shaped at runtime.
 *
 * Fix 1 — `Array.isArray()` returns `true` for a genuine array carrying OWN
 *   `every` / `map` overrides, so both `loadScriptConfigDescriptors`'s
 *   validation gate and `describeConfigParameters`'s projection can be
 *   replaced wholesale by a hostile module.
 * Fix 2 — `safeIsSecret` reads `parameter.isSecret` three separate times; a
 *   getter/accessor that changes its answer across those reads can produce
 *   `secret: false` with an unmasked default.
 * Fix 3 — `getAliases()`'s returned array must be copied into the
 *   descriptor, not embedded directly, or a later mutation of the source
 *   array reaches an already-built descriptor.
 * Fix 4 — no raw `TypeError`/`Error` may escape either public function; the
 *   documented contract is `M3LError` only.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { M3LError } from "../src/core/errors/index.js";
import {
  describeConfigParameters,
  loadScriptConfigDescriptors,
} from "../src/core/config/index.js";
import type {
  M3LConfigParameterLike,
  M3LConfigParameterValue,
} from "../src/core/config/index.js";

/** Captures the thrown value from a synchronous call, or `undefined`. */
function captureThrown(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

/** Captures the rejection value from an async call, or `undefined`. */
async function captureRejection(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

/** A well-formed base fixture, reused as the "legit" element in hostile arrays. */
function buildWellFormedElement(
  overrides: Partial<M3LConfigParameterLike> = {},
): M3LConfigParameterLike {
  return {
    getName: () => "paramName",
    getAliases: () => [],
    getType: () => "STRING",
    isRequired: () => false,
    getDefaultValue: () => undefined,
    getDescription: () => undefined,
    ...overrides,
  };
}

const DOCUMENTED_DESCRIPTOR_KEYS = [
  "name",
  "aliases",
  "type",
  "required",
  "defaultValue",
  "description",
  "secret",
  "operations",
].sort();

describe("Fix 1 — an own `every` override cannot bypass parameter-like validation", () => {
  let scriptDirectory: string;

  beforeEach(() => {
    scriptDirectory = mkdtempSync(
      join(tmpdir(), "m3l-config-introspection-hostile-"),
    );
    // resolveConfigModulePath only needs a dist/config.js to exist; the
    // injected importModule below never actually reads its contents.
    const distDir = join(scriptDirectory, "dist");
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, "config.js"), "// placeholder");
  });

  afterEach(() => {
    rmSync(scriptDirectory, { recursive: true, force: true });
  });

  test(
    "a configParameters array whose OWN every() unconditionally returns true still" +
      " rejects a non-parameter-like element with ERR_CONFIG_MODULE_INVALID, never a raw TypeError" +
      " (also pins Fix 4's escape #1: the unvalidated element must not reach the descriptor" +
      " mapper as a raw TypeError)",
    async () => {
      // Object.assign onto a real array literal preserves Array.isArray()
      // === true (it IS a genuine Array instance) while adding an OWN
      // `every` property that shadows Array.prototype.every for this
      // instance — models a hostile config module attempting to defeat the
      // `configParameters.every(isParameterLike)` validation gate.
      const hostileArray: unknown[] = Object.assign([{ notAGetter: true }], {
        every: (): boolean => true,
      });
      const importModule = vi.fn(() =>
        Promise.resolve({ configParameters: hostileArray }),
      );

      const thrown = await captureRejection(() =>
        loadScriptConfigDescriptors(scriptDirectory, importModule),
      );

      expect(thrown).toBeInstanceOf(M3LError);
      expect((thrown as M3LError).code).toBe("ERR_CONFIG_MODULE_INVALID");
      expect(thrown).not.toBeInstanceOf(TypeError);
    },
  );

  test("an own map() override on configParameters cannot inject a foreign object into loadScriptConfigDescriptors's result", async () => {
    const RAW_SECRET = "raw-secret-injected-via-map-override";
    // The underlying array's real element is well-formed, so the NATIVE
    // `every` (not overridden here) validates it fine — the attack is
    // entirely in the overridden `map`, which loadScriptConfigDescriptors
    // relies on describeConfigParameters to call.
    const hostileArray: unknown[] = Object.assign([buildWellFormedElement()], {
      map: (): unknown[] => [
        {
          name: "API_TOKEN",
          defaultValue: RAW_SECRET,
          secret: false,
          extraNonPrimitive: { nested: { deep: true } },
        },
      ],
    });
    const importModule = vi.fn(() =>
      Promise.resolve({ configParameters: hostileArray }),
    );

    const result = await loadScriptConfigDescriptors(
      scriptDirectory,
      importModule,
    );

    for (const descriptor of result) {
      expect(Object.keys(descriptor).sort()).toEqual(
        DOCUMENTED_DESCRIPTOR_KEYS,
      );
    }
    expect(JSON.stringify(result)).not.toContain(RAW_SECRET);
    expect(JSON.stringify(result)).not.toContain("extraNonPrimitive");
  });
});

describe("Fix 1 — the same map() override, exercised via describeConfigParameters directly", () => {
  test("an own map() override on the parameters array cannot inject a foreign object into describeConfigParameters's result", () => {
    const RAW_SECRET = "raw-secret-injected-via-map-override-direct";
    const hostileArray: unknown[] = Object.assign([buildWellFormedElement()], {
      map: (): unknown[] => [
        {
          name: "API_TOKEN",
          defaultValue: RAW_SECRET,
          secret: false,
          extraNonPrimitive: { nested: { deep: true } },
        },
      ],
    });

    // Deliberate cast through unknown: this hostile array is not actually
    // shaped like `readonly M3LConfigParameterLike[]` (its `map` lies about
    // what it returns) — that is the whole point of the exploit, and
    // `describeConfigParameters` must defend against it at runtime, not rely
    // on the compile-time type.
    const result = describeConfigParameters(
      hostileArray as unknown as readonly M3LConfigParameterLike[],
    );

    for (const descriptor of result) {
      expect(Object.keys(descriptor).sort()).toEqual(
        DOCUMENTED_DESCRIPTOR_KEYS,
      );
    }
    expect(JSON.stringify(result)).not.toContain(RAW_SECRET);
    expect(JSON.stringify(result)).not.toContain("extraNonPrimitive");
  });
});

describe("Fix 2 — safeIsSecret must read isSecret exactly once", () => {
  test("a getter/accessor that answers true on early reads and false on a later read cannot yield secret: false with an unmasked default", () => {
    const RAW_SECRET_DEFAULT = "raw-secret-default-flip-value";
    let readCount = 0;
    const parameter = buildWellFormedElement({
      getName: () => "API_TOKEN",
      getDefaultValue: () => RAW_SECRET_DEFAULT,
    });
    // `safeIsSecret`'s current implementation reads `parameter.isSecret`
    // three separate times (an `=== undefined` check, a `typeof` check, then
    // the actual invocation). This getter answers "secret" honestly the
    // first two times and flips to "not secret" from the third read
    // onward — exactly the read pattern that lets the invocation see a
    // different, unmasking answer than the earlier checks did.
    Object.defineProperty(parameter, "isSecret", {
      enumerable: true,
      configurable: true,
      get(): () => boolean {
        readCount += 1;
        return readCount <= 2 ? () => true : () => false;
      },
    });

    const [descriptor] = describeConfigParameters([parameter]);

    expect(descriptor?.secret).toBe(true);
    expect(descriptor?.defaultValue).toBe("********");
    expect(JSON.stringify(descriptor)).not.toContain(RAW_SECRET_DEFAULT);
    expect(readCount).toBe(1);
  });
});

describe("Fix 3 — getAliases()'s returned array must be copied, not embedded directly", () => {
  test("mutating the source aliases array after describeConfigParameters returns does not mutate the already-built descriptor", () => {
    const RAW_SECRET_ALIAS = "raw-secret-alias-leaked-post-hoc";
    const sourceAliases: string[] = ["ALIAS_ONE"];
    const parameter = buildWellFormedElement({
      getName: () => "API_TOKEN",
      getAliases: () => sourceAliases,
    });

    const [descriptor] = describeConfigParameters([parameter]);
    sourceAliases.push(RAW_SECRET_ALIAS);

    expect(descriptor?.aliases).toEqual(["ALIAS_ONE"]);
    expect(JSON.stringify(descriptor)).not.toContain(RAW_SECRET_ALIAS);
  });

  test("(equivalent invariant, already held) mutating the source getOperations() array after describeConfigParameters returns does not mutate the already-built descriptor", () => {
    // `describeOperations` already builds a fresh `normalized` array of
    // freshly-constructed operation objects, so this states the same
    // invariant for `operations` as the test above states for `aliases` —
    // it is not expected to be RED against the current implementation.
    const sourceOperations: { name: string; description: string }[] = [
      { name: "get", description: "Fetch one item." },
    ];
    const parameter = buildWellFormedElement({
      getName: () => "command",
      getOperations: () => sourceOperations,
    });

    const [descriptor] = describeConfigParameters([parameter]);
    sourceOperations.push({ name: "put", description: "Write one item." });

    expect(descriptor?.operations).toEqual([
      { name: "get", description: "Fetch one item.", requiredParameters: [] },
    ]);
  });
});

describe("Fix 4 — no raw TypeError/Error may escape the two public functions", () => {
  test("a Proxy whose get trap throws on `isSecret` surfaces as M3LError ERR_CONFIG_MODULE_INVALID from describeConfigParameters, never the raw thrown value", () => {
    const base = buildWellFormedElement({ getName: () => "API_TOKEN" });
    // Models a hostile/broken duck-typed export backed by a Proxy whose trap
    // throws on property access rather than on invocation — the try/catch
    // inside `safeIsSecret` only wraps the call `parameter.isSecret()`, not
    // the earlier property reads that check for `undefined`/`function`, so
    // this throw currently escapes both `safeIsSecret` and
    // `describeConfigParameters` unwrapped.
    const hostileParameter = new Proxy(base, {
      get(target, property, receiver): unknown {
        if (property === "isSecret") {
          throw new Error("hostile trap: isSecret access denied");
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });

    const thrown = captureThrown(() =>
      describeConfigParameters([hostileParameter]),
    );

    expect(thrown).toBeInstanceOf(M3LError);
    expect((thrown as M3LError).code).toBe("ERR_CONFIG_MODULE_INVALID");
  });
});

describe("M3LConfigParameterValue membership check (isConfigParameterValue) — security-relevant, since this gate is what stands between a getDefaultValue() returning a plain object and it rendering as the literal string '[object Object]'", () => {
  test.each<[string, M3LConfigParameterValue, string]>([
    ["a string", "us-east-1", "us-east-1"],
    ["a number", 3000, "3000"],
    ["a boolean", true, "true"],
    ["a readonly string[]", ["a", "b"], "a,b"],
    ["a readonly number[]", [1, 2, 3], "1,2,3"],
    ["a Buffer", Buffer.from("hi"), "hi"],
  ])(
    "accepts %s as getDefaultValue()'s return value and renders it via String(...)",
    (_label, defaultValue, rendered) => {
      const parameter = buildWellFormedElement({
        getName: () => "ACCEPTED",
        getDefaultValue: () => defaultValue,
      });

      const [descriptor] = describeConfigParameters([parameter]);

      expect(descriptor?.defaultValue).toBe(rendered);
    },
  );

  test.each<[string, unknown]>([
    ["a plain object", { nested: true }],
    ["null", null],
    ["a function", (): void => undefined],
    ["a symbol", Symbol("hostile")],
    ["a mixed-type array", ["a", 1]],
    ["a nested array", [["a"]]],
  ])(
    "rejects %s as getDefaultValue()'s return value with ERR_CONFIG_MODULE_INVALID, never rendering '[object Object]' or otherwise silently coercing it",
    (_label, hostileDefault) => {
      const parameter = buildWellFormedElement({
        getName: () => "REJECTED",
        // Deliberate cast through unknown: every one of these fixtures is,
        // by design, NOT a legal M3LConfigParameterValue — that is exactly
        // what this test proves gets rejected.
        getDefaultValue: () => hostileDefault as never,
      });

      const thrown = captureThrown(() => describeConfigParameters([parameter]));

      expect(thrown).toBeInstanceOf(M3LError);
      expect((thrown as M3LError).code).toBe("ERR_CONFIG_MODULE_INVALID");
      expect((thrown as M3LError).message).toContain("getDefaultValue");
    },
  );
});
