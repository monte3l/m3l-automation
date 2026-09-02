#!/usr/bin/env node
// `pnpm eval:skills` — repo-owned eval runner (Anthropic AI-native SDLC
// harness-alignment plan, Section 4). For every `.claude/skills/*/evals/
// evals.json` case, drives a real `claude -p` invocation inside a disposable
// synthetic project root and asks the SAME turn to both attempt the eval's
// prompt and self-grade its own response against the case's checklist,
// returned as structured JSON via `--json-schema`.
//
// This is a real, but self-graded, signal — not an independent judge call.
//
// SANDBOX — rebuilt after CI run 33390425486 graded all 46 cases against a
// Claude that could not see the skill under test. The runner used to pass
// `--restricted`, which per `claude --help` "removes the built-in tools that
// run commands or code ... and ignores user, project and local settings
// files". A three-variant probe measured what that cost: from a directory
// containing `.claude/skills/`, a `--restricted` session listed ZERO of the
// repo's skills (only built-ins), while the same session without the flag
// listed all of them. The graded transcripts had been saying so verbatim —
// "Unknown skill: triaging-ci". Every verdict measured general model
// competence rather than whether our SKILL.md files work.
//
// So `--restricted` is gone. Each case gets a fresh `mkdtempSync(tmpdir(),
// "m3l-eval-")` root with `.claude/skills/` copied in, which satisfies four
// constraints simultaneously:
//
//   - it contains `.claude/skills/`, so skills LOAD, and cross-skill
//     selection is genuinely testable (every skill is present, so picking
//     the RIGHT one counts for something)
//   - `.claude/settings.json` is deliberately NOT copied, so none of this
//     repo's own PreToolUse hooks fire inside an eval
//   - it is NOT a git repo, so `guard-branch-isolation` / `guard-hub-src-
//     writes` are inert and the real working tree cannot be touched
//   - writes are confined to the disposable workspace, so the "blocked ...
//     which is a sensitive file" denials from the old
//     `.claude/skills/<name>/eval-workspace/` location cannot recur
//   - the session is HERMETIC: no tool that reaches the network or spawns a
//     subagent exists, so a verdict measures the SKILL.md under test and
//     nothing a live fetch happened to return that day
//
// A BARE temp dir would not do: skill discovery is rooted at cwd's nearest
// `.claude/` ancestor, so a temp dir without one loads no skills either —
// the very bug being fixed. Nor could the workspace live inside the repo,
// where our own guards would deny `scaffolding-submodules`/test-author cases
// and a stray write could pollute the tree.
//
// TOOL RESTRICTION IS THREE LAYERS, and only one of them removes anything.
// An earlier version of this header claimed capability was denied by
// OMISSION from `--allowedTools`. That was false, and measurably so: per
// `claude --help` (v2.1.251) `--allowedTools` is a list of tool names to
// ALLOW — it pre-approves permission for tools that already exist and
// removes nothing. `--tools` is the flag that "specif[ies] the list of
// available tools from the built-in set". So:
//
//   1. `--tools EVAL_AVAILABLE_TOOLS` decides what EXISTS. Bash, WebFetch,
//      WebSearch and Agent are absent from the session entirely.
//   2. `--allowedTools EVAL_ALLOWED_TOOLS` pre-approves permission for what
//      remains, so a permitted Write doesn't stall on a prompt.
//   3. `--permission-mode dontAsk` denies anything not pre-approved at call
//      time, rather than hanging a non-interactive run on a prompt.
//
// Layer 1 is the one carrying the safety and hermeticity properties. Under
// the old `--allowedTools`-only argv, `Bash` was PRESENT and merely denied
// at call time by layer 3, and `Agent` was present and NOT permission-gated
// at all — so a case could fan out subagents that reached the live network
// via WebFetch, and none of the four constraints above covered it.
//
// `Skill` must stay in EVAL_AVAILABLE_TOOLS. A probe measured the cost of
// omitting it: with `--tools "Read,Grep,Glob,Write,Edit"` a session rooted
// at a directory containing `.claude/skills/` reported the skill under test
// as not visible at all, which is the CI-run-33390425486 bug (skills loaded
// but un-invokable) in a subtler form. Adding `Skill` restored both
// visibility and invocation. Deleting it from that list silently reverts
// every verdict to measuring general model competence.
//
// A case that attempts `git push` therefore finds no Bash tool at all, and
// the attempt surfaces as an unmet expectation instead of executing. Treat a
// failure as "the skill's own instructions didn't produce a plan meeting the
// bar", not as "a live command failed".
//
// `--setting-sources project` is load-bearing for REPRODUCIBILITY rather
// than for discovery: without it the session additionally loads `~/.claude`,
// and the probe watched a developer's personal plugin skills (context7-mcp,
// claude-md-management:*, remember:doctor) join the list — skills CI would
// never have. Pinning to the synthetic root makes a local run match CI.
//
// Model/effort default to DEFAULT_MODEL/DEFAULT_EFFORT below (override via
// M3L_EVAL_MODEL/M3L_EVAL_EFFORT) — this is a bin/ script, not a
// .claude/workflows/*.js Workflow-tool script, so it sits outside
// docs/contributing/model-selection.md's machine-checked MODEL-MATRIX (see
// that doc's note on this script).
//
// Usage:
//   node bin/run-skill-evals.mjs                # every skill with evals.json
//   node bin/run-skill-evals.mjs <skill-name>    # one skill only
//   node bin/run-skill-evals.mjs --json          # machine-readable summary
import process from "node:process";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonFlag, createReporter, repoRoot } from "./lib/report.mjs";

export const DEFAULT_MODEL = "claude-sonnet-5";
export const DEFAULT_EFFORT = "medium";

/**
 * Per-case spend ceiling handed to `claude --max-budget-usd`.
 *
 * A cost ceiling, not a wall-clock one: `timeout-minutes` in
 * `.github/workflows/skill-evals.yml` bounds the JOB, but a single runaway
 * case can burn the whole budget inside it and starve the remaining cases.
 * This bounds each case independently.
 *
 * Calibrated against measurement, not guessed: CI run 33390425486 graded all
 * 46 cases for ~$2.31 total (~$0.05/case). 10x that average leaves ample room
 * for a legitimately long case while still stopping one that has run away.
 * Override with `M3L_EVAL_MAX_BUDGET_USD` when deliberately probing a
 * heavier model or effort.
 */
export const DEFAULT_MAX_BUDGET_USD = 0.5;

/**
 * How much of a failing envelope's own `result` text to quote back in the
 * error string. Enough to identify the cause, short enough not to bury the
 * summary.
 */
export const RESULT_EXCERPT_CHARS = 200;

/**
 * The keys an eval case may carry its checklist under, in precedence order.
 * `expectations` and `assertions` are synonyms — the 13 pre-existing
 * evals.json files were authored before this runner and use both.
 */
export const CHECKLIST_KEYS = ["expectations", "assertions"];

/**
 * The only keys that carry a human-readable criterion. `name`/`id` are
 * identifiers, and `passed`/`evidence` are RESULT fields leaked into a
 * spec; none may reach the graded prompt. See {@link renderChecklistEntry}.
 */
export const CRITERION_KEYS = ["description", "text"];

/**
 * The tools an eval session has PERMISSION to call without a prompt —
 * passed to `--allowedTools`.
 *
 * This flag pre-approves; it does not restrict. A tool absent from this
 * list but present in {@link EVAL_AVAILABLE_TOOLS} still exists and is
 * merely denied at call time by `--permission-mode dontAsk`. The list that
 * decides what exists — and therefore the one carrying the safety and
 * hermeticity invariants — is {@link EVAL_AVAILABLE_TOOLS}.
 *
 * `Skill` is deliberately NOT here: the probe confirmed skill invocation
 * works without a permission grant, so this list stays exactly the read
 * plus confined-write set the graded work needs.
 */
export const EVAL_ALLOWED_TOOLS = ["Read", "Grep", "Glob", "Write", "Edit"];

/**
 * Every tool that EXISTS in an eval session — passed to `--tools`.
 *
 * The safety and hermeticity invariant this constant exists to state: no
 * command-running tool (Bash, PowerShell, REPL), no network tool (WebFetch,
 * WebSearch) and no subagent tool (Agent, Task) is EVER in it. Because
 * `--tools` restricts the built-in set, a case whose skill instructs it to
 * run `git push` finds the tool genuinely absent and grades as an unmet
 * expectation instead of mutating anything — and no case can fan out a
 * subagent that reaches the live network, which is what keeps a verdict a
 * measurement of the SKILL.md rather than of the day's network.
 *
 * `Skill` is required, not optional. Without it, skills are not visible to
 * the session and every verdict silently measures general model competence
 * instead of this repo's skills (the CI-run-33390425486 defect). Removing
 * it as "unused" reintroduces that bug.
 *
 * `bin/tests/run-skill-evals.test.ts` asserts both the exclusions and that
 * `buildClaudeArgs` actually EMITS this list, so adding "Bash" here — or
 * dropping the `--tools` flag entirely — fails the suite.
 */
export const EVAL_AVAILABLE_TOOLS = [...EVAL_ALLOWED_TOOLS, "Skill"];

/**
 * The sandbox contract prepended to every graded prompt, between the case's
 * own prompt and the grading block.
 *
 * It exists because ~30 criteria across the corpus used to assert an
 * EXECUTED mutation ("pushes the branch", "runs `gh pr create`") that a
 * hermetic session — no Bash, no network, no subagent tool, per
 * {@link EVAL_AVAILABLE_TOOLS} — can never demonstrate. Those cases graded
 * the sandbox, not the skill.
 *
 * Stating the convention once here, rather than repeating it in every
 * `prompt` field, keeps the corpus declarative: a case says WHAT the skill
 * should do and the criteria assert on the emitted `WOULD-RUN:` /
 * `WOULD-DISPATCH:` lines, which are ordinary text a grader can check
 * objectively and which mutate nothing.
 *
 * `bin/tests/run-skill-evals.test.ts` asserts {@link buildGradedPrompt}
 * emits this ahead of the grading block; deleting it fails that test.
 */
export const EVAL_SANDBOX_PREAMBLE = [
  "--- EVAL SANDBOX ---",
  "This session has no Bash, no network access and no subagent tool. Do not",
  "claim to have run anything. For each command you would run, emit a line",
  "`WOULD-RUN: <exact command>`. For each subagent you would dispatch, emit",
  "`WOULD-DISPATCH: <agent-type> \u2014 <one-line brief>`. Emit them in the order",
  "you would perform them.",
].join("\n");

export const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    pass: { type: "boolean" },
    unmet_expectations: { type: "array", items: { type: "string" } },
    reasoning: { type: "string" },
  },
  required: ["pass", "unmet_expectations", "reasoning"],
  additionalProperties: false,
};

/**
 * One checklist entry as the corpus actually spells it: a plain criterion
 * string, or an object carrying the criterion under `description`/`text`
 * alongside the identifier (`name`/`id`) and result (`passed`/`evidence`)
 * fields that {@link renderChecklistEntry} deliberately ignores. Typing it
 * narrowly (just `{description?, text?}`) would repeat the original mistake
 * of a JSDoc that contradicts the data.
 *
 * @typedef {string | { description?: string, text?: string, name?: string, id?: string, passed?: boolean, evidence?: string }} ChecklistEntry
 */

/**
 * Normalize one checklist entry to the criterion string that belongs in the
 * graded prompt, or `null` when it carries no readable criterion.
 *
 * Four incompatible shapes exist across the 13 pre-existing evals.json files,
 * all authored before this runner did: `expectations: string[]` (5 skills),
 * `assertions: {name, description}[]` (4), `assertions: {id, description}[]`
 * (2), and `assertions: {text, passed, evidence}[]` (1). Interpolating an
 * object straight into the prompt printed `1. [object Object]` in front of
 * the grader for 123 entries across 24 cases.
 *
 * Precedence is deliberately NARROW — only {@link CRITERION_KEYS}. `name`
 * and `id` are identifiers and must never reach the prompt; a
 * `JSON.stringify` or `Object.values().join()` would inject
 * `"correct-filename"`, `false` and `""` as though they were criteria.
 * `passed`/`evidence` are result fields leaked into a spec, dropped for the
 * same reason.
 *
 * Returns `null` instead of falling back to a stringified object: an entry
 * nobody can read is a corpus defect, and both callers report it rather than
 * grading it — `runCase` refuses to spend money on the case, and
 * `check:skill-evals` fails the push.
 *
 * @param {unknown} entry
 * @returns {string | null} the criterion, or null when unrenderable
 */
export function renderChecklistEntry(entry) {
  if (typeof entry === "string") {
    return entry.trim() === "" ? null : entry;
  }
  if (typeof entry === "object" && entry !== null) {
    for (const key of CRITERION_KEYS) {
      const value = /** @type {Record<string, unknown>} */ (entry)[key];
      if (typeof value === "string" && value.trim() !== "") return value;
    }
  }
  return null;
}

/**
 * Pick a case's checklist array and the key it came from.
 *
 * Exported so `check:skill-evals` selects the checklist exactly the way the
 * runner does — the gate and the runner must never disagree about which key
 * is authoritative. A key present but not an array yields no entries, which
 * the gate reports rather than silently treating as empty.
 *
 * @param {Record<string, unknown>} evalCase
 * @returns {{ key: string | null, entries: unknown[] }}
 */
export function selectChecklist(evalCase) {
  for (const key of CHECKLIST_KEYS) {
    const value = evalCase?.[key];
    if (Array.isArray(value)) return { key, entries: value };
  }
  return { key: null, entries: [] };
}

/**
 * Build the single prompt sent to `claude -p`: the eval case's own prompt,
 * the {@link EVAL_SANDBOX_PREAMBLE} sandbox contract, then grading
 * instructions referencing its `expected_output` and its per-item checklist.
 * One turn does both the task and the self-grade.
 *
 * Entries are rendered through {@link renderChecklistEntry}, so every shape
 * in the corpus produces real criterion text and no identifier leaks in.
 *
 * @param {{ prompt: string, expected_output: string, expectations?: ChecklistEntry[], assertions?: ChecklistEntry[] }} evalCase
 * @returns {string}
 */
export function buildGradedPrompt(evalCase) {
  const { entries } = selectChecklist(evalCase);
  const rendered = entries
    .map((entry) => renderChecklistEntry(entry))
    .filter((criterion) => criterion !== null);

  const lines = [
    evalCase.prompt,
    "",
    EVAL_SANDBOX_PREAMBLE,
    "",
    "--- EVAL GRADING (not part of the request above) ---",
    "After responding to the request above, grade your OWN response against",
    "every expectation below rather than producing anything further.",
    "",
    "Expected shape of a correct response:",
    evalCase.expected_output,
  ];

  // Emit the section only when it has content. A bare "Expectations:" header
  // with nothing under it invites the grader to invent its own criteria, and
  // syncing-docs (no checklist key at all) got precisely that.
  if (rendered.length > 0) {
    lines.push(
      "",
      "Expectations (all must hold for pass=true):",
      ...rendered.map((criterion, i) => `${i + 1}. ${criterion}`),
    );
  }

  lines.push(
    "",
    "Return ONLY the grading verdict as structured JSON — not the response",
    "to the original request.",
  );

  return lines.join("\n");
}

/**
 * Pure parse of a single result envelope's JSON text into a verdict or an
 * error — no process spawning, so this is the part unit tests exercise
 * directly against captured/synthetic envelopes. Takes one envelope object's
 * JSON text: either the sole line `--output-format json` used to print, or
 * — since {@link buildClaudeArgs} switched formats — the terminal
 * `type: "result"` line {@link extractResultEnvelope} pulls out of a
 * `stream-json` event sequence. Both carry the identical envelope shape, so
 * this function needed no change when the format did.
 *
 * @param {string} stdout
 * @returns {{ pass: boolean, unmet_expectations: string[], reasoning: string, costUsd: number } | { error: string }}
 */
export function parseVerdictEnvelope(stdout) {
  let envelope;
  try {
    envelope = JSON.parse(stdout);
  } catch (err) {
    return { error: `claude -p did not return valid JSON: ${err.message}` };
  }

  if (envelope.is_error || envelope.structured_output === undefined) {
    // Anthropic's docs do not enumerate why an envelope can report
    // `subtype: success` and still carry no `structured_output`, and 4 cases
    // failed exactly that way in CI run 33390425486 (promoting-work-log-
    // lessons#2, refreshing-anthropic-guidance#0, researching-anthropic-
    // guidance#1 and #3). Carry the envelope's OWN diagnostic fields instead
    // of collapsing every cause into one opaque sentence: a diagnostic that
    // cannot name its cause is a silent failure.
    const excerpt =
      typeof envelope.result === "string"
        ? envelope.result.slice(0, RESULT_EXCERPT_CHARS)
        : "";
    const details = [
      `subtype: ${envelope.subtype ?? "unknown"}`,
      `is_error: ${envelope.is_error ?? "unset"}`,
      `num_turns: ${envelope.num_turns ?? "unset"}`,
      `stop_reason: ${envelope.stop_reason ?? "unset"}`,
      `result: ${excerpt === "" ? "<empty>" : JSON.stringify(excerpt)}`,
    ].join(", ");
    return {
      error:
        `claude -p reported an error or produced no structured_output ` +
        `(${details}).`,
    };
  }

  return {
    pass: envelope.structured_output.pass,
    unmet_expectations: envelope.structured_output.unmet_expectations ?? [],
    reasoning: envelope.structured_output.reasoning ?? "",
    costUsd: envelope.total_cost_usd ?? 0,
  };
}

/**
 * Parse `claude -p --output-format stream-json --verbose` stdout — one JSON
 * event object per line (NDJSON) — into an array of event objects. Blank
 * lines (the trailing newline) are skipped; any other non-JSON line throws,
 * matching {@link parseVerdictEnvelope}'s "don't swallow a malformed
 * envelope" stance rather than silently dropping a corrupt line.
 *
 * @param {string} stdout
 * @returns {Record<string, unknown>[]}
 */
export function parseStreamEvents(stdout) {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
}

/**
 * Skill names invoked via the `Skill` tool anywhere in a stream-json event
 * sequence, in call order (repeats if a case invokes the same skill more
 * than once). This is what makes the fired-skill assertion below OBSERVED
 * rather than self-reported: a spike confirmed a `Skill` call surfaces as an
 * `assistant` event carrying a `tool_use` content block shaped
 * `{ name: "Skill", input: { skill: "<name>" } }`. Reading `structured_output`
 * alone — the pre-existing verdict path — cannot see this; it is exactly the
 * gap CI run 33390425486 exposed at the loading level and this closes at the
 * selection level (a skill that loads but is never chosen still passed).
 *
 * @param {Record<string, unknown>[]} events
 * @returns {string[]}
 */
export function extractInvokedSkills(events) {
  const invoked = [];
  for (const event of events) {
    if (event.type !== "assistant") continue;
    const content = /** @type {{ content?: unknown }} */ (event.message)
      ?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const skill = /** @type {Record<string, unknown>} */ (block?.input)
        ?.skill;
      if (
        block?.type === "tool_use" &&
        block?.name === "Skill" &&
        typeof skill === "string"
      ) {
        invoked.push(skill);
      }
    }
  }
  return invoked;
}

/**
 * The final `type: "result"` event's JSON text from a stream-json event
 * sequence, in the last-wins order the CLI emits it — the same shape
 * `--output-format json` used to return as its single object, so it feeds
 * {@link parseVerdictEnvelope} unchanged. `null` when no result event is
 * present, e.g. the process was killed mid-stream before completing.
 *
 * @param {Record<string, unknown>[]} events
 * @returns {string | null}
 */
export function extractResultEnvelope(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === "result") return JSON.stringify(events[i]);
  }
  return null;
}

/**
 * Whether a case's fired-skill requirement was met.
 *
 * Every case defaults to requiring the skill under test to actually fire —
 * `expect_skill_fired: false` opts a case OUT for two distinct reasons:
 *
 * 1. The case tests the skill's own contract to skip itself
 *    (`.claude/skills/starting-work/evals/evals.json`#4: a read-only
 *    research prompt, where the SKILL.md's own description says "Skip for
 *    research/questions"). That case grades whether the model correctly
 *    does NOT gate a read-only question — asserting `starting-work` must
 *    fire there would penalize the exact behavior it's testing for.
 * 2. The case's prompt invokes the skill via a literal leading `/slug`
 *    rather than prose (needed for any `disable-model-invocation: true`
 *    skill, e.g. `harness-guide`, which is never prose-reachable at all). A
 *    probe confirmed a `/slug`-prefixed prompt is resolved by the CLI
 *    BEFORE the model's turn — the skill's instructions are genuinely
 *    followed, verified by the model's response correctly using seeded file
 *    content, but no `Skill` tool_use block ever appears in the stream to
 *    observe, because the model never autonomously chose to call the tool;
 *    the choice was already made for it. {@link extractInvokedSkills} can
 *    only see the PROSE-triggered path, where the model itself decides to
 *    call `Skill` as an explicit tool use.
 *
 * @param {string} skillName the skill under test (the evals.json directory)
 * @param {string[]} invokedSkills from {@link extractInvokedSkills}
 * @param {{ expect_skill_fired?: boolean }} evalCase
 * @returns {{ required: boolean, fired: boolean, met: boolean }}
 */
export function evaluateSkillFired(skillName, invokedSkills, evalCase) {
  const required = evalCase.expect_skill_fired !== false;
  const fired = invokedSkills.includes(skillName);
  return { required, fired, met: !required || fired };
}

/**
 * The exact argv handed to `claude -p` for one eval case.
 *
 * Extracted and exported deliberately: the previous argv carried
 * `--restricted` for its entire life with no test able to observe it, which
 * is how a flag that silently disabled skill discovery survived a full 46-case
 * CI run. Flags that decide what the harness measures must be assertable.
 *
 * The same lesson applies to what is ABSENT. A test asserting only
 * {@link EVAL_ALLOWED_TOOLS}' contents is literally true and guards nothing,
 * because that flag never restricted anything; the argv shipped for a full
 * CI run believing it did. The assertions that matter are the ones checking
 * this function EMITS `--tools` with {@link EVAL_AVAILABLE_TOOLS}.
 *
 * `--output-format stream-json` (plus the `--verbose` the CLI requires
 * alongside it) replaces the earlier `json` format: a probe (spiked while
 * building the skill-fired assertion below) confirmed a `Skill` tool
 * invocation surfaces as an `assistant` event's `tool_use` block —
 * `{ name: "Skill", input: { skill: "<name>" } }` — nowhere in the
 * single-envelope `json` format, which reports only the final result. The
 * terminal `type: "result"` event carries the exact same envelope shape
 * `json` used to return as its one object, so {@link parseVerdictEnvelope}
 * needed no change — only {@link extractResultEnvelope} to find that line.
 *
 * @param {string} prompt the graded prompt from {@link buildGradedPrompt}
 * @param {{ model: string, effort: string, maxBudgetUsd?: number }} options
 *   `maxBudgetUsd` defaults to {@link DEFAULT_MAX_BUDGET_USD}
 * @returns {string[]}
 */
export function buildClaudeArgs(
  prompt,
  { model, effort, maxBudgetUsd = DEFAULT_MAX_BUDGET_USD },
) {
  return [
    "-p",
    prompt,
    // Pin the session to the synthetic root so a local run matches CI
    // instead of inheriting the developer's ~/.claude (see file header).
    "--setting-sources",
    "project",
    "--permission-mode",
    "dontAsk",
    // Layer 1 of the three described in the file header: `--tools` decides
    // what EXISTS, and is the only one of the three that removes Bash /
    // WebFetch / Agent from the session. `--allowedTools` below only
    // pre-approves permission for what survives, so both flags are wanted
    // and neither substitutes for the other.
    "--tools",
    EVAL_AVAILABLE_TOOLS.join(","),
    "--allowedTools",
    EVAL_ALLOWED_TOOLS.join(","),
    "--strict-mcp-config",
    "--output-format",
    "stream-json",
    // Required alongside stream-json: `claude -p --output-format
    // stream-json` without it fails fast with "requires --verbose" rather
    // than streaming anything.
    "--verbose",
    "--json-schema",
    JSON.stringify(VERDICT_SCHEMA),
    "--model",
    model,
    "--effort",
    effort,
    "--max-budget-usd",
    String(maxBudgetUsd),
  ];
}

/**
 * Render an `execFileSync` failure into a diagnosable one-line error.
 *
 * Node puts the child's captured output on `err.stderr`/`err.stdout` and
 * leaves `err.message` as the bare "Command failed" line, so a runner that
 * reports only `err.message` throws away the only text that says WHY —
 * an expired token, a missing binary, an exceeded budget all collapse to
 * the same opaque string.
 *
 * @param {unknown} err the value thrown by `execFileSync`
 * @returns {string}
 */
export function describeSpawnFailure(err) {
  const parts = [
    `claude -p invocation failed: ${excerptStream(err, "message")}`,
  ];
  for (const stream of ["stderr", "stdout"]) {
    const text = excerptStream(err, stream);
    if (text !== "") parts.push(`${stream}: ${text}`);
  }
  return parts.join(" | ");
}

/**
 * Read one field off a thrown value as a trimmed, length-capped string.
 * `stderr`/`stdout` arrive as `Buffer` when no encoding was set and as
 * `string` when one was, and either may be `null`.
 *
 * @param {unknown} err
 * @param {string} field
 * @returns {string} the excerpt, or "" when the field carries no text
 */
function excerptStream(err, field) {
  const value = /** @type {Record<string, unknown> | null} */ (err)?.[field];
  const text = typeof value === "string" ? value : String(value ?? "");
  const trimmed = text.trim();
  return trimmed.length > RESULT_EXCERPT_CHARS
    ? `${trimmed.slice(0, RESULT_EXCERPT_CHARS)}…`
    : trimmed;
}

/**
 * Build a disposable synthetic project root for one case, seed it with the
 * case's `files` ({ path, content } entries), run the graded prompt through
 * `claude -p`, and return the parsed verdict — augmented with the fired-skill
 * assertion from {@link evaluateSkillFired}. The one impure step
 * (`execFileSync`) is kept to this function alone so
 * {@link buildGradedPrompt}/{@link buildClaudeArgs}/{@link parseStreamEvents}/
 * {@link extractInvokedSkills}/{@link extractResultEnvelope}/
 * {@link parseVerdictEnvelope}/{@link evaluateSkillFired} stay independently
 * testable.
 *
 * @param {string} skillsDir
 * @param {string} skillName the skill under test — the evals.json directory name
 * @param {{ prompt: string, expected_output: string, expectations?: unknown[], assertions?: unknown[], files?: { path: string, content: string }[], expect_skill_fired?: boolean }} evalCase
 * @param {{ model: string, effort: string, maxBudgetUsd?: number }} options
 * @returns {{ pass: boolean, unmet_expectations: string[], reasoning: string, costUsd: number } | { error: string }}
 */
function runCase(
  skillsDir,
  skillName,
  evalCase,
  { model, effort, maxBudgetUsd },
) {
  const { entries } = selectChecklist(evalCase);
  const unrenderable = entries
    .map((entry, index) => ({ index, criterion: renderChecklistEntry(entry) }))
    .filter(({ criterion }) => criterion === null)
    .map(({ index }) => index + 1);

  // Refuse BEFORE spawning: a malformed spec cannot yield a meaningful
  // verdict, so grading it would spend tokens to learn nothing.
  // `check:skill-evals` fails the push on the same condition — this is the
  // runtime half of the same rule, not a duplicate of it.
  if (unrenderable.length > 0) {
    return {
      error:
        `checklist entr${unrenderable.length === 1 ? "y" : "ies"} ` +
        `${unrenderable.join(", ")} cannot be rendered — each entry must be ` +
        `a non-empty string or carry a non-empty ${CRITERION_KEYS.map((k) => `"${k}"`).join(" or ")} ` +
        `string. Fix the case rather than grading it.`,
    };
  }

  const workspaceDir = mkdtempSync(join(tmpdir(), "m3l-eval-"));

  try {
    // A synthetic project root, not a bare temp dir: skill discovery is
    // rooted at cwd's nearest `.claude/` ancestor, so a temp dir without one
    // would load no skills either. Copying only `skills/` — never
    // `settings.json` — is what keeps this repo's hooks from firing.
    cpSync(skillsDir, join(workspaceDir, ".claude", "skills"), {
      recursive: true,
    });

    for (const file of evalCase.files ?? []) {
      const dest = join(workspaceDir, file.path);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, file.content, "utf8");
    }

    let stdout;
    try {
      stdout = execFileSync(
        "claude",
        buildClaudeArgs(buildGradedPrompt(evalCase), {
          model,
          effort,
          maxBudgetUsd,
        }),
        { cwd: workspaceDir, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
      );
    } catch (err) {
      // `execFileSync` puts the ACTUAL reason on the error's captured
      // `stderr`/`stdout`, not in `err.message` (which is only "Command
      // failed: claude -p ..."). Discarding them turned a one-line auth
      // failure into hours of misdirected diagnosis, so both are surfaced,
      // truncated to RESULT_EXCERPT_CHARS so a 16 MB buffer cannot flood
      // the summary.
      return { error: describeSpawnFailure(err) };
    }

    let events;
    try {
      events = parseStreamEvents(stdout);
    } catch (err) {
      return {
        error: `claude -p did not return valid stream-json: ${err.message}`,
      };
    }

    const resultEnvelope = extractResultEnvelope(events);
    if (resultEnvelope === null) {
      return {
        error:
          "claude -p stream-json output contained no terminal result event.",
      };
    }

    const verdict = parseVerdictEnvelope(resultEnvelope);
    if ("error" in verdict) return verdict;

    const invokedSkills = extractInvokedSkills(events);
    const { met } = evaluateSkillFired(skillName, invokedSkills, evalCase);
    if (!met) {
      return {
        pass: false,
        unmet_expectations: [
          ...verdict.unmet_expectations,
          `Skill "${skillName}" was never invoked via the Skill tool during ` +
            `this case (skills invoked: ${invokedSkills.length > 0 ? invokedSkills.join(", ") : "none"}).`,
        ],
        reasoning: verdict.reasoning,
        costUsd: verdict.costUsd,
      };
    }

    return verdict;
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { json, argv } = parseJsonFlag();
  const filterSkill = argv[0];
  const reporter = createReporter(json);
  const model = process.env.M3L_EVAL_MODEL ?? DEFAULT_MODEL;
  const effort = process.env.M3L_EVAL_EFFORT ?? DEFAULT_EFFORT;
  const maxBudgetUsd = process.env.M3L_EVAL_MAX_BUDGET_USD
    ? Number(process.env.M3L_EVAL_MAX_BUDGET_USD)
    : DEFAULT_MAX_BUDGET_USD;

  const root = repoRoot(import.meta.url);
  const skillsDir = join(root, ".claude/skills");

  const skillNames = existsSync(skillsDir)
    ? readdirSync(skillsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .filter((name) => existsSync(join(skillsDir, name, "evals/evals.json")))
        .filter((name) => filterSkill === undefined || name === filterSkill)
        .sort()
    : [];

  if (filterSkill !== undefined && skillNames.length === 0) {
    reporter.error(
      `no skill named "${filterSkill}" with a .claude/skills/${filterSkill}/evals/evals.json file.`,
    );
    reporter.finish({ totalCases: 0, passed: 0, failed: 0, costUsd: 0 });
    process.exit(1);
  }

  let totalCases = 0;
  let passed = 0;
  let failed = 0;
  let costUsd = 0;
  /** @type {{ skill: string, id: number, unmet?: string[], reasoning?: string, error?: string }[]} */
  const failures = [];

  for (const skillName of skillNames) {
    const evalsPath = join(skillsDir, skillName, "evals/evals.json");
    const suite = JSON.parse(readFileSync(evalsPath, "utf8"));
    reporter.info(`── ${skillName} (${suite.evals.length} case(s)) ──`);

    for (const evalCase of suite.evals) {
      totalCases++;
      const result = runCase(skillsDir, skillName, evalCase, {
        model,
        effort,
        maxBudgetUsd,
      });

      if ("error" in result) {
        failed++;
        failures.push({
          skill: skillName,
          id: evalCase.id,
          error: result.error,
        });
        reporter.error(`${skillName}#${evalCase.id}: ${result.error}`);
        continue;
      }

      costUsd += result.costUsd;
      if (result.pass) {
        passed++;
        reporter.info(`  ✓ #${evalCase.id}`);
      } else {
        failed++;
        failures.push({
          skill: skillName,
          id: evalCase.id,
          unmet: result.unmet_expectations,
          reasoning: result.reasoning,
        });
        reporter.error(
          `${skillName}#${evalCase.id}: FAIL — ${result.unmet_expectations.join("; ") || result.reasoning}`,
        );
      }
    }
  }

  console.log("\n── pnpm eval:skills summary ──");
  console.log(`Skills run:   ${skillNames.length}`);
  console.log(`Cases run:    ${totalCases}`);
  console.log(`Passed:       ${passed}`);
  console.log(`Failed:       ${failed}`);
  console.log(`Cost (USD):   ~$${costUsd.toFixed(4)}`);

  if (failed > 0) {
    reporter.finish({ totalCases, passed, failed, costUsd, failures });
    process.exit(1);
  }

  reporter.succeed(
    `${passed}/${totalCases} eval case(s) passed across ${skillNames.length} skill(s) (~$${costUsd.toFixed(4)}).`,
  );
  reporter.finish({ totalCases, passed, failed, costUsd });
}
