import { describe, expect, test } from "vitest";
import { buildOpts, lintMessages } from "../../bin/lint-commit.mjs";

describe("buildOpts", () => {
  test("forwards the preset's parserOpts (so the ! marker parses)", () => {
    const parserOpts = { headerPattern: /^(\w*)(?:\((.*)\))?!?: (.*)$/ };
    const opts = buildOpts({
      defaultIgnores: true,
      ignores: [],
      parserPreset: { parserOpts },
    });
    expect(opts.parserOpts).toBe(parserOpts);
    expect(opts.defaultIgnores).toBe(true);
  });

  test("omits parserOpts when the config has no parser preset", () => {
    const opts = buildOpts({ defaultIgnores: false, ignores: [] });
    expect("parserOpts" in opts).toBe(false);
  });

  test("omits parserOpts when the preset carries no parserOpts", () => {
    const opts = buildOpts({ parserPreset: {} });
    expect("parserOpts" in opts).toBe(false);
  });
});

describe("lintMessages (real repo commitlint config)", () => {
  test("accepts the ! breaking marker — the bug this fix closes", async () => {
    const results = await lintMessages([
      "feat!: drop the aws export",
      "feat(aws)!: drop the export",
    ]);
    expect(results.map((r) => r.valid)).toEqual([true, true]);
  });

  test("accepts a plain header and a BREAKING CHANGE footer form", async () => {
    const results = await lintMessages([
      "feat(core): add a helper",
      "feat(core): retype the barrel\n\nBREAKING CHANGE: ./core changed",
    ]);
    expect(results.map((r) => r.valid)).toEqual([true, true]);
  });

  test("still rejects a non-conventional header", async () => {
    const results = await lintMessages(["nonsense with no type"]);
    expect(results.map((r) => r.valid)).toEqual([false]);
    expect(results.flatMap((r) => r.errors.map((e) => e.name))).toContain(
      "type-empty",
    );
  });

  test("lints each message independently in a batch", async () => {
    const results = await lintMessages([
      "feat!: ok",
      "broken header",
      "fix(x): ok",
    ]);
    expect(results.map((r) => r.valid)).toEqual([true, false, true]);
  });
});
