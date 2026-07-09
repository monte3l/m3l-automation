import { execFileSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import {
  CANONICAL_CLAUDE_MODELS,
  CO_AUTHOR_EMAIL,
  HISTORICAL_ALIASES,
  normalizeClaudeModel,
  parseCoAuthor,
} from "../../bin/lib/claude-models.mjs";

describe("parseCoAuthor", () => {
  test("splits a well-formed trailer value into name and email", () => {
    expect(parseCoAuthor("Claude Opus 4.8 <noreply@anthropic.com>")).toEqual({
      name: "Claude Opus 4.8",
      email: "noreply@anthropic.com",
    });
  });

  test("tolerates surrounding whitespace", () => {
    expect(parseCoAuthor("  Jane Doe   <jane@example.com> ")).toEqual({
      name: "Jane Doe",
      email: "jane@example.com",
    });
  });

  test("returns null for a value without an email part", () => {
    expect(parseCoAuthor("Claude Opus 4.8")).toBeNull();
  });
});

describe("normalizeClaudeModel", () => {
  test("returns a canonical name unchanged", () => {
    for (const name of CANONICAL_CLAUDE_MODELS) {
      expect(normalizeClaudeModel(name)).toBe(name);
    }
  });

  test("folds a historical alias into its canonical name", () => {
    expect(normalizeClaudeModel("Claude Opus 4.8 (1M context)")).toBe(
      "Claude Opus 4.8",
    );
  });

  test("returns null for a name outside the sanctioned set", () => {
    expect(normalizeClaudeModel("Claude Sonnet 9000")).toBeNull();
  });

  test("every historical alias resolves to a canonical name", () => {
    for (const canonical of Object.values(HISTORICAL_ALIASES)) {
      expect(CANONICAL_CLAUDE_MODELS).toContain(canonical);
    }
  });
});

describe("completeness against git history", () => {
  // The allowlist is an enumerated literal set; scattered literals drift.
  // Scan every Claude co-author trailer ever committed and require it to
  // resolve — directly or via HISTORICAL_ALIASES — so a drifted name fails
  // the suite even if it slipped past the commit-msg hook.
  test("every Claude trailer in history resolves to a canonical model", () => {
    const trailers = execFileSync(
      "git",
      [
        "log",
        "--format=%(trailers:key=Co-Authored-By,valueonly,separator=%x0A)",
      ],
      { encoding: "utf8" },
    )
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.includes(CO_AUTHOR_EMAIL));

    const unresolved = trailers.filter((value) => {
      const parsed = parseCoAuthor(value);
      return parsed === null || normalizeClaudeModel(parsed.name) === null;
    });

    expect(unresolved).toEqual([]);
  });
});
