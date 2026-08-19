import { execFileSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import {
  CANONICAL_CLAUDE_MODELS,
  CO_AUTHOR_EMAIL,
  HISTORICAL_ALIASES,
  isValidAgentModel,
  isValidEffort,
  isValidWorkflowModel,
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

describe("isValidAgentModel", () => {
  // Full model IDs now pinned by the nine spoke agents after the pin-to-exact-ID
  // migration. These must match MODEL_ID_PATTERN (`/^claude-[a-z]+-[a-z0-9-]+$/`);
  // a future narrowing of that pattern would silently break all nine spokes
  // without a failing test.
  test.each([["claude-sonnet-5"], ["claude-opus-5"], ["claude-haiku-4-5"]])(
    "accepts the full ID %s",
    (id) => {
      expect(isValidAgentModel(id)).toBe(true);
    },
  );

  test("accepts a dated full ID (e.g. claude-haiku-4-5-20251001)", () => {
    // Dated IDs append a YYYYMMDD suffix; the pattern's `[a-z0-9-]+` covers them.
    expect(isValidAgentModel("claude-haiku-4-5-20251001")).toBe(true);
  });

  test.each([["sonnet"], ["opus"], ["haiku"], ["fable"], ["inherit"]])(
    "accepts the bare alias %s",
    (alias) => {
      expect(isValidAgentModel(alias)).toBe(true);
    },
  );

  test("rejects undefined", () => {
    expect(isValidAgentModel(undefined)).toBe(false);
  });

  test.each([
    // Uppercase letters: MODEL_ID_PATTERN is lowercase-only (`[a-z]`).
    ["Claude-Sonnet-5"],
    // Missing version segment: pattern requires `claude-<family>-<version>`.
    ["claude-sonnet"],
    // Wrong vendor prefix: must start with `claude-`.
    ["gpt-5"],
    // Empty string.
    [""],
  ])("rejects malformed value %s", (value) => {
    expect(isValidAgentModel(value)).toBe(false);
  });
});

describe("isValidWorkflowModel", () => {
  test.each([["claude-sonnet-5"], ["claude-opus-5"], ["claude-haiku-4-5"]])(
    "accepts the full ID %s",
    (id) => {
      expect(isValidWorkflowModel(id)).toBe(true);
    },
  );

  // Workflow model validation is a superset of agent model validation; every
  // alias legal in an agent frontmatter must also be legal for a workflow pin.
  test.each([["sonnet"], ["opus"], ["haiku"], ["fable"], ["inherit"]])(
    "accepts the agent alias %s",
    (alias) => {
      expect(isValidWorkflowModel(alias)).toBe(true);
    },
  );

  test.each([["default"], ["best"], ["opusplan"], ["opus[1m]"]])(
    "accepts the workflow-only alias %s",
    (alias) => {
      expect(isValidWorkflowModel(alias)).toBe(true);
    },
  );

  test("rejects undefined", () => {
    expect(isValidWorkflowModel(undefined)).toBe(false);
  });

  test("rejects a malformed model string", () => {
    expect(isValidWorkflowModel("gpt-5")).toBe(false);
  });

  // `opusplan` is a session-level alias documented only for workflow `--model`
  // pins (opus during plan mode, sonnet for execution). It is intentionally
  // absent from AGENT_MODEL_ALIASES so check-agents.mjs rejects it in agent
  // frontmatter while check-workflows.mjs accepts it in workflow invocations.
  // This asymmetry is the contract distinction between the two functions.
  test("opusplan is valid for a workflow but not for an agent", () => {
    expect(isValidWorkflowModel("opusplan")).toBe(true);
    expect(isValidAgentModel("opusplan")).toBe(false);
  });
});

describe("isValidEffort", () => {
  test.each([["low"], ["medium"], ["high"], ["xhigh"], ["max"]])(
    "accepts the effort level %s",
    (level) => {
      expect(isValidEffort(level)).toBe(true);
    },
  );

  test("rejects undefined", () => {
    expect(isValidEffort(undefined)).toBe(false);
  });

  test("rejects an unknown effort level", () => {
    expect(isValidEffort("extreme")).toBe(false);
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
