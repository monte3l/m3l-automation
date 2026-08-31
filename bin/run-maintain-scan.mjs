#!/usr/bin/env node
// Weekly automated maintain-scan (Anthropic AI-native SDLC harness-alignment
// plan, Section 5 — the Deploy/Maintain loop's missing autonomous-scan
// half). Runs a bounded, read-only `claude -p --restricted` triage pass
// against the current `main` tree, and — only when it reports concrete
// findings — opens a PR proposing a dated entry under docs/plans/
// IMPLEMENTATION.md's "Automated maintain-scan findings" section for a
// maintainer to triage.
//
// Never runs `git commit`/`git push` directly: this repo has no precedent
// for a CI job authoring commits, and doing so would trip the local
// lefthook `pre-push` battery (installed via `prepare` on `pnpm install`,
// including `verify-signed-range.mjs`) that a bot-authored commit cannot
// satisfy. Every mutation here goes through the GitHub Content API via `gh
// api`, which produces a GitHub-authored, always-valid commit and never
// invokes a local git hook.
//
// The appended section is deliberately NOT a Status-columned table row —
// per docs/contributing/filing-work.md: "a tracker row is filed, approved
// work, not a place to jot something down." This is an unreviewed candidate
// list; a maintainer decides whether any item is worth filing as a real row
// (which then goes through the normal `pnpm sync:hub -- --apply` path).
//
// Usage: node bin/run-maintain-scan.mjs
//   Requires GH_TOKEN (contents:write, pull-requests:write) and
//   CLAUDE_CODE_OAUTH_TOKEN in the environment; run inside a checkout of the
//   repo on `main`. Invoked by .github/workflows/maintain-scan.yml.
import process from "node:process";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { repoRoot } from "./lib/report.mjs";

export const DEFAULT_MODEL = "claude-sonnet-5";
export const DEFAULT_EFFORT = "medium";
export const MAX_FINDINGS = 5;
export const MAX_FIELD_LENGTH = 300;
export const MAX_CITATION_LENGTH = 120;
export const SECTION_HEADING = "## Automated maintain-scan findings";

export const FINDINGS_SCHEMA = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      maxItems: MAX_FINDINGS,
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          citation: { type: "string" },
        },
        required: ["title", "description", "citation"],
        additionalProperties: false,
      },
    },
  },
  required: ["findings"],
  additionalProperties: false,
};

/** @returns {string} the bounded, read-only triage prompt. */
export function buildTriagePrompt() {
  return [
    "You are running a scheduled, read-only maintenance scan of this",
    "repository's current state on `main`. Identify up to " +
      MAX_FINDINGS +
      " concrete, actionable follow-up items a maintainer should consider",
    "filing as tracked work — for example: a recurring TODO/FIXME comment,",
    "an ADR's stated revisit trigger that now appears to have fired, a",
    "docs/plans/IMPLEMENTATION.md row marked Blocked whose blocker looks",
    "resolved, a real drift between two docs, or a gap similar in shape to",
    "one already fixed elsewhere in this repo's history.",
    "",
    "Every finding needs a `file:line` citation you actually read — do not",
    "report anything inferred from a name alone or something you could not",
    "confirm by reading the cited file. An empty findings array is a valid,",
    "expected result for a healthy week — do not invent speculative",
    "concerns to avoid returning one.",
    "",
    "Return ONLY the findings as structured JSON.",
  ].join("\n");
}

/**
 * Pure parse of a `claude -p --output-format json --json-schema ...` stdout
 * envelope into a findings array or an error.
 *
 * @param {string} stdout
 * @returns {{ findings: { title: string, description: string, citation: string }[] } | { error: string }}
 */
export function parseFindingsEnvelope(stdout) {
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

  if (
    envelope.structured_output === null ||
    typeof envelope.structured_output !== "object"
  ) {
    return { findings: [] };
  }

  const raw = Array.isArray(envelope.structured_output.findings)
    ? envelope.structured_output.findings
    : [];
  const findings = raw
    .filter(
      (f) =>
        f !== null &&
        typeof f === "object" &&
        typeof f.title === "string" &&
        typeof f.description === "string" &&
        typeof f.citation === "string",
    )
    .map((f) => ({
      title: sanitizeField(f.title, MAX_FIELD_LENGTH),
      description: sanitizeField(f.description, MAX_FIELD_LENGTH),
      citation: sanitizeField(f.citation, MAX_CITATION_LENGTH),
    }));
  return { findings: findings.slice(0, MAX_FINDINGS) };
}

/**
 * Strip newlines/pipes (which would break a Markdown bullet or PR-body
 * table) and truncate a model-supplied field — untrusted external input by
 * the time it reaches a file write / PR body, per this repo's "validate all
 * external input at the boundary" rule.
 *
 * @param {string} value
 * @param {number} maxLength
 * @returns {string}
 */
function sanitizeField(value, maxLength) {
  const flat = value.replace(/[\n\r|]+/g, " ").trim();
  return flat.length > maxLength ? `${flat.slice(0, maxLength - 1)}…` : flat;
}

/**
 * Build the dated Markdown subsection appended for this run's findings.
 *
 * @param {string} date ISO date, e.g. "2026-08-31"
 * @param {{ title: string, description: string, citation: string }[]} findings
 * @returns {string}
 */
export function formatFindingsSection(date, findings) {
  const lines = [`### Automated scan — ${date}`, ""];
  for (const finding of findings) {
    lines.push(
      `- **${finding.title}** — ${finding.description} (\`${finding.citation}\`)`,
    );
  }
  return lines.join("\n");
}

/**
 * Insert a dated findings subsection into IMPLEMENTATION.md's content,
 * creating the top-level heading (with its intro sentence) on first use.
 *
 * @param {string} implementationMd current file content
 * @param {string} subsection output of {@link formatFindingsSection}
 * @returns {string} updated file content
 */
export function insertFindingsSection(implementationMd, subsection) {
  if (implementationMd.includes(SECTION_HEADING)) {
    return `${implementationMd.trimEnd()}\n\n${subsection}\n`;
  }
  const heading = [
    SECTION_HEADING,
    "",
    "Unreviewed candidates from the weekly automated scan " +
      "(`.github/workflows/maintain-scan.yml`, `bin/run-maintain-scan.mjs`).",
    "Not filed work — no Status column, no `sync:hub` row — a maintainer",
    "decides whether an item is worth promoting into a real tracker row",
    "per `docs/contributing/filing-work.md`.",
    "",
    subsection,
  ].join("\n");
  return `${implementationMd.trimEnd()}\n\n${heading}\n`;
}

/**
 * Run `gh api ...` — always as an argv array (never a shell string, so
 * nothing a model or `gh` could return gets shell-interpreted). `gh api`
 * has no `--repo` flag; every endpoint path here already fully qualifies
 * `owner`/`repo` itself.
 *
 * @param {string} root cwd for the subprocess
 * @param {string[]} args
 * @returns {string} trimmed stdout
 */
function ghApi(root, args) {
  return execFileSync("gh", args, { cwd: root, encoding: "utf8" }).trim();
}

/**
 * Run a `gh pr ...` subcommand pinned to this repo via `--repo` (rather
 * than relying on the local git remote's ambiguous resolution), always as
 * an argv array.
 *
 * @param {string} repoSlug `owner/repo`
 * @param {string} root cwd for the subprocess
 * @param {string[]} args
 * @returns {string} trimmed stdout
 */
function ghPr(repoSlug, root, args) {
  return execFileSync("gh", [...args, "--repo", repoSlug], {
    cwd: root,
    encoding: "utf8",
  }).trim();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = repoRoot(import.meta.url);
  const model = process.env.M3L_MAINTAIN_SCAN_MODEL ?? DEFAULT_MODEL;
  const effort = process.env.M3L_MAINTAIN_SCAN_EFFORT ?? DEFAULT_EFFORT;
  const repository = process.env.GITHUB_REPOSITORY;
  if (repository === undefined) {
    console.error("GITHUB_REPOSITORY is not set — this script is CI-only.");
    process.exit(1);
  }
  const [owner, repo] = repository.split("/");

  let stdout;
  try {
    stdout = execFileSync(
      "claude",
      [
        "-p",
        buildTriagePrompt(),
        "--restricted",
        "--strict-mcp-config",
        "--tools",
        "Read,Glob,Grep",
        "--output-format",
        "json",
        "--json-schema",
        JSON.stringify(FINDINGS_SCHEMA),
        "--model",
        model,
        "--effort",
        effort,
      ],
      {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        // Genuinely read-only: this call needs no repo-write credential.
        // Passing an explicit env (rather than inheriting GH_TOKEN/
        // CLAUDE_CODE_OAUTH_TOKEN implicitly) means a future Claude Code
        // CLI upgrade can't silently widen what this read-only pass can
        // reach, even though --restricted already removes every tool that
        // could use a credential today.
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
        },
      },
    );
  } catch (err) {
    console.error(`claude -p invocation failed: ${err.message}`);
    process.exit(1);
  }

  const result = parseFindingsEnvelope(stdout);
  if ("error" in result) {
    console.error(result.error);
    process.exit(1);
  }

  if (result.findings.length === 0) {
    console.log("Maintain-scan: no findings this cycle — nothing to propose.");
    process.exit(0);
  }

  const date = new Date().toISOString().slice(0, 10);
  const branch = `maintain-scan/${date}`;
  const repoSlug = `${owner}/${repo}`;

  // --state all: a same-day re-dispatch after the first PR was already
  // merged/closed must not re-create a duplicate — only "still exists,
  // still needs attention" should short-circuit here.
  const existingPrCount = ghPr(repoSlug, root, [
    "pr",
    "list",
    "--head",
    branch,
    "--state",
    "all",
    "--json",
    "number",
    "--jq",
    "length",
  ]);
  if (existingPrCount !== "0") {
    console.log(
      `Maintain-scan: a PR from ${branch} already exists — skipping.`,
    );
    process.exit(0);
  }

  let currentFile;
  try {
    currentFile = JSON.parse(
      ghApi(root, [
        "api",
        `repos/${owner}/${repo}/contents/docs/plans/IMPLEMENTATION.md`,
        "-f",
        "ref=main",
      ]),
    );
  } catch (err) {
    console.error(`Failed to read IMPLEMENTATION.md from main: ${err.message}`);
    process.exit(1);
  }
  const currentContent = Buffer.from(currentFile.content, "base64").toString(
    "utf8",
  );
  const subsection = formatFindingsSection(date, result.findings);
  const updatedContent = insertFindingsSection(currentContent, subsection);

  let mainSha;
  try {
    mainSha = ghApi(root, [
      "api",
      `repos/${owner}/${repo}/git/ref/heads/main`,
      "--jq",
      ".object.sha",
    ]);
  } catch (err) {
    console.error(`Failed to resolve main's HEAD sha: ${err.message}`);
    process.exit(1);
  }

  try {
    ghApi(root, [
      "api",
      `repos/${owner}/${repo}/git/refs`,
      "--method",
      "POST",
      "-f",
      `ref=refs/heads/${branch}`,
      "-f",
      `sha=${mainSha}`,
    ]);
  } catch (err) {
    // 422 "Reference already exists" is a benign race (e.g. a prior run
    // created the branch but failed before opening a PR) — everything
    // after this point is safe to retry against the existing branch. Any
    // other failure is a real error worth stopping on.
    if (!/Reference already exists/i.test(String(err.stderr ?? err.message))) {
      console.error(`Failed to create branch ${branch}: ${err.message}`);
      process.exit(1);
    }
    console.log(`Maintain-scan: branch ${branch} already exists — reusing it.`);
  }

  try {
    ghApi(root, [
      "api",
      `repos/${owner}/${repo}/contents/docs/plans/IMPLEMENTATION.md`,
      "--method",
      "PUT",
      "-f",
      `message=docs: automated maintain-scan findings for ${date}`,
      "-f",
      `content=${Buffer.from(updatedContent, "utf8").toString("base64")}`,
      "-f",
      `sha=${currentFile.sha}`,
      "-f",
      `branch=${branch}`,
    ]);
  } catch (err) {
    console.error(
      `Failed to commit the findings entry to ${branch} (leaving the ` +
        `branch in place for the next run to retry): ${err.message}`,
    );
    process.exit(1);
  }

  const prBody = [
    `Automated weekly maintain-scan (\`.github/workflows/maintain-scan.yml\`).`,
    "",
    "**Unreviewed candidates** — not filed work; triage each item and either",
    "file it as a real `docs/plans/IMPLEMENTATION.md` row (per",
    "`docs/contributing/filing-work.md`) or close this PR if nothing here is",
    "worth acting on.",
    "",
    subsection,
  ].join("\n");

  try {
    ghPr(repoSlug, root, [
      "pr",
      "create",
      "--head",
      branch,
      "--base",
      "main",
      "--title",
      `docs: automated maintain-scan findings — ${date}`,
      "--body",
      prBody,
    ]);
  } catch (err) {
    console.error(
      `Committed findings to ${branch} but failed to open a PR — open one ` +
        `manually: ${err.message}`,
    );
    process.exit(1);
  }

  console.log(
    `Maintain-scan: opened a PR from ${branch} with ${result.findings.length} finding(s).`,
  );
}
