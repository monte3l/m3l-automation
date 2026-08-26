/**
 * Tests for the scaffold-template formatting gate (bin/check-template-format.mjs)
 * — covers the exported pure functions only. The module's CLI main block is
 * guarded behind `if (process.argv[1] === fileURLToPath(import.meta.url))`, so
 * importing it here executes nothing (the bin/check-script-deps.mjs
 * convention).
 */
import { describe, expect, test, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  tokenSets,
  substitute,
  listTemplates,
  targetPathFor,
} from "../check-template-format.mjs";
import { repoRoot } from "../lib/report.mjs";

describe("tokenSets", () => {
  test("returns a non-empty array of label/tokens fixtures with the three required token keys", () => {
    const sets = tokenSets();
    expect(sets.length).toBeGreaterThan(0);
    for (const set of sets) {
      expect(typeof set.label).toBe("string");
      expect(set.label.length).toBeGreaterThan(0);
      expect(typeof set.tokens).toBe("object");
      expect(Object.keys(set.tokens).sort()).toEqual(
        ["__SCRIPT_NAME__", "__SCRIPT_NAME_PASCAL__", "__PURPOSE__"].sort(),
      );
      for (const value of Object.values(set.tokens)) {
        expect(typeof value).toBe("string");
      }
    }
  });

  test("includes the three documented fixtures: short-name, typical, long-name-and-purpose", () => {
    const labels = tokenSets().map((set) => set.label);
    expect(labels).toEqual(
      expect.arrayContaining([
        "short-name",
        "typical",
        "long-name-and-purpose",
      ]),
    );
  });
});

describe("substitute", () => {
  test("replaces every occurrence of every token key, including repeats", () => {
    const text =
      "__SCRIPT_NAME__ says hello to __SCRIPT_NAME__ and __PURPOSE__.";
    const result = substitute(text, {
      __SCRIPT_NAME__: "data-sync",
      __PURPOSE__: "sync data",
    });
    expect(result).toBe("data-sync says hello to data-sync and sync data.");
  });

  // Deliberately does NOT throw on a leftover unreplaced token — unlike the
  // scaffolder's own `substituteTokens`, this gate's job is to check
  // formatting of what substitution actually produces for a KNOWN set of
  // templates, not to re-validate the token contract itself (see the doc
  // comment on `substitute` in bin/check-template-format.mjs).
  test("leaves a token not present in the map untouched, without throwing", () => {
    const text = "Hello __SCRIPT_NAME__, purpose: __PURPOSE__.";
    expect(() =>
      substitute(text, { __SCRIPT_NAME__: "data-sync" }),
    ).not.toThrow();
    const result = substitute(text, { __SCRIPT_NAME__: "data-sync" });
    expect(result).toBe("Hello data-sync, purpose: __PURPOSE__.");
  });
});

describe("listTemplates", () => {
  // Resolved against the module-under-test's own URL (one level under the
  // repo root, matching repoRoot's documented contract) rather than this
  // test file's URL (two levels under, in bin/tests/), which would resolve
  // to bin/ instead of the repo root.
  const root = repoRoot(
    new URL("../check-template-format.mjs", import.meta.url),
  );

  test("finds a non-empty sorted array of .tmpl paths in the real templates/script tree, including a known file", () => {
    const templates = listTemplates(root, join(root, "templates/script"));
    expect(templates.length).toBeGreaterThan(0);
    expect(templates).toEqual([...templates].sort());
    for (const rel of templates) {
      expect(rel.endsWith(".tmpl")).toBe(true);
    }
    expect(templates.some((rel) => rel.endsWith("main.ts.tmpl"))).toBe(true);
  });

  describe("recursion over a synthetic nested tree", () => {
    let tmpRoot: string;

    afterEach(() => {
      rmSync(tmpRoot, { recursive: true, force: true });
    });

    test("finds a .tmpl file two directories deep and skips a sibling non-.tmpl file", () => {
      tmpRoot = mkdtempSync(join(tmpdir(), "check-template-format-"));
      const nestedDir = join(tmpRoot, "a", "b");
      mkdirSync(nestedDir, { recursive: true });
      writeFileSync(join(nestedDir, "deep.ts.tmpl"), "deep content");
      writeFileSync(join(nestedDir, "README.md"), "not a template");

      const found = listTemplates(tmpRoot, tmpRoot);
      expect(found).toEqual(["a/b/deep.ts.tmpl"]);
    });
  });
});

describe("targetPathFor", () => {
  test("strips the trailing .tmpl and substitutes tokens in the path", () => {
    const tokens = tokenSets().find((set) => set.label === "typical")?.tokens;
    if (tokens === undefined) {
      throw new Error("fixture drift: no 'typical' token set in tokenSets()");
    }
    expect(
      targetPathFor(
        "templates/script/src/steps/run-__SCRIPT_NAME__.ts.tmpl",
        tokens,
      ),
    ).toBe("templates/script/src/steps/run-data-sync.ts");
  });

  test("a path with no token in it just has .tmpl stripped, unchanged otherwise", () => {
    expect(
      targetPathFor("templates/script/README.md.tmpl", {
        __SCRIPT_NAME__: "data-sync",
      }),
    ).toBe("templates/script/README.md");
  });
});
