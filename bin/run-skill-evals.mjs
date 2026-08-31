#!/usr/bin/env node
// `pnpm eval:skills` — repo-owned eval runner (Anthropic AI-native SDLC
// harness-alignment plan, Section 4). For every `.claude/skills/*/evals/
// evals.json` case, drives a real `claude -p` invocation in `--restricted`
// mode (ignores this machine's settings.json, confines file tools to a
// scratch working directory) and asks the SAME turn to both attempt the
// eval's prompt and self-grade its own response against the case's
// `expectations` list, returned as structured JSON via `--json-schema`.
//
// This is a real, but self-graded, signal — not an independent judge call.
// `--restricted` strips the tools a skill would normally use (Bash, git,
// writes outside the working directory), so the model reasons about what it
// WOULD do rather than doing it live. Treat a failure as "the skill's own
// instructions didn't produce a plan meeting the bar", not as "a live
// command failed". Model/effort default to DEFAULT_MODEL/DEFAULT_EFFORT
// below (override via M3L_EVAL_MODEL/M3L_EVAL_EFFORT) — this is a bin/
// script, not a .claude/workflows/*.js Workflow-tool script, so it sits
// outside docs/contributing/model-selection.md's machine-checked MODEL-
// MATRIX (see that doc's note on this script).
//
// The scratch directory is created at `.claude/skills/<name>/eval-workspace/`
// (already covered by the `.claude/skills/*/**-workspace/` .gitignore entry)
// so Claude Code's own CLAUDE.md/skill auto-discovery still walks up to the
// real project root — a working directory outside the repo would run the
// eval with no project context at all, defeating the point.
//
// Usage:
//   node bin/run-skill-evals.mjs                # every skill with evals.json
//   node bin/run-skill-evals.mjs <skill-name>    # one skill only
//   node bin/run-skill-evals.mjs --json          # machine-readable summary
import process from "node:process";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonFlag, createReporter, repoRoot } from "./lib/report.mjs";

export const DEFAULT_MODEL = "claude-sonnet-5";
export const DEFAULT_EFFORT = "medium";

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
 * Build the single prompt sent to `claude -p`: the eval case's own prompt,
 * followed by grading instructions referencing its `expected_output` and its
 * per-item checklist. One turn does both the task and the self-grade.
 *
 * The 13 pre-existing `.claude/skills/<name>/evals/evals.json` files (authored
 * before this runner existed) use three different shapes for that
 * checklist: `expectations` (5 skills), `assertions` (7 skills), or neither
 * — `expected_output` alone (1 skill, `syncing-docs`). `expectations` and
 * `assertions` are treated as synonyms; a case with neither gets an empty
 * checklist (no numbered lines), grading purely against `expected_output`.
 * A real CI run against all 13 skills (PR #785, job 99419101309) crashed 27
 * of 46 cases on `evalCase.expectations.map` being called on `undefined`
 * before this fix — never assume every evals.json shares one shape.
 *
 * @param {{ prompt: string, expected_output: string, expectations?: string[], assertions?: string[] }} evalCase
 * @returns {string}
 */
export function buildGradedPrompt(evalCase) {
  const checklist = evalCase.expectations ?? evalCase.assertions ?? [];
  return [
    evalCase.prompt,
    "",
    "--- EVAL GRADING (not part of the request above) ---",
    "After responding to the request above, grade your OWN response against",
    "every expectation below rather than producing anything further.",
    "",
    "Expected shape of a correct response:",
    evalCase.expected_output,
    "",
    "Expectations (all must hold for pass=true):",
    ...checklist.map((e, i) => `${i + 1}. ${e}`),
    "",
    "Return ONLY the grading verdict as structured JSON — not the response",
    "to the original request.",
  ].join("\n");
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
    return {
      error:
        `claude -p reported an error or produced no structured_output ` +
        `(subtype: ${envelope.subtype ?? "unknown"}).`,
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
 * Seed a per-skill scratch workspace with a case's `files` ({ path, content }
 * entries), run the graded prompt through `claude -p --restricted`, and
 * return the parsed verdict. The one impure step (`execFileSync`) is kept to
 * this function alone so {@link buildGradedPrompt}/{@link parseVerdictEnvelope}
 * stay independently testable.
 *
 * @param {string} skillsDir
 * @param {string} skillName
 * @param {{ prompt: string, expected_output: string, expectations: string[], files?: { path: string, content: string }[] }} evalCase
 * @param {{ model: string, effort: string }} options
 * @returns {{ pass: boolean, unmet_expectations: string[], reasoning: string, costUsd: number } | { error: string }}
 */
function runCase(skillsDir, skillName, evalCase, { model, effort }) {
  const workspaceDir = join(skillsDir, skillName, "eval-workspace");
  rmSync(workspaceDir, { recursive: true, force: true });
  mkdirSync(workspaceDir, { recursive: true });

  try {
    for (const file of evalCase.files ?? []) {
      const dest = join(workspaceDir, file.path);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, file.content, "utf8");
    }

    let stdout;
    try {
      stdout = execFileSync(
        "claude",
        [
          "-p",
          buildGradedPrompt(evalCase),
          "--restricted",
          "--output-format",
          "json",
          "--json-schema",
          JSON.stringify(VERDICT_SCHEMA),
          "--model",
          model,
          "--effort",
          effort,
        ],
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
      const result = runCase(skillsDir, skillName, evalCase, {
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
