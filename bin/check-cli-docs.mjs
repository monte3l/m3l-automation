#!/usr/bin/env node
// Verifies docs/reference/cli.md against the canonical structure recorded in
// docs/contributing/cli-structure.md — the CLI-side sibling of
// check-script-docs.mjs, closing the second of the two governance gaps
// ADR-0053 names. Until this gate existed, the CLI's 200-line contract page
// was referenced by exactly one string in all of bin/ (a command-catalog
// description) and was otherwise entirely ungated.
//
// Checks:
//   - the H1 title, and a non-empty preamble that names `pnpm m3l` and
//     states the page is the CLI's contract
//   - every required H2 is present, and the H2s that ARE present appear in
//     CLI_CANONICAL_SECTIONS order (ordering IS enforced here — a deliberate
//     divergence from check:script-docs, which spans 22 files with sanctioned
//     layout deviations; this is one file with an explicitly ordered list)
//   - conditional sections are validated when present, and near-miss spellings
//     of them are rejected in favour of the canonical name
//   - `## Commands` documents every command main.ts actually dispatches, and
//     documents no command it does not — the truth is regex-extracted from
//     src/main.ts's STATIC_COMMAND_NAMES, so U9/U10/U12 cannot ship a command
//     without documenting it (the technique doctor.test.ts already uses
//     against bin/lib/script-scaffold.mjs)
//   - `## Exit codes` carries a table naming at least 0, 1 and 2
//
// Usage:
//   node bin/check-cli-docs.mjs   # exits 0 on success, 1 on any mismatch
import process from "node:process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { parseJsonFlag, createReporter, repoRoot } from "./lib/report.mjs";

/** The contract page this gate governs. */
export const CLI_DOC_PATH = "docs/reference/cli.md";

/** The CLI composition root the `## Commands` cross-check derives its truth from. */
export const CLI_MAIN_PATH = "packages/m3l-cli/src/main.ts";

/** The page's exact H1. */
export const CLI_DOC_TITLE = "# m3l CLI (`packages/m3l-cli`)";

/**
 * The canonical H2 sections, in the order they must appear. `since` records
 * the phase that lands an optional section: it is documentation for whoever
 * reads this list, and flipping `required` to `true` is that phase's job.
 */
export const CLI_CANONICAL_SECTIONS = Object.freeze([
  { heading: "## Design invariants", required: true, since: null },
  { heading: "## Commands", required: true, since: null },
  { heading: "## Flows", required: false, since: "U10" },
  { heading: "## Completion", required: false, since: "U12" },
  { heading: "## Exit codes", required: true, since: null },
]);

/**
 * Near-miss spellings of the OPTIONAL sections, mapped to the canonical name.
 * The required sections need no entry — misspelling one already fails as a
 * missing section — but a misspelled optional section would otherwise pass
 * silently, never validated and never noticed. Same failure mode
 * check:script-docs's "Command vs Operation" column check guards.
 */
export const CLI_NEAR_MISS_HEADINGS = Object.freeze({
  "## Flow": "## Flows",
  "## Shell completion": "## Completion",
  "## Completions": "## Completion",
});

/** The exit codes `## Exit codes` must name at minimum. */
export const CLI_REQUIRED_EXIT_CODES = Object.freeze(["0", "1", "2"]);

/** The `<script>` placeholder heading — a form, not a command name. */
const SCRIPT_PLACEHOLDER_TOKEN = "<script>";

/** `#### \`m3l <token> …\`` — a per-command heading under `## Commands`. */
const COMMAND_HEADING_RE = /^####\s+`m3l\s+([^`\s]+)[^`]*`/gm;

/** Any `### ` heading — the phase groups inside `## Commands`. */
const H3_RE = /^###\s+\S/m;

/** A markdown table's separator row, e.g. `| --- | --- |`. */
const TABLE_SEPARATOR_RE = /^\|[\s:|-]+\|\s*$/m;

/** Shells `## Completion` must name at least one of. */
const SHELL_RE = /\b(bash|zsh|fish)\b/i;

/** The prose sentence the preamble must carry. */
const CONTRACT_SENTENCE_RE = /This page is the CLI's contract/;

/**
 * Extract the command names `main.ts` statically dispatches, by reading its
 * `STATIC_COMMAND_NAMES` literal. Source-of-truth extraction, not a
 * hand-maintained copy: a command added to `main.ts` immediately becomes a
 * documentation requirement.
 *
 * @param {string} mainTsText full contents of packages/m3l-cli/src/main.ts
 * @returns {string[]} the declared names, in declaration order (empty when
 *   the literal is absent or empty — the caller must treat empty as a
 *   failure, since an empty set would make the cross-check a no-op)
 */
export function shippedCommandNames(mainTsText) {
  const literal =
    /STATIC_COMMAND_NAMES\s*:\s*readonly string\[\]\s*=\s*\[([\s\S]*?)\]/.exec(
      mainTsText,
    );
  if (!literal) return [];
  return [...literal[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

/**
 * Split a markdown document into its H2 sections, ignoring headings inside
 * fenced code blocks.
 *
 * @param {string} text
 * @returns {{ heading: string, body: string }[]}
 */
function h2Sections(text) {
  const sections = [];
  let current = null;
  let fenced = false;
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    const match = fenced ? null : /^##\s+(.+?)\s*$/.exec(line);
    if (match) {
      current = { heading: `## ${match[1]}`, lines: [] };
      sections.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  return sections.map(({ heading, lines }) => ({
    heading,
    body: lines.join("\n"),
  }));
}

/**
 * The text between the H1 and the first H2 — the page's preamble.
 *
 * @param {string} text
 * @returns {string}
 */
function preambleOf(text) {
  const lines = text.split("\n");
  const firstH2 = lines.findIndex((line) => /^##\s+/.test(line));
  const body = firstH2 === -1 ? lines.slice(1) : lines.slice(1, firstH2);
  return body.join("\n").trim();
}

/**
 * Validate docs/reference/cli.md against the canonical structure spec
 * (docs/contributing/cli-structure.md). Pure — operates on the page text plus
 * the command names extracted from `main.ts`. Returns human-readable problem
 * strings (empty array = conformant).
 *
 * @param {string} text full docs/reference/cli.md content
 * @param {readonly string[]} commandNames names from {@link shippedCommandNames}
 * @returns {string[]}
 */
export function cliDocStructureErrors(text, commandNames = []) {
  const problems = [];
  const sections = h2Sections(text);
  const headings = sections.map((section) => section.heading);
  const bodyOf = (heading) =>
    sections.find((section) => section.heading === heading)?.body;

  // --- Title + preamble ------------------------------------------------------
  const firstLine = text.split("\n")[0]?.trim() ?? "";
  if (firstLine !== CLI_DOC_TITLE) {
    problems.push(
      `first line must be exactly ${JSON.stringify(CLI_DOC_TITLE)} (got ${JSON.stringify(firstLine)})`,
    );
  }
  const preamble = preambleOf(text);
  if (preamble.length === 0) {
    problems.push(
      `the preamble between the H1 and the first "##" heading is empty — it must orient a reader who has never run the CLI.`,
    );
  } else {
    if (!preamble.includes("pnpm m3l")) {
      problems.push(
        `the preamble must name the invocation \`pnpm m3l\` — the package's bin is not linked into node_modules/.bin, so the bare \`m3l\` form does not work.`,
      );
    }
    if (!CONTRACT_SENTENCE_RE.test(preamble)) {
      problems.push(
        `the preamble must state that "This page is the CLI's contract" — the sentence that makes an undocumented command a defect rather than an omission.`,
      );
    }
  }

  // --- Required sections -----------------------------------------------------
  for (const section of CLI_CANONICAL_SECTIONS) {
    if (section.required && !headings.includes(section.heading)) {
      problems.push(
        `missing "${section.heading}" section (required by docs/contributing/cli-structure.md §Reference page).`,
      );
    }
  }

  // --- Near-miss spellings of the optional sections --------------------------
  for (const [nearMiss, canonical] of Object.entries(CLI_NEAR_MISS_HEADINGS)) {
    if (headings.includes(nearMiss)) {
      problems.push(
        `"${nearMiss}" is not the canonical heading — rename it to "${canonical}", which is the name this gate validates.`,
      );
    }
  }

  // --- Ordering over the canonical sections that ARE present -----------------
  const canonicalIndex = (heading) =>
    CLI_CANONICAL_SECTIONS.findIndex((section) => section.heading === heading);
  let previousIndex = -1;
  let previousHeading = "";
  for (const heading of headings) {
    const index = canonicalIndex(heading);
    if (index === -1) continue; // non-canonical H2s carry no ordering opinion
    if (index < previousIndex) {
      problems.push(
        `"${heading}" appears after "${previousHeading}" — the canonical order is ${CLI_CANONICAL_SECTIONS.map((section) => section.heading).join(" → ")} (absent optional sections are simply skipped).`,
      );
    }
    previousIndex = index;
    previousHeading = heading;
  }

  // --- Conditional sections: not required, but validated when present --------
  const flowsBody = bodyOf("## Flows");
  if (flowsBody !== undefined && !H3_RE.test(flowsBody)) {
    problems.push(
      `"## Flows" is present but has no "### " subsection — document at least one named flow, or drop the section until U10 ships one.`,
    );
  }
  const completionBody = bodyOf("## Completion");
  if (completionBody !== undefined && !SHELL_RE.test(completionBody)) {
    problems.push(
      `"## Completion" is present but names no shell — it must name at least one of bash/zsh/fish, since the install step differs per shell.`,
    );
  }

  // --- `## Commands` substructure and the docs<->code cross-check ------------
  const commandsBody = bodyOf("## Commands");
  if (commandsBody !== undefined) {
    if (!H3_RE.test(commandsBody)) {
      problems.push(
        `"## Commands" has no "### " subsection — commands are grouped under a "### " phase heading, one "#### " per command.`,
      );
    }

    const documented = new Set(
      [...commandsBody.matchAll(COMMAND_HEADING_RE)].map((match) => match[1]),
    );
    for (const name of commandNames) {
      if (!documented.has(name)) {
        problems.push(
          `"## Commands" does not document \`m3l ${name}\` — main.ts dispatches it, so it needs a "#### \`m3l ${name} …\`" heading (${CLI_MAIN_PATH}'s STATIC_COMMAND_NAMES is the source of truth).`,
        );
      }
    }
    for (const token of documented) {
      if (token === SCRIPT_PLACEHOLDER_TOKEN) continue; // the dynamic-dispatch form
      if (!commandNames.includes(token)) {
        problems.push(
          `"## Commands" documents \`m3l ${token}\` but main.ts does not dispatch it — remove the section or add the command to ${CLI_MAIN_PATH}'s STATIC_COMMAND_NAMES.`,
        );
      }
    }
  }

  // --- `## Exit codes` substance --------------------------------------------
  const exitCodesBody = bodyOf("## Exit codes");
  if (exitCodesBody !== undefined) {
    if (!TABLE_SEPARATOR_RE.test(exitCodesBody)) {
      problems.push(
        `"## Exit codes" has no markdown table — the codes are a lookup, and prose alone is not one.`,
      );
    }
    for (const code of CLI_REQUIRED_EXIT_CODES) {
      if (!new RegExp(`\\|\\s*\`${code}\`\\s*\\|`).test(exitCodesBody)) {
        problems.push(
          `"## Exit codes" has no table row for \`${code}\` — cli/errors.ts's M3LCliExitCode is exactly 0 | 1 | 2, so all three are documented.`,
        );
      }
    }
  }

  return problems;
}

// Main execution — only run when invoked directly, not when imported for testing.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { json } = parseJsonFlag();
  const reporter = createReporter(json);
  const root = repoRoot(import.meta.url);

  let errors = 0;
  function report(message, file) {
    reporter.error(message, file ? { file } : undefined);
    errors++;
  }

  const mainPath = join(root, CLI_MAIN_PATH);
  let commandNames = [];
  if (!existsSync(mainPath)) {
    report(
      `${CLI_MAIN_PATH} is missing — it is where this gate reads the shipped command set from.`,
      CLI_MAIN_PATH,
    );
  } else {
    commandNames = shippedCommandNames(readFileSync(mainPath, "utf8"));
    if (commandNames.length === 0) {
      // An empty set would silently reduce the whole `## Commands`
      // cross-check to a no-op, which is exactly how a gate ships dead.
      report(
        `${CLI_MAIN_PATH}: no STATIC_COMMAND_NAMES entries could be extracted — the literal was renamed or reshaped, and the "## Commands" cross-check would silently pass. Update the regex in bin/check-cli-docs.mjs.`,
        CLI_MAIN_PATH,
      );
    }
  }

  const docPath = join(root, CLI_DOC_PATH);
  if (!existsSync(docPath)) {
    report(
      `${CLI_DOC_PATH} is missing — the CLI ships a contract page (ADR-0053 §Governance).`,
      CLI_DOC_PATH,
    );
  } else {
    for (const problem of cliDocStructureErrors(
      readFileSync(docPath, "utf8"),
      commandNames,
    )) {
      report(`${CLI_DOC_PATH}: ${problem}`, CLI_DOC_PATH);
    }
  }

  if (errors > 0) {
    if (!json) {
      console.error(
        `\n✗  ${errors} CLI doc-structure mismatch(es). The structure is specified in docs/contributing/cli-structure.md (ADR-0053).`,
      );
    }
    reporter.finish();
    process.exit(1);
  }

  reporter.succeed(
    `${CLI_DOC_PATH} follows the canonical structure and documents all ${commandNames.length} dispatched command(s).`,
  );
  reporter.finish();
}
