import { afterEach, describe, expect, expectTypeOf, test } from "vitest";

import { resolvePresetOption } from "../src/steps/resolve-preset.js";

/**
 * Contract: `resolvePresetOption` resolves a `--preset` CLI flag (via
 * `Core.M3LCommandLineConfigProvider#getRawValue`) into a spreadable
 * `M3LScriptOptions` fragment. Per
 * packages/m3l-common/src/core/config/M3LCommandLineConfigProvider.ts +
 * internal/config/parseArgv.ts, `getRawValue("preset")` returns:
 * - a `string` for `--preset=path` or `--preset path`.
 * - real boolean `true` for a bare `--preset` flag (no value).
 * - `undefined` when the flag is absent.
 *
 * `M3LScriptOptions.preset` must never be an explicit `""` (the library
 * treats an empty string as "a preset was configured" and throws
 * `ERR_PRESET_LOAD` trying to read it), so this helper must fold the
 * boolean-flag and blank-value cases down to "no preset" (`{}`), not forward
 * them.
 */

describe("resolvePresetOption", () => {
  test("'--preset=path' resolves to a preset fragment with that path", () => {
    expect(resolvePresetOption(["--preset=some/path.yaml"])).toEqual({
      preset: "some/path.yaml",
    });
  });

  test("space-separated '--preset path' resolves to a preset fragment with that path", () => {
    expect(resolvePresetOption(["--preset", "some/path.yaml"])).toEqual({
      preset: "some/path.yaml",
    });
  });

  test("a bare '--preset' flag (boolean true, no value) resolves to an empty fragment", () => {
    expect(resolvePresetOption(["--preset"])).toEqual({});
  });

  test("no '--preset' flag in argv resolves to an empty fragment", () => {
    expect(resolvePresetOption(["--other=value"])).toEqual({});
  });

  test("an empty argv array resolves to an empty fragment", () => {
    expect(resolvePresetOption([])).toEqual({});
  });

  test.each(["--preset=", "--preset=   "])(
    "a blank value ('%s') resolves to an empty fragment, guarding against forwarding '' to M3LScriptOptions",
    (flag) => {
      expect(resolvePresetOption([flag])).toEqual({});
    },
  );

  describe("default argv (process.argv.slice(2))", () => {
    const originalArgv = process.argv;

    /** Replaces `process.argv.slice(2)` with `args`, matching the library's own convention for stubbing this default (see packages/m3l-common/tests/script.test.ts). */
    function stubArgv(...args: string[]): void {
      process.argv = [
        originalArgv[0] ?? "node",
        originalArgv[1] ?? "script",
        ...args,
      ];
    }

    afterEach(() => {
      process.argv = originalArgv;
    });

    test("with argv omitted, reads '--preset' off process.argv.slice(2)", () => {
      stubArgv("--preset=from-process-argv.yaml");
      expect(resolvePresetOption()).toEqual({
        preset: "from-process-argv.yaml",
      });
    });

    test("with argv omitted and no '--preset' flag present, resolves to an empty fragment", () => {
      stubArgv("--other=value");
      expect(resolvePresetOption()).toEqual({});
    });
  });

  describe("type-level contract", () => {
    test("return type is exactly { readonly preset?: string }", () => {
      expectTypeOf(resolvePresetOption).returns.toEqualTypeOf<{
        readonly preset?: string;
      }>();
    });
  });
});
