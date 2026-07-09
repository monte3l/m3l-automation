import { describe, expect, test } from "vitest";
import {
  buildOpts,
  lintMessages,
  validateClaudeTrailers,
} from "../../bin/lint-commit.mjs";

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

describe("validateClaudeTrailers", () => {
  const msg = (trailer: string): string =>
    `feat(core): add a helper\n\nBody text.\n\n${trailer}`;

  test("accepts every canonical model trailer", () => {
    for (const name of [
      "Claude Fable 5",
      "Claude Opus 4.8",
      "Claude Sonnet 5",
    ]) {
      expect(
        validateClaudeTrailers(
          msg(`Co-Authored-By: ${name} <noreply@anthropic.com>`),
        ),
      ).toEqual([]);
    }
  });

  test("rejects the historical (1M context) variant", () => {
    const errors = validateClaudeTrailers(
      msg(
        "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>",
      ),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Claude Opus 4.8 (1M context)");
    expect(errors[0]).toContain("Claude Fable 5");
  });

  test("rejects an unknown model name", () => {
    expect(
      validateClaudeTrailers(
        msg("Co-Authored-By: Claude Sonnet 9000 <noreply@anthropic.com>"),
      ),
    ).toHaveLength(1);
  });

  test("rejects a canonical name with the wrong email", () => {
    expect(
      validateClaudeTrailers(
        msg("Co-Authored-By: Claude Opus 4.8 <claude@example.com>"),
      ),
    ).toHaveLength(1);
  });

  test("accepts a message with no trailer at all", () => {
    expect(validateClaudeTrailers("fix(x): plain message")).toEqual([]);
  });

  test("ignores non-Claude co-authors", () => {
    expect(
      validateClaudeTrailers(
        msg("Co-Authored-By: Jane Doe <jane@example.com>"),
      ),
    ).toEqual([]);
  });

  test("reports each offending trailer in a multi-trailer message", () => {
    const errors = validateClaudeTrailers(
      msg(
        "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>\n" +
          "Co-Authored-By: Claude Bogus <noreply@anthropic.com>",
      ),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Claude Bogus");
  });

  test("matches the trailer key case-insensitively", () => {
    expect(
      validateClaudeTrailers(
        msg("co-authored-by: Claude Bogus <noreply@anthropic.com>"),
      ),
    ).toHaveLength(1);
  });
});
