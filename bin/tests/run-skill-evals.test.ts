import { describe, expect, test } from "vitest";
import {
  CRITERION_KEYS,
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  EVAL_ALLOWED_TOOLS,
  EVAL_SANDBOX_PREAMBLE,
  RESULT_EXCERPT_CHARS,
  VERDICT_SCHEMA,
  buildClaudeArgs,
  buildGradedPrompt,
  DEFAULT_MAX_BUDGET_USD,
  describeSpawnFailure,
  evaluateSkillFired,
  EVAL_AVAILABLE_TOOLS,
  extractInvokedSkills,
  extractResultEnvelope,
  parseStreamEvents,
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
    expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json");
    // `claude -p --output-format stream-json` without `--verbose` fails fast
    // with "requires --verbose" instead of streaming anything.
    expect(args).toContain("--verbose");
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

describe("EVAL_SANDBOX_PREAMBLE", () => {
  test("contains the sandbox marker, WOULD-RUN, WOULD-DISPATCH, and the no-tools contract", () => {
    // a) Assert all required literal markers are present.
    expect(EVAL_SANDBOX_PREAMBLE).toContain("--- EVAL SANDBOX ---");
    expect(EVAL_SANDBOX_PREAMBLE).toContain("WOULD-RUN:");
    expect(EVAL_SANDBOX_PREAMBLE).toContain("WOULD-DISPATCH:");
    expect(EVAL_SANDBOX_PREAMBLE).toContain("no Bash");
    expect(EVAL_SANDBOX_PREAMBLE).toContain("no network access");
    expect(EVAL_SANDBOX_PREAMBLE).toContain("no subagent tool");
  });

  test("buildGradedPrompt embeds EVAL_SANDBOX_PREAMBLE verbatim in the built prompt", () => {
    // b) Containment: the preamble must appear in the output, not just parts of it.
    const built = buildGradedPrompt({
      prompt: "Do the thing.",
      expected_output: "The thing was done.",
      expectations: ["a criterion"],
    });
    expect(built).toContain(EVAL_SANDBOX_PREAMBLE);
  });

  test("preamble appears after the case prompt and before the EVAL GRADING block", () => {
    // c) Ordering: a preamble appended after the grading block would leak
    // into the grading instructions, inverting the intended evaluation flow.
    const evalCase = {
      prompt: "Do the thing.",
      expected_output: "The thing was done.",
      expectations: ["a criterion"],
    };
    const built = buildGradedPrompt(evalCase);
    const promptIdx = built.indexOf(evalCase.prompt);
    const preambleIdx = built.indexOf(EVAL_SANDBOX_PREAMBLE);
    const gradingIdx = built.indexOf(
      "--- EVAL GRADING (not part of the request above) ---",
    );

    expect(preambleIdx).toBeGreaterThan(promptIdx);
    expect(preambleIdx).toBeLessThan(gradingIdx);
  });

  test("preamble is emitted even when the case has no checklist entries", () => {
    // d) The sandbox contract is unconditional: even the rendered.length === 0
    // branch (no expectations, no assertions key) must still emit the preamble.
    const built = buildGradedPrompt({
      prompt: "Do the thing.",
      expected_output: "The thing was done.",
    });
    expect(built).toContain(EVAL_SANDBOX_PREAMBLE);
    expect(built).toContain("--- EVAL SANDBOX ---");
  });
});

describe("describeSpawnFailure", () => {
  test("surfaces the message and stderr, omits empty stdout", () => {
    // a) Typical execFileSync failure: stderr has the real cause; stdout is
    // empty and must be omitted so the error message stays readable.
    const result = describeSpawnFailure({
      message: "Command failed: claude -p",
      stderr: "Invalid API key",
      stdout: "",
    });
    expect(result).toContain("claude -p invocation failed");
    expect(result).toContain("Command failed: claude -p");
    expect(result).toContain("Invalid API key");
    expect(result).not.toContain("stdout:");
  });

  test("surfaces stdout when stderr is absent or empty", () => {
    // b) Some failures populate stdout instead; the error text must appear.
    const result = describeSpawnFailure({
      message: "Command failed: claude -p",
      stderr: "",
      stdout: "some output text",
    });
    expect(result).toContain("some output text");
    expect(result).not.toContain("stderr:");
  });

  test("converts a Buffer stderr to readable text, not [object Object]", () => {
    // c) Node yields stderr as a Buffer when no encoding was set on execFileSync.
    // String(Buffer) calls toString() with the default UTF-8 encoding, so the
    // content — not the object representation — must appear in the result.
    const result = describeSpawnFailure({
      message: "Command failed: claude -p",
      stderr: Buffer.from("Buffer error text"),
      stdout: "",
    });
    expect(result).toContain("Buffer error text");
    expect(result).not.toContain("[object Object]");
  });

  test("truncates a stream longer than RESULT_EXCERPT_CHARS to a bounded length", () => {
    // d) A 16 MB buffer cannot flood the summary: each stream is capped.
    // Assert the result length is bounded rather than pinning an exact length.
    const longText = "e".repeat(RESULT_EXCERPT_CHARS + 100);
    const result = describeSpawnFailure({
      message: "Command failed: claude -p",
      stderr: longText,
      stdout: "",
    });
    const segments = result.split(" | ");
    const stderrSegment = segments.find((s) => s.startsWith("stderr:")) ?? "";
    // "stderr: " prefix (8 chars) + at most RESULT_EXCERPT_CHARS + 1 ellipsis char
    expect(stderrSegment.length).toBeLessThanOrEqual(
      "stderr: ".length + RESULT_EXCERPT_CHARS + 1,
    );
    expect(result).toContain("…");
  });

  test("produces the prefix with no dangling separator when neither stderr nor stdout is present", () => {
    // e) An error with only a message must not produce orphaned " | " segments.
    const result = describeSpawnFailure({
      message: "Command failed: claude -p",
    });
    expect(result).toContain("claude -p invocation failed:");
    expect(result).not.toContain(" | ");
  });
});

describe("parseStreamEvents", () => {
  test("parses multi-line NDJSON into an array of event objects", () => {
    const stdout = [
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({ type: "assistant", message: { content: [] } }),
      JSON.stringify({ type: "result", is_error: false }),
    ].join("\n");

    expect(parseStreamEvents(stdout)).toEqual([
      { type: "system", subtype: "init" },
      { type: "assistant", message: { content: [] } },
      { type: "result", is_error: false },
    ]);
  });

  test("skips blank lines, including the trailing newline", () => {
    const stdout = `${JSON.stringify({ type: "system" })}\n\n${JSON.stringify({
      type: "result",
    })}\n`;

    expect(parseStreamEvents(stdout)).toEqual([
      { type: "system" },
      { type: "result" },
    ]);
  });

  test("parses a single JSON object with no trailing newline", () => {
    const stdout = JSON.stringify({ type: "result", is_error: false });
    expect(parseStreamEvents(stdout)).toEqual([
      { type: "result", is_error: false },
    ]);
  });

  test("throws when a non-blank line is not valid JSON", () => {
    const stdout = `${JSON.stringify({ type: "system" })}\nnot json\n`;
    expect(() => parseStreamEvents(stdout)).toThrow();
  });
});

describe("extractInvokedSkills", () => {
  test("extracts the skill name from a Skill tool_use block, ignoring other tool_use blocks", () => {
    // Real captured shape: a Skill invocation alongside a Read tool_use in the
    // same assistant message. Only the Skill block's `input.skill` counts.
    const events = [
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "toolu_01UK1nExhWvhLYW7Ugv1Yqmg",
              name: "Skill",
              input: { skill: "triaging-ci", args: "12345" },
              caller: { type: "direct" },
            },
            {
              type: "tool_use",
              id: "toolu_01Vm5z6F6b69fUWLdVkPnnZj",
              name: "Read",
              input: { file_path: "/some/path" },
              caller: { type: "direct" },
            },
          ],
        },
      },
    ];

    expect(extractInvokedSkills(events)).toEqual(["triaging-ci"]);
  });

  test("returns an empty array when an assistant event has no content array", () => {
    const events = [{ type: "assistant", message: {} }];
    expect(extractInvokedSkills(events)).toEqual([]);
  });

  test("returns an empty array when content has no tool_use blocks", () => {
    const events = [
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "hello" }] },
      },
    ];
    expect(extractInvokedSkills(events)).toEqual([]);
  });

  test("ignores non-assistant events entirely", () => {
    const events = [
      { type: "system", subtype: "init" },
      { type: "result", is_error: false },
    ];
    expect(extractInvokedSkills(events)).toEqual([]);
  });

  test("keeps every invocation in call order when a skill fires more than once", () => {
    const events = [
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "Skill",
              input: { skill: "triaging-ci" },
            },
          ],
        },
      },
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "Skill",
              input: { skill: "starting-work" },
            },
          ],
        },
      },
    ];

    expect(extractInvokedSkills(events)).toEqual([
      "triaging-ci",
      "starting-work",
    ]);
  });

  test("keeps a duplicate entry when the same skill fires twice", () => {
    const events = [
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "Skill",
              input: { skill: "triaging-ci" },
            },
            {
              type: "tool_use",
              name: "Skill",
              input: { skill: "triaging-ci" },
            },
          ],
        },
      },
    ];

    expect(extractInvokedSkills(events)).toEqual([
      "triaging-ci",
      "triaging-ci",
    ]);
  });
});

describe("extractResultEnvelope", () => {
  test("returns null when no result-typed event is present", () => {
    const events = [
      { type: "system", subtype: "init" },
      { type: "assistant", message: { content: [] } },
    ];
    expect(extractResultEnvelope(events)).toBeNull();
  });

  test("returns the LAST result event's JSON text when multiple are present", () => {
    const firstResult = {
      type: "result",
      is_error: false,
      subtype: "success",
      total_cost_usd: 0.01,
      structured_output: {
        pass: true,
        unmet_expectations: [],
        reasoning: "first, should be superseded",
      },
    };
    const secondResult = {
      type: "result",
      is_error: false,
      subtype: "success",
      total_cost_usd: 0.2,
      structured_output: {
        pass: false,
        unmet_expectations: ["did not meet criterion"],
        reasoning: "second, and authoritative",
      },
    };
    const events = [
      { type: "system", subtype: "init" },
      firstResult,
      { type: "assistant", message: { content: [] } },
      secondResult,
    ];

    const envelope = extractResultEnvelope(events);
    expect(envelope).not.toBeNull();
    expect(JSON.parse(envelope as string)).toEqual(secondResult);
  });

  test("chains into parseVerdictEnvelope to produce a real verdict", () => {
    // Integration-style: prove the JSON text this function returns is exactly
    // what parseVerdictEnvelope expects — the same envelope shape the old
    // single-object `--output-format json` used to return directly.
    const resultEvent = {
      type: "result",
      is_error: false,
      subtype: "success",
      total_cost_usd: 0.05,
      structured_output: {
        pass: true,
        unmet_expectations: [],
        reasoning: "chained from stream-json",
      },
    };
    const events = [{ type: "system", subtype: "init" }, resultEvent];

    const envelope = extractResultEnvelope(events);
    expect(envelope).not.toBeNull();

    const verdict = parseVerdictEnvelope(envelope as string);
    expect(verdict).toEqual({
      pass: true,
      unmet_expectations: [],
      reasoning: "chained from stream-json",
      costUsd: 0.05,
    });
  });
});

describe("evaluateSkillFired", () => {
  test.each([
    {
      label: "required and fired",
      evalCase: {},
      invokedSkills: ["triaging-ci"],
      expected: { required: true, fired: true, met: true },
    },
    {
      label: "required and not fired",
      evalCase: {},
      invokedSkills: [],
      expected: { required: true, fired: false, met: false },
    },
    {
      label: "opted out (expect_skill_fired: false) and fired anyway",
      evalCase: { expect_skill_fired: false },
      invokedSkills: ["triaging-ci"],
      expected: { required: false, fired: true, met: true },
    },
    {
      label:
        "opted out (expect_skill_fired: false) and not fired — the deliberate skip case",
      evalCase: { expect_skill_fired: false },
      invokedSkills: [],
      expected: { required: false, fired: false, met: true },
    },
  ])("$label", ({ evalCase, invokedSkills, expected }) => {
    expect(evaluateSkillFired("triaging-ci", invokedSkills, evalCase)).toEqual(
      expected,
    );
  });

  test("treats any non-literal-false value (e.g. true) as required", () => {
    expect(
      evaluateSkillFired("starting-work", ["starting-work"], {
        expect_skill_fired: true,
      }),
    ).toEqual({ required: true, fired: true, met: true });
  });
});
