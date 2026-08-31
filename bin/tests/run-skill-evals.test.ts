import { describe, expect, test } from "vitest";
import {
  CRITERION_KEYS,
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  EVAL_ALLOWED_TOOLS,
  VERDICT_SCHEMA,
  buildClaudeArgs,
  DEFAULT_MAX_BUDGET_USD,
  EVAL_AVAILABLE_TOOLS,
  buildGradedPrompt,
  parseVerdictEnvelope,
  renderChecklistEntry,
  selectChecklist,
} from "../../bin/run-skill-evals.mjs";

describe("DEFAULT_MODEL and DEFAULT_EFFORT", () => {
  test("pin the model/effort documented for this workflow script", () => {
    expect(DEFAULT_MODEL).toBe("claude-sonnet-5");
    expect(DEFAULT_EFFORT).toBe("medium");
  });
});

describe("VERDICT_SCHEMA", () => {
  test("declares the structured verdict object shape", () => {
    expect(VERDICT_SCHEMA.type).toBe("object");
    expect(VERDICT_SCHEMA.properties).toHaveProperty("pass");
    expect(VERDICT_SCHEMA.properties).toHaveProperty("unmet_expectations");
    expect(VERDICT_SCHEMA.properties).toHaveProperty("reasoning");
    expect(VERDICT_SCHEMA.required).toEqual([
      "pass",
      "unmet_expectations",
      "reasoning",
    ]);
    expect(VERDICT_SCHEMA.additionalProperties).toBe(false);
  });
});

describe("buildGradedPrompt", () => {
  test("includes the original prompt, expected output, numbered expectations, and the grading marker", () => {
    const evalCase = {
      prompt: "Write a haiku about pnpm.",
      expected_output: "A three-line haiku mentioning pnpm.",
      expectations: [
        "mentions pnpm by name",
        "has exactly three lines",
        "reads as a haiku",
      ],
    };

    const built = buildGradedPrompt(evalCase);

    expect(built).toContain(evalCase.prompt);
    expect(built).toContain(evalCase.expected_output);
    expect(built).toContain("EVAL GRADING");
    expect(built).toContain("1. mentions pnpm by name");
    expect(built).toContain("2. has exactly three lines");
    expect(built).toContain("3. reads as a haiku");
  });

  test("does not throw and omits numbered lines when expectations is empty", () => {
    const evalCase = {
      prompt: "Do a thing.",
      expected_output: "A thing was done.",
      expectations: [],
    };

    let built = "";
    expect(() => {
      built = buildGradedPrompt(evalCase);
    }).not.toThrow();

    expect(built).toContain(evalCase.prompt);
    expect(built).toContain(evalCase.expected_output);
    expect(built).toContain("EVAL GRADING");
    expect(built).not.toMatch(/^1\. /m);
  });

  // The four shapes below are the ONLY ones the real corpus uses. The test
  // this replaced passed `assertions: ["check one", "check two"]` — bare
  // strings under `assertions`, a shape zero evals.json has ever used — so
  // it was green while all 123 object entries rendered as "[object Object]".
  test.each([
    {
      shape: "{name, description} (auditing, triaging-ci, ...)",
      assertions: [
        {
          name: "parallel_explore_agents",
          description: "spawns Explore agents in parallel",
        },
        { name: "no_code_written", description: "writes no code" },
      ],
      expected: ["1. spawns Explore agents in parallel", "2. writes no code"],
      absent: ["parallel_explore_agents", "no_code_written"],
    },
    {
      shape:
        "{id, description} (writing-work-logs, promoting-work-log-lessons)",
      assertions: [
        {
          id: "correct-filename",
          description: "uses the docs/logs/YYYY-MM-DD-slug.md name",
        },
      ],
      expected: ["1. uses the docs/logs/YYYY-MM-DD-slug.md name"],
      absent: ["correct-filename"],
    },
    {
      shape: "{text, passed, evidence} (resolving-pr-comments)",
      assertions: [
        { text: "parses only Must-fix findings", passed: false, evidence: "" },
      ],
      expected: ["1. parses only Must-fix findings"],
      absent: ["passed", "evidence", "false"],
    },
    {
      shape: "bare strings under assertions",
      assertions: ["check one", "check two"],
      expected: ["1. check one", "2. check two"],
      absent: [],
    },
  ])(
    "renders $shape as real criterion text, never an identifier",
    ({ assertions, expected, absent }) => {
      const built = buildGradedPrompt({
        prompt: "Do the thing.",
        expected_output: "The thing was done.",
        assertions,
      });

      for (const line of expected) expect(built).toContain(line);
      expect(built).not.toContain("[object Object]");
      // Identifiers and result fields must never reach the grader: it would
      // read "correct-filename" / `false` / "" as if each were a criterion.
      for (const leak of absent) expect(built).not.toContain(leak);
    },
  );

  test("does not throw and omits numbered lines when neither expectations nor assertions is present", () => {
    const evalCase = {
      prompt: "Do a thing.",
      expected_output: "A thing was done.",
    };

    let built = "";
    expect(() => {
      built = buildGradedPrompt(evalCase);
    }).not.toThrow();

    expect(built).toContain(evalCase.prompt);
    expect(built).toContain(evalCase.expected_output);
    expect(built).toContain("EVAL GRADING");
    expect(built).not.toMatch(/^1\. /m);
  });

  test("prefers expectations over assertions when both are present", () => {
    const evalCase = {
      prompt: "Write a haiku about pnpm.",
      expected_output: "A three-line haiku mentioning pnpm.",
      expectations: ["mentions pnpm by name"],
      assertions: ["check one", "check two"],
    };

    const built = buildGradedPrompt(evalCase);

    expect(built).toContain("1. mentions pnpm by name");
    expect(built).not.toContain("check one");
    expect(built).not.toContain("check two");
  });
});

describe("parseVerdictEnvelope", () => {
  test("parses a successful envelope into a verdict with cost", () => {
    const stdout = JSON.stringify({
      is_error: false,
      subtype: "success",
      total_cost_usd: 0.15,
      structured_output: {
        pass: true,
        unmet_expectations: [],
        reasoning: "looks good",
      },
    });

    expect(parseVerdictEnvelope(stdout)).toEqual({
      pass: true,
      unmet_expectations: [],
      reasoning: "looks good",
      costUsd: 0.15,
    });
  });

  test("returns an error when stdout is not valid JSON", () => {
    const result = parseVerdictEnvelope("not json");
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain(
      "did not return valid JSON",
    );
    expect(result).not.toHaveProperty("pass");
  });

  test("returns an error when the envelope reports is_error true", () => {
    const stdout = JSON.stringify({
      is_error: true,
      subtype: "error_max_turns",
      structured_output: {
        pass: false,
        unmet_expectations: [],
        reasoning: "",
      },
    });

    const result = parseVerdictEnvelope(stdout);
    expect(result).toHaveProperty("error");
    expect(result).not.toHaveProperty("pass");
  });

  test("returns an error when structured_output is absent", () => {
    const stdout = JSON.stringify({
      is_error: false,
      subtype: "success",
      total_cost_usd: 0.01,
    });

    const result = parseVerdictEnvelope(stdout);
    expect(result).toHaveProperty("error");
    expect(result).not.toHaveProperty("pass");
  });

  test("defaults unmet_expectations and reasoning when structured_output omits them", () => {
    const stdout = JSON.stringify({
      is_error: false,
      subtype: "success",
      total_cost_usd: 0.02,
      structured_output: {
        pass: true,
      },
    });

    expect(parseVerdictEnvelope(stdout)).toEqual({
      pass: true,
      unmet_expectations: [],
      reasoning: "",
      costUsd: 0.02,
    });
  });
});

describe("renderChecklistEntry", () => {
  test("returns a non-empty string entry unchanged", () => {
    expect(renderChecklistEntry("mentions pnpm by name")).toBe(
      "mentions pnpm by name",
    );
  });

  test.each(CRITERION_KEYS)("reads the criterion from %s", (key) => {
    expect(renderChecklistEntry({ [key]: "the criterion" })).toBe(
      "the criterion",
    );
  });

  test("prefers description over text when both are present", () => {
    expect(renderChecklistEntry({ description: "wins", text: "loses" })).toBe(
      "wins",
    );
  });

  test("ignores identifier and result fields when picking the criterion", () => {
    expect(
      renderChecklistEntry({
        id: "correct-filename",
        name: "also-an-id",
        passed: false,
        evidence: "",
        description: "the only real criterion",
      }),
    ).toBe("the only real criterion");
  });

  test.each([
    { label: "an identifier-only object", entry: { name: "no-criterion" } },
    { label: "an unknown shape", entry: { foo: "bar" } },
    { label: "an empty string", entry: "" },
    { label: "a whitespace-only string", entry: "   " },
    { label: "an empty description", entry: { description: "" } },
    { label: "a non-string description", entry: { description: 42 } },
    { label: "null", entry: null },
    { label: "a number", entry: 7 },
  ])(
    "returns null for $label rather than silently stringifying it",
    ({ entry }) => {
      expect(renderChecklistEntry(entry)).toBeNull();
    },
  );
});

describe("selectChecklist", () => {
  test("prefers expectations over assertions", () => {
    expect(selectChecklist({ expectations: ["a"], assertions: ["b"] })).toEqual(
      { key: "expectations", entries: ["a"] },
    );
  });

  test("falls back to assertions when expectations is absent", () => {
    expect(selectChecklist({ assertions: ["b"] })).toEqual({
      key: "assertions",
      entries: ["b"],
    });
  });

  test("reports no key when neither is present (syncing-docs)", () => {
    expect(selectChecklist({})).toEqual({ key: null, entries: [] });
  });

  test("treats a present-but-non-array key as no checklist", () => {
    expect(selectChecklist({ expectations: "not an array" })).toEqual({
      key: null,
      entries: [],
    });
  });
});

describe("buildGradedPrompt checklist section", () => {
  test("omits the Expectations header entirely when nothing renders", () => {
    const built = buildGradedPrompt({
      prompt: "Do a thing.",
      expected_output: "A thing was done.",
    });

    // A bare header with no criteria under it invites the grader to invent
    // its own — syncing-docs' three cases got exactly that.
    expect(built).not.toContain("Expectations (all must hold for pass=true):");
    expect(built).toContain("EVAL GRADING");
  });

  test("emits the header when at least one entry renders", () => {
    const built = buildGradedPrompt({
      prompt: "Do a thing.",
      expected_output: "A thing was done.",
      expectations: ["a real criterion"],
    });

    expect(built).toContain("Expectations (all must hold for pass=true):");
    expect(built).toContain("1. a real criterion");
  });

  test("numbers renderable entries consecutively, skipping unrenderable ones", () => {
    const built = buildGradedPrompt({
      prompt: "Do a thing.",
      expected_output: "A thing was done.",
      assertions: [
        { description: "first" },
        { name: "unrenderable-id-only" },
        { description: "second" },
      ],
    });

    expect(built).toContain("1. first");
    expect(built).toContain("2. second");
    expect(built).not.toContain("3.");
    expect(built).not.toContain("unrenderable-id-only");
  });
});

const FORBIDDEN_TOOLS = [
  "Bash",
  "BashOutput",
  "PowerShell",
  "REPL",
  "WebFetch",
  "WebSearch",
  "Agent",
  "Task",
];

describe("EVAL_ALLOWED_TOOLS", () => {
  // Kept, but note what it does and does not prove. `--allowedTools`
  // pre-approves permission; it never removed a tool, so this block states a
  // real invariant about the permission grant while saying nothing about
  // what EXISTS in the session. The existence invariant lives in the
  // EVAL_AVAILABLE_TOOLS block below.
  test.each(FORBIDDEN_TOOLS)(
    "never pre-approves %s — no command-running or network tool",
    (tool) => {
      expect(EVAL_ALLOWED_TOOLS).not.toContain(tool);
    },
  );

  test("grants exactly the read plus confined-write set the evals need", () => {
    expect(EVAL_ALLOWED_TOOLS).toEqual([
      "Read",
      "Grep",
      "Glob",
      "Write",
      "Edit",
    ]);
  });
});

describe("EVAL_AVAILABLE_TOOLS", () => {
  // THE safety AND hermeticity invariant of the sandbox. `--tools` is the
  // only flag that removes a built-in, so this list is what stands between
  // the harness and a live `git push` — or a subagent fanning out to the
  // network via WebFetch.
  test.each(FORBIDDEN_TOOLS)(
    "never makes %s exist — no command-running, network or subagent tool",
    (tool) => {
      expect(EVAL_AVAILABLE_TOOLS).not.toContain(tool);
    },
  );

  test("includes Skill, without which skills are invisible to the session", () => {
    // Measured, not assumed: with --tools "Read,Grep,Glob,Write,Edit" a probe
    // session rooted at a dir containing .claude/skills/ could not see the
    // skill under test; adding Skill restored visibility AND invocation.
    // Dropping this reproduces the CI-run-33390425486 defect silently.
    expect(EVAL_AVAILABLE_TOOLS).toContain("Skill");
  });

  test("is the permission grant plus Skill, and nothing else", () => {
    expect(EVAL_AVAILABLE_TOOLS).toEqual([...EVAL_ALLOWED_TOOLS, "Skill"]);
  });
});

describe("buildClaudeArgs", () => {
  const args = buildClaudeArgs("the graded prompt", {
    model: "claude-sonnet-5",
    effort: "medium",
  });

  test("never passes --restricted, which suppressed skill discovery", () => {
    // A probe measured this directly: with --restricted a session rooted at a
    // directory containing .claude/skills/ listed ZERO of the 21 repo skills;
    // without it, all 21. Re-adding the flag makes every verdict meaningless.
    expect(args).not.toContain("--restricted");
  });

  test("pins settings to the synthetic project root for reproducibility", () => {
    // Without this the session also loads ~/.claude, and a local run sees the
    // developer's personal plugin skills that CI would never have.
    expect(args).toContain("--setting-sources");
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("project");
  });

  test("passes the allowlist as the permission pre-approval", () => {
    expect(args).toContain("--allowedTools");
    expect(args[args.indexOf("--allowedTools") + 1]).toBe(
      EVAL_ALLOWED_TOOLS.join(","),
    );
  });

  test("restricts the built-in set with --tools, the flag that removes", () => {
    // The assertion the previous suite lacked. Checking EVAL_ALLOWED_TOOLS'
    // CONTENTS was literally true and guarded nothing: the argv carried no
    // restricting flag at all, so Bash and Agent existed in every graded
    // session. Only emitting --tools removes them, so only this asserts it.
    expect(args).toContain("--tools");
    expect(args[args.indexOf("--tools") + 1]).toBe(
      EVAL_AVAILABLE_TOOLS.join(","),
    );
  });

  test.each(FORBIDDEN_TOOLS)(
    "argv never makes %s available to a graded session",
    (tool) => {
      // Resolve the index first and assert it: reading
      // `args[indexOf(...) + 1]` on an absent flag yields args[0], which
      // trivially contains no tool name — so without this the whole block
      // stays green when --tools is deleted, guarding nothing.
      const flagIndex = args.indexOf("--tools");
      expect(flagIndex).toBeGreaterThan(-1);
      expect(args[flagIndex + 1]?.split(",")).not.toContain(tool);
    },
  );

  test("bounds per-case spend with --max-budget-usd", () => {
    // A wall-clock job timeout cannot express this: one runaway case can burn
    // the run's whole budget inside the timeout and starve the rest.
    expect(args).toContain("--max-budget-usd");
    expect(args[args.indexOf("--max-budget-usd") + 1]).toBe(
      String(DEFAULT_MAX_BUDGET_USD),
    );
  });

  test("lets a caller override the per-case budget", () => {
    const custom = buildClaudeArgs("p", {
      model: "claude-sonnet-5",
      effort: "medium",
      maxBudgetUsd: 1.25,
    });
    expect(custom[custom.indexOf("--max-budget-usd") + 1]).toBe("1.25");
  });

  test("runs non-interactively with the verdict schema and the given model", () => {
    expect(args[0]).toBe("-p");
    expect(args[1]).toBe("the graded prompt");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(args).toContain("--strict-mcp-config");
    expect(args[args.indexOf("--output-format") + 1]).toBe("json");
    expect(args[args.indexOf("--json-schema") + 1]).toBe(
      JSON.stringify(VERDICT_SCHEMA),
    );
    expect(args[args.indexOf("--model") + 1]).toBe("claude-sonnet-5");
    expect(args[args.indexOf("--effort") + 1]).toBe("medium");
  });
});

describe("parseVerdictEnvelope diagnostics", () => {
  test("names the envelope's own fields when structured_output is missing", () => {
    // 4 cases failed this way in CI run 33390425486 with one opaque message.
    const stdout = JSON.stringify({
      is_error: false,
      subtype: "success",
      num_turns: 12,
      stop_reason: "end_turn",
      result: "I have completed the analysis.",
    });

    const error = (parseVerdictEnvelope(stdout) as { error: string }).error;

    expect(error).toContain("subtype: success");
    expect(error).toContain("num_turns: 12");
    expect(error).toContain("stop_reason: end_turn");
    expect(error).toContain("I have completed the analysis.");
  });

  test("truncates a long result rather than dumping the whole transcript", () => {
    const stdout = JSON.stringify({
      is_error: false,
      subtype: "success",
      result: "x".repeat(5000),
    });

    const error = (parseVerdictEnvelope(stdout) as { error: string }).error;

    expect(error).toContain("x".repeat(200));
    expect(error).not.toContain("x".repeat(201));
  });

  test("marks an absent result explicitly instead of an empty gap", () => {
    const stdout = JSON.stringify({ is_error: false, subtype: "success" });
    const error = (parseVerdictEnvelope(stdout) as { error: string }).error;

    expect(error).toContain("result: <empty>");
    expect(error).toContain("stop_reason: unset");
  });
});
