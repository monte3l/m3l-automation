// Pure functions for checking script README and reference-page structure
// against the canonical spec (docs/contributing/script-docs-structure.md).
// Consumed by bin/check-script-docs.mjs and bin/tests/check-script-docs.test.ts.

/**
 * Script names whose documented structural deviations are sanctioned and must
 * not fail the gate. See docs/contributing/script-docs-structure.md
 * §Sanctioned deviations.
 *
 * Currently only `json-etl`, whose richer/longer README shape and
 * numbered-example subsections are intentional — the gate still checks that all
 * required sections are present; it only suppresses count/format checks that
 * the standard enforces differently for this script.
 */
export const SCRIPT_DOCS_EXCEPTIONS = new Set(["json-etl"]);

// ---------------------------------------------------------------------------
// README checks
// ---------------------------------------------------------------------------

/** The "This README covers how to run the script." contract blockquote. */
const README_BLOCKQUOTE_RE =
  />\s+\*\*This README covers how to run the script\.\*\*/;

/** `## Run` H2 heading. */
const RUN_SECTION_RE = /^## Run\s*$/m;

/** `### Examples` H3 heading. */
const EXAMPLES_HEADING_RE = /^### Examples\s*$/m;

/** Scaffold placeholder comments (old or new template format). */
const EXAMPLES_PLACEHOLDER_RE = /<!--\s*Add[^>]*-->/;

/** Any `node dist/main.js` invocation (proxy for one runnable example). */
const RUNNABLE_EXAMPLE_OCCURRENCE_RE = /node dist\/main\.js/g;

/** `### Operational flags` H3 heading. */
const OPERATIONAL_FLAGS_RE = /^### Operational flags\s*$/m;

/** `## Environment` H2 heading (accepts `## Environment (.env)` etc.). */
const ENVIRONMENT_SECTION_RE = /^## Environment\b/m;

/** `## Data directories` H2 heading. */
const DATA_DIRS_SECTION_RE = /^## Data directories\s*$/m;

/** `### Operations at a glance` H3 heading. */
const OPS_AT_A_GLANCE_RE = /^### Operations at a glance\s*$/m;

/**
 * A markdown table column header containing the word "Command" — the
 * disallowed label; all "Operations at a glance" tables must use "Operation".
 */
const COMMAND_COLUMN_RE = /\|\s*Command\s*\|/i;

/** Minimum number of runnable `node dist/main.js` examples required per README. */
export const README_MIN_EXAMPLES = 3;

/**
 * Validate a script README against the canonical structure spec
 * (docs/contributing/script-docs-structure.md).
 *
 * Returns human-readable problem strings (empty array = conformant). Pass
 * `name` so the allowlist can suppress checks that are sanctioned exceptions.
 *
 * @param {string} text - full README.md content
 * @param {string} _name - script package name (kebab-case); reserved for future per-script allowlist use
 * @returns {string[]}
 */
export function readmeStructureErrors(text, _name) {
  const problems = [];

  if (!README_BLOCKQUOTE_RE.test(text)) {
    problems.push(
      'missing the "This README covers how to run the script." contract blockquote — copy from the scaffold template or docs/contributing/script-docs-structure.md.',
    );
  }

  if (!RUN_SECTION_RE.test(text)) {
    problems.push('missing "## Run" section (required, item 4 in spec).');
  }

  const headingMatch = EXAMPLES_HEADING_RE.exec(text);
  if (!headingMatch) {
    problems.push(
      'missing "### Examples" section (required, item 5 in spec).',
    );
  } else {
    if (EXAMPLES_PLACEHOLDER_RE.test(text)) {
      problems.push(
        '"### Examples" still carries the scaffold placeholder comment — replace with real, runnable examples.',
      );
    }
    const afterHeading = text.slice(
      headingMatch.index + headingMatch[0].length,
    );
    const count = (afterHeading.match(RUNNABLE_EXAMPLE_OCCURRENCE_RE) ?? [])
      .length;
    if (count < README_MIN_EXAMPLES) {
      problems.push(
        `"### Examples" has ${count} runnable example(s) but at least ${README_MIN_EXAMPLES} are required — scale to the script's operation count and complexity (see docs/contributing/script-docs-structure.md §Examples).`,
      );
    }
  }

  if (!OPERATIONAL_FLAGS_RE.test(text)) {
    problems.push(
      'missing "### Operational flags" section (required for all scripts, item 7 in spec — copy the standard block from docs/contributing/script-docs-structure.md).',
    );
  }

  if (!ENVIRONMENT_SECTION_RE.test(text)) {
    problems.push(
      'missing "## Environment (.env)" section (required, item 8 in spec).',
    );
  }

  if (!DATA_DIRS_SECTION_RE.test(text)) {
    problems.push(
      'missing "## Data directories" section (required, item 9 in spec).',
    );
  }

  // If "Operations at a glance" is present its column header must be "Operation".
  if (OPS_AT_A_GLANCE_RE.test(text) && COMMAND_COLUMN_RE.test(text)) {
    problems.push(
      '"### Operations at a glance" uses a "Command" column header — rename to "Operation" (spec §README, item 6).',
    );
  }

  return problems;
}

// ---------------------------------------------------------------------------
// Reference-page checks
// ---------------------------------------------------------------------------

/** The "This page is the script's contract" blockquote. */
const REF_BLOCKQUOTE_RE =
  />\s+\*\*This page is the script's contract\*\*/;

/** `## Purpose and scope` H2 heading. */
const PURPOSE_SECTION_RE = /^## Purpose and scope\s*$/m;

/** `## Configuration schema` H2 heading. */
const CONFIG_SECTION_RE = /^## Configuration schema\s*$/m;

/** `## Steps` H2 heading. */
const STEPS_SECTION_RE = /^## Steps\s*$/m;

/** `## Inputs and outputs` H2 heading. */
const IO_SECTION_RE = /^## Inputs and outputs\s*$/m;

/** `## See also` H2 heading. */
const SEE_ALSO_SECTION_RE = /^## See also\s*$/m;

/**
 * Detects the disallowed "Declarative `validate:`" config-table column header
 * variant. The correct and only allowed label is "Validation".
 */
const DECLARATIVE_VALIDATE_COLUMN_RE = /Declarative `validate:`/;

/**
 * Validate a script reference page against the canonical structure spec
 * (docs/contributing/script-docs-structure.md).
 *
 * Returns human-readable problem strings (empty array = conformant). Pass
 * `name` for future per-script allowlist use (currently unused on the
 * reference-page side).
 *
 * @param {string} text - full reference page content
 * @param {string} _name - script package name (kebab-case); reserved for future per-script allowlist use
 * @returns {string[]}
 */
export function referenceStructureErrors(text, _name) {
  const problems = [];

  if (!REF_BLOCKQUOTE_RE.test(text)) {
    problems.push(
      'missing the "This page is the script\'s contract" blockquote — copy from the scaffold template or docs/contributing/script-docs-structure.md.',
    );
  }

  if (!PURPOSE_SECTION_RE.test(text)) {
    problems.push(
      'missing "## Purpose and scope" section (required, item 4 in spec).',
    );
  }

  if (!CONFIG_SECTION_RE.test(text)) {
    problems.push(
      'missing "## Configuration schema" section (required, item 5 in spec).',
    );
  }

  if (!STEPS_SECTION_RE.test(text)) {
    problems.push('missing "## Steps" section (required, item 6 in spec).');
  }

  if (!IO_SECTION_RE.test(text)) {
    problems.push(
      'missing "## Inputs and outputs" section (required, item 8 in spec).',
    );
  }

  if (!SEE_ALSO_SECTION_RE.test(text)) {
    problems.push(
      'missing "## See also" section (required, item 9 in spec).',
    );
  }

  if (DECLARATIVE_VALIDATE_COLUMN_RE.test(text)) {
    problems.push(
      'config table uses disallowed "Declarative `validate:`" column header — rename to "Validation" (spec §Reference page, §Configuration schema table).',
    );
  }

  return problems;
}
