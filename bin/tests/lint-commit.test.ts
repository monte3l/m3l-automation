import { describe, expect, test } from "vitest";
import {
  buildOpts,
  isDependabotAuthor,
  lintMessages,
  subjectsFromLog,
  validateClaudeTrailers,
  validateForbiddenTrailers,
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

  test("still rejects a human-shaped capitalized subject (case rule is unweakened, only range-mode author filtering changed)", async () => {
    const results = await lintMessages(["chore(deps): Bump foo from 1 to 2"]);
    expect(results.map((r) => r.valid)).toEqual([false]);
  });
});

describe("isDependabotAuthor", () => {
  test("returns true for the real dependabot[bot] address format", () => {
    expect(
      isDependabotAuthor("49699333+dependabot[bot]@users.noreply.github.com"),
    ).toBe(true);
  });

  test("returns true for the legacy support@dependabot.com address", () => {
    expect(isDependabotAuthor("support@dependabot.com")).toBe(true);
  });

  test("matches case-insensitively", () => {
    expect(isDependabotAuthor("SUPPORT@DEPENDABOT.COM")).toBe(true);
  });

  test("trims surrounding whitespace before matching", () => {
    expect(
      isDependabotAuthor(
        "  49699333+dependabot[bot]@users.noreply.github.com  ",
      ),
    ).toBe(true);
  });

  test("returns false for a human address", () => {
    expect(isDependabotAuthor("jane@example.com")).toBe(false);
  });

  // Deliberate non-broadening guarantee: the pattern must match only
  // Dependabot's own identity, not every GitHub [bot] account.
  test("returns false for github-actions[bot] (must not broaden beyond Dependabot)", () => {
    expect(
      isDependabotAuthor(
        "41898282+github-actions[bot]@users.noreply.github.com",
      ),
    ).toBe(false);
  });

  test("returns false for a numeric-id dependabot-shaped email on the wrong domain", () => {
    expect(isDependabotAuthor("1+dependabot[bot]@evil.example.com")).toBe(
      false,
    );
  });
});

describe("subjectsFromLog", () => {
  test("drops a Dependabot-authored record and keeps a human-authored one", () => {
    const log =
      "chore(deps-dev): Bump zod from 4.4.3 to 4.5.4\0" +
      "49699333+dependabot[bot]@users.noreply.github.com\n" +
      "fix(x): correct the thing\0jane@example.com\n";
    expect(subjectsFromLog(log)).toEqual(["fix(x): correct the thing"]);
  });

  test("returns an empty array for an empty string input", () => {
    expect(subjectsFromLog("")).toEqual([]);
  });

  test("returns an empty array when every record is Dependabot-authored", () => {
    const log =
      "chore(deps): Bump a from 1 to 2\0support@dependabot.com\n" +
      "chore(deps): Bump b from 1 to 2\0" +
      "49699333+dependabot[bot]@users.noreply.github.com\n";
    expect(subjectsFromLog(log)).toEqual([]);
  });

  test("preserves a subject containing : and | characters unaltered", () => {
    const log = "chore(deps): bump foo: a|b\0jane@example.com\n";
    expect(subjectsFromLog(log)).toEqual(["chore(deps): bump foo: a|b"]);
  });

  test("preserves record order for multiple human-authored subjects", () => {
    const log =
      "feat(core): first\0jane@example.com\n" +
      "fix(x): second\0john@example.com\n" +
      "chore: third\0jane@example.com\n";
    expect(subjectsFromLog(log)).toEqual([
      "feat(core): first",
      "fix(x): second",
      "chore: third",
    ]);
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

describe("validateForbiddenTrailers", () => {
  const msg = (trailer: string): string =>
    `feat(core): add a helper\n\nBody text.\n\n${trailer}`;

  test("accepts a message with only the sanctioned Co-Authored-By trailer", () => {
    expect(
      validateForbiddenTrailers(
        msg("Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"),
      ),
    ).toEqual([]);
  });

  test("rejects a Claude-Session trailer and reports the offending line", () => {
    const errors = validateForbiddenTrailers(
      msg("Claude-Session: https://claude.ai/code/session_01ABC"),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(
      "Claude-Session: https://claude.ai/code/session_01ABC",
    );
  });

  test("rejects a hypothetical future Claude-* key (pattern-wide, not hardcoded to Session)", () => {
    expect(
      validateForbiddenTrailers(msg("Claude-Run: https://example.com")),
    ).toHaveLength(1);
  });

  test("matches the trailer key case-insensitively", () => {
    expect(
      validateForbiddenTrailers(
        msg("claude-session: https://claude.ai/code/session_01ABC"),
      ),
    ).toHaveLength(1);
  });

  test("flags only the Claude-Session line when a valid Co-Authored-By is also present", () => {
    const errors = validateForbiddenTrailers(
      msg(
        "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>\n" +
          "Claude-Session: https://claude.ai/code/session_01ABC",
      ),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Claude-Session:");
  });

  test("reports each offending trailer in a multi-trailer message", () => {
    const errors = validateForbiddenTrailers(
      msg(
        "Claude-Session: https://claude.ai/code/session_01ABC\n" +
          "Claude-Run: https://example.com",
      ),
    );
    expect(errors).toHaveLength(2);
  });

  test("accepts a message with no trailer at all", () => {
    expect(validateForbiddenTrailers("fix(x): plain message")).toEqual([]);
  });
});
