/**
 * Tests for the ADR-0029 script-dependency boundary checker
 * (bin/check-script-deps.mjs) — covers only the exported pure function
 * `scriptDependencyErrors`. The module's CLI main block is guarded behind
 * `if (process.argv[1] === fileURLToPath(import.meta.url))`, mirroring the
 * convention already established by bin/tests/script-scaffold.test.ts (only
 * the side-effect-free exported function is exercised; the filesystem-walking
 * CLI body is left untested here).
 */
import { describe, expect, test } from "vitest";
import { scriptDependencyErrors } from "../check-script-deps.mjs";

describe("scriptDependencyErrors", () => {
  test("returns no problems for a conformant manifest", () => {
    const pkg = {
      dependencies: { "@m3l-automation/m3l-common": "workspace:*" },
    };
    expect(scriptDependencyErrors(pkg)).toEqual([]);
  });

  test("flags an extra dependency alongside the library", () => {
    const pkg = {
      dependencies: {
        "@m3l-automation/m3l-common": "workspace:*",
        lodash: "4.17.21",
      },
    };
    const errors = scriptDependencyErrors(pkg);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("ADR-0029");
    expect(errors[0]).toContain("workspace:*");
  });

  test("flags a wrong version specifier for the library", () => {
    const pkg = {
      dependencies: { "@m3l-automation/m3l-common": "^1.0.0" },
    };
    const errors = scriptDependencyErrors(pkg);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("ADR-0029");
  });

  test("flags a single dependency that is not the library", () => {
    const pkg = {
      dependencies: { "some-other-pkg": "workspace:*" },
    };
    const errors = scriptDependencyErrors(pkg);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("ADR-0029");
  });

  test("flags an empty dependencies object", () => {
    const pkg = { dependencies: {} };
    const errors = scriptDependencyErrors(pkg);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("ADR-0029");
  });

  test("flags a missing dependencies key the same way as an empty object", () => {
    const withEmptyDeps = scriptDependencyErrors({ dependencies: {} });
    const withMissingDeps = scriptDependencyErrors({});
    expect(withMissingDeps).toEqual(withEmptyDeps);
    expect(withMissingDeps).toHaveLength(1);
  });

  test("flags devDependencies present as an empty object, not just when non-empty", () => {
    const pkg = {
      dependencies: { "@m3l-automation/m3l-common": "workspace:*" },
      devDependencies: {},
    };
    const errors = scriptDependencyErrors(pkg);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("devDependencies must not be declared");
  });

  test("flags devDependencies present with entries", () => {
    const pkg = {
      dependencies: { "@m3l-automation/m3l-common": "workspace:*" },
      devDependencies: { vitest: "4.1.10" },
    };
    const errors = scriptDependencyErrors(pkg);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("devDependencies must not be declared");
  });

  test("collects both problems at once without short-circuiting", () => {
    const pkg = {
      dependencies: { "some-other-pkg": "1.0.0" },
      devDependencies: {},
    };
    const errors = scriptDependencyErrors(pkg);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain("ADR-0029");
    expect(errors[1]).toContain("devDependencies must not be declared");
  });
});
