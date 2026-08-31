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
// 21 repo skills (only built-ins), while the same session without the flag
// listed all 21. The graded transcripts had been saying so verbatim —
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
//
// A BARE temp dir would not do: skill discovery is rooted at cwd's nearest
// `.claude/` ancestor, so a temp dir without one loads no skills either —
// the very bug being fixed. Nor could the workspace live inside the repo,
// where our own guards would deny `scaffolding-submodules`/test-author cases
// and a stray write could pollute the tree.
//
// Mutating and network capability is denied by OMISSION from
// EVAL_ALLOWED_TOOLS rather than by a blunt mode, so a case that attempts
// `git push` is denied and surfaces as an unmet expectation instead of
// executing. Treat a failure as "the skill's own instructions didn't produce
// a plan meeting the bar", not as "a live command failed".
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
 * Every tool an eval session may use.
 *
 * The safety invariant this constant exists to state: no command-running
 * tool (Bash, PowerShell, REPL) and no network tool (WebFetch, WebSearch)
 * is EVER in it. Capability is granted by enumeration rather than removed
 * by a blunt mode, so a case whose skill instructs it to run `git push`
 * finds the tool absent, is denied, and grades as an unmet expectation
 * instead of mutating anything. `bin/tests/run-skill-evals.test.ts`
 * asserts the invariant directly, so adding "Bash" here fails the suite.
 */
export const EVAL_ALLOWED_TOOLS = ["Read", "Grep", "Glob", "Write", "Edit"];

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
 * followed by grading instructions referencing its `expected_output` and its
 * per-item checklist. One turn does both the task and the self-grade.
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
 * Pure parse of a `claude -p --output-format json --json-schema ...` stdout
 * envelope into a verdict or an error — no process spawning, so this is the
 * part unit tests exercise directly against captured/synthetic envelopes.
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
 * The exact argv handed to `claude -p` for one eval case.
 *
 * Extracted and exported deliberately: the previous argv carried
 * `--restricted` for its entire life with no test able to observe it, which
 * is how a flag that silently disabled skill discovery survived a full 46-case
 * CI run. Flags that decide what the harness measures must be assertable.
 *
 * @param {string} prompt the graded prompt from {@link buildGradedPrompt}
 * @param {{ model: string, effort: string }} options
 * @returns {string[]}
 */
export function buildClaudeArgs(prompt, { model, effort }) {
  return [
    "-p",
    prompt,
    // Pin the session to the synthetic root so a local run matches CI
    // instead of inheriting the developer's ~/.claude (see file header).
    "--setting-sources",
    "project",
    "--permission-mode",
    "dontAsk",
    "--allowedTools",
    EVAL_ALLOWED_TOOLS.join(","),
    "--strict-mcp-config",
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(VERDICT_SCHEMA),
    "--model",
    model,
    "--effort",
    effort,
  ];
}

/**
 * Build a disposable synthetic project root for one case, seed it with the
 * case's `files` ({ path, content } entries), run the graded prompt through
 * `claude -p`, and return the parsed verdict. The one impure step
 * (`execFileSync`) is kept to this function alone so
 * {@link buildGradedPrompt}/{@link buildClaudeArgs}/
 * {@link parseVerdictEnvelope} stay independently testable.
 *
 * @param {string} skillsDir
 * @param {{ prompt: string, expected_output: string, expectations?: unknown[], assertions?: unknown[], files?: { path: string, content: string }[] }} evalCase
 * @param {{ model: string, effort: string }} options
 * @returns {{ pass: boolean, unmet_expectations: string[], reasoning: string, costUsd: number } | { error: string }}
 */
function runCase(skillsDir, evalCase, { model, effort }) {
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
        buildClaudeArgs(buildGradedPrompt(evalCase), { model, effort }),
        { cwd: workspaceDir, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
      );
    } catch (err) {
      return { error: `claude -p invocation failed: ${err.message}` };
    }

    return parseVerdictEnvelope(stdout);
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
      const result = runCase(skillsDir, evalCase, {
        model,
        effort,
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
