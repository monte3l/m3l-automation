/**
 * Tests for bin/lib/script-docs.mjs — the pure-function module that validates
 * script README and reference-page structure against the canonical spec
 * (docs/contributing/script-docs-structure.md).
 *
 * bin/check-script-docs.mjs (the CLI runner) is NOT imported here: it executes
 * its full CLI body unconditionally at module load with no separately exported
 * functions. This file follows the established convention of exercising only the
 * exported, side-effect-free functions.
 */
import { describe, expect, expectTypeOf, test } from "vitest";
import {
  README_MIN_EXAMPLES,
  SCRIPT_DOCS_EXCEPTIONS,
  readmeStructureErrors,
  referenceStructureErrors,
} from "../lib/script-docs.mjs";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A fully conformant script README. All required sections and structural
 * constraints are satisfied; readmeStructureErrors() must return [].
 */
const CONFORMANT_README = [
  "> **This README covers how to run the script.**",
  "",
  "## Run",
  "",
  "### Examples",
  "",
  "```bash",
  "node dist/main.js --one",
  "node dist/main.js --two",
  "node dist/main.js --three",
  "```",
  "",
  "### Operational flags",
  "",
  "Common flags.",
  "",
  "## Environment",
  "",
  "Env vars.",
  "",
  "## Data directories",
  "",
  "Data dirs.",
].join("\n");

/**
 * A fully conformant reference page. All required sections are present and no
 * disallowed content exists; referenceStructureErrors() must return [].
 */
const CONFORMANT_REFERENCE = [
  "> **This page is the script's contract**",
  "",
  "## Purpose and scope",
  "",
  "Purpose text.",
  "",
  "## Configuration schema",
  "",
  "Schema details.",
  "",
  "## Steps",
  "",
  "Step details.",
  "",
  "## Inputs and outputs",
  "",
  "IO details.",
  "",
  "## See also",
  "",
  "Links.",
].join("\n");

// ---------------------------------------------------------------------------
// SCRIPT_DOCS_EXCEPTIONS
// ---------------------------------------------------------------------------

describe("SCRIPT_DOCS_EXCEPTIONS", () => {
  test("is a Set that contains 'json-etl'", () => {
    expect(SCRIPT_DOCS_EXCEPTIONS).toBeInstanceOf(Set);
    expect(SCRIPT_DOCS_EXCEPTIONS.has("json-etl")).toBe(true);
  });

  test("type is Set<string>", () => {
    expectTypeOf(SCRIPT_DOCS_EXCEPTIONS).toEqualTypeOf<Set<string>>();
  });
});

// ---------------------------------------------------------------------------
// README_MIN_EXAMPLES
// ---------------------------------------------------------------------------

describe("README_MIN_EXAMPLES", () => {
  test("is the number 3", () => {
    expect(README_MIN_EXAMPLES).toBe(3);
  });

  test("type is number", () => {
    expectTypeOf(README_MIN_EXAMPLES).toEqualTypeOf<number>();
  });
});

// ---------------------------------------------------------------------------
// readmeStructureErrors
// ---------------------------------------------------------------------------

describe("readmeStructureErrors", () => {
  test("returns [] for a fully conformant README", () => {
    expect(readmeStructureErrors(CONFORMANT_README, "test-script")).toEqual([]);
  });

  test("return type is string[]", () => {
    expectTypeOf(
      readmeStructureErrors(CONFORMANT_README, "test-script"),
    ).toEqualTypeOf<string[]>();
  });

  // ---- individual missing sections ----------------------------------------

  test("flags a missing contract blockquote", () => {
    const text = CONFORMANT_README.replace(
      "> **This README covers how to run the script.**",
      "Plain prose, no blockquote.",
    );
    expect(readmeStructureErrors(text, "test-script")).toContain(
      'missing the "This README covers how to run the script." contract blockquote — copy from the scaffold template or docs/contributing/script-docs-structure.md.',
    );
  });

  test("flags a missing '## Run' section", () => {
    const text = CONFORMANT_README.replace(/^## Run\s*$/m, "## NotPresent");
    expect(readmeStructureErrors(text, "test-script")).toContain(
      'missing "## Run" section (required, item 4 in spec).',
    );
  });

  test("flags a missing '### Examples' section", () => {
    const text = CONFORMANT_README.replace(
      /^### Examples\s*$/m,
      "### NotPresent",
    );
    expect(readmeStructureErrors(text, "test-script")).toContain(
      'missing "### Examples" section (required, item 5 in spec).',
    );
  });

  test("flags a missing '### Operational flags' section", () => {
    const text = CONFORMANT_README.replace(
      /^### Operational flags\s*$/m,
      "### NotPresent",
    );
    expect(readmeStructureErrors(text, "test-script")).toContain(
      'missing "### Operational flags" section (required for all scripts, item 7 in spec — copy the standard block from docs/contributing/script-docs-structure.md).',
    );
  });

  test("flags a missing '## Environment' section", () => {
    const text = CONFORMANT_README.replace(/^## Environment\b/m, "## NotEnv");
    expect(readmeStructureErrors(text, "test-script")).toContain(
      'missing "## Environment (.env)" section (required, item 8 in spec).',
    );
  });

  test("flags a missing '## Data directories' section", () => {
    const text = CONFORMANT_README.replace(
      /^## Data directories\s*$/m,
      "## NotPresent",
    );
    expect(readmeStructureErrors(text, "test-script")).toContain(
      'missing "## Data directories" section (required, item 9 in spec).',
    );
  });

  // ---- Examples section edge cases ----------------------------------------

  test("accepts '## Environment (.env)' variant (word-boundary match)", () => {
    const text = CONFORMANT_README.replace(
      "## Environment",
      "## Environment (.env)",
    );
    const errors = readmeStructureErrors(text, "test-script");
    expect(errors.some((e) => e.includes("Environment"))).toBe(false);
  });

  test("flags a scaffold placeholder comment inside the Examples section", () => {
    const text = CONFORMANT_README.replace(
      "node dist/main.js --one\nnode dist/main.js --two\nnode dist/main.js --three",
      "<!-- Add 3 examples here -->\nnode dist/main.js --one\nnode dist/main.js --two\nnode dist/main.js --three",
    );
    expect(readmeStructureErrors(text, "test-script")).toContain(
      '"### Examples" still carries the scaffold placeholder comment — replace with real, runnable examples.',
    );
  });

  test("flags a placeholder and still checks the example count (both errors present)", () => {
    // Only 1 example, which is below the minimum, plus a placeholder
    const text = [
      "> **This README covers how to run the script.**",
      "",
      "## Run",
      "",
      "### Examples",
      "",
      "<!-- Add examples here -->",
      "",
      "node dist/main.js --only-one",
      "",
      "### Operational flags",
      "",
      "## Environment",
      "",
      "## Data directories",
    ].join("\n");
    const errors = readmeStructureErrors(text, "test-script");
    expect(errors).toContain(
      '"### Examples" still carries the scaffold placeholder comment — replace with real, runnable examples.',
    );
    expect(errors.some((e) => e.includes("runnable example(s)"))).toBe(true);
  });

  test.each([
    [0, "no examples after the heading"],
    [1, "one example below the minimum"],
    [2, "two examples still below the minimum"],
  ])(
    "flags the count when there are %i example(s) after the '### Examples' heading (%s)",
    (count) => {
      const examples = Array.from(
        { length: count },
        (_, i) => `node dist/main.js --arg${String(i)}`,
      ).join("\n");
      const text = [
        "> **This README covers how to run the script.**",
        "",
        "## Run",
        "",
        "### Examples",
        "",
        examples,
        "",
        "### Operational flags",
        "",
        "## Environment",
        "",
        "## Data directories",
      ].join("\n");
      const errors = readmeStructureErrors(text, "test-script");
      expect(
        errors.some(
          (e) =>
            e.includes("runnable example(s)") &&
            e.includes(`has ${String(count)} runnable`),
        ),
      ).toBe(true);
    },
  );

  test("does not flag the count when there are exactly README_MIN_EXAMPLES examples (boundary)", () => {
    // CONFORMANT_README already has exactly README_MIN_EXAMPLES (3) occurrences.
    const errors = readmeStructureErrors(CONFORMANT_README, "test-script");
    expect(errors.some((e) => e.includes("runnable example(s)"))).toBe(false);
  });

  test("does not count 'node dist/main.js' occurrences that appear BEFORE the '### Examples' heading", () => {
    // Three occurrences before the heading and zero after → should flag too few
    const text = [
      "> **This README covers how to run the script.**",
      "",
      "node dist/main.js before-one",
      "node dist/main.js before-two",
      "node dist/main.js before-three",
      "",
      "## Run",
      "",
      "### Examples",
      "",
      "No runnable examples here.",
      "",
      "### Operational flags",
      "",
      "## Environment",
      "",
      "## Data directories",
    ].join("\n");
    const errors = readmeStructureErrors(text, "test-script");
    expect(errors.some((e) => e.includes("has 0 runnable"))).toBe(true);
  });

  // ---- Operations at a glance / Command column check ----------------------

  test("flags 'Command' column header when '### Operations at a glance' is present", () => {
    const text = [
      CONFORMANT_README,
      "",
      "### Operations at a glance",
      "",
      "| Operation | Command | Description |",
      "| --- | --- | --- |",
    ].join("\n");
    expect(readmeStructureErrors(text, "test-script")).toContain(
      '"### Operations at a glance" uses a "Command" column header — rename to "Operation" (spec §README, item 6).',
    );
  });

  test("does not flag the column when '### Operations at a glance' uses 'Operation' instead of 'Command'", () => {
    const text = [
      CONFORMANT_README,
      "",
      "### Operations at a glance",
      "",
      "| Operation | Description |",
      "| --- | --- |",
    ].join("\n");
    const errors = readmeStructureErrors(text, "test-script");
    expect(errors.some((e) => e.includes("Command"))).toBe(false);
  });

  test("does not flag a '| Command |' column when '### Operations at a glance' is absent", () => {
    // The check is conditional on both regexes matching — a Command column
    // outside that section must not trigger the error.
    const text = [
      CONFORMANT_README,
      "",
      "Some other section with a Command column:",
      "",
      "| Command | Description |",
      "| --- | --- |",
    ].join("\n");
    const errors = readmeStructureErrors(text, "test-script");
    expect(errors.some((e) => e.includes('"### Operations at a glance"'))).toBe(
      false,
    );
  });

  // ---- multiple violations at once ----------------------------------------

  test("collects one error per violated rule when several sections are missing simultaneously", () => {
    // Only the blockquote is present; every section is absent
    const text = "> **This README covers how to run the script.**";
    const errors = readmeStructureErrors(text, "test-script");
    expect(errors).toContain(
      'missing "## Run" section (required, item 4 in spec).',
    );
    expect(errors).toContain(
      'missing "### Examples" section (required, item 5 in spec).',
    );
    expect(errors).toContain(
      'missing "### Operational flags" section (required for all scripts, item 7 in spec — copy the standard block from docs/contributing/script-docs-structure.md).',
    );
    expect(errors).toContain(
      'missing "## Environment (.env)" section (required, item 8 in spec).',
    );
    expect(errors).toContain(
      'missing "## Data directories" section (required, item 9 in spec).',
    );
    expect(errors.length).toBeGreaterThanOrEqual(5);
  });

  test("returns all errors for a completely empty string", () => {
    const errors = readmeStructureErrors("", "test-script");
    // All required sections are absent → at least 6 errors
    expect(errors.length).toBeGreaterThanOrEqual(6);
  });
});

// ---------------------------------------------------------------------------
// referenceStructureErrors
// ---------------------------------------------------------------------------

describe("referenceStructureErrors", () => {
  test("returns [] for a fully conformant reference page", () => {
    expect(
      referenceStructureErrors(CONFORMANT_REFERENCE, "test-script"),
    ).toEqual([]);
  });

  test("return type is string[]", () => {
    expectTypeOf(
      referenceStructureErrors(CONFORMANT_REFERENCE, "test-script"),
    ).toEqualTypeOf<string[]>();
  });

  // ---- individual missing sections ----------------------------------------

  test.each([
    [
      "contract blockquote",
      "> **This page is the script's contract**",
      "Plain prose, no blockquote.",
      'missing the "This page is the script\'s contract" blockquote — copy from the scaffold template or docs/contributing/script-docs-structure.md.',
    ],
    [
      "'## Purpose and scope'",
      "## Purpose and scope",
      "## NotPresent",
      'missing "## Purpose and scope" section (required, item 4 in spec).',
    ],
    [
      "'## Configuration schema'",
      "## Configuration schema",
      "## NotPresent",
      'missing "## Configuration schema" section (required, item 5 in spec).',
    ],
    [
      "'## Steps'",
      "## Steps",
      "## NotPresent",
      'missing "## Steps" section (required, item 6 in spec).',
    ],
    [
      "'## Inputs and outputs'",
      "## Inputs and outputs",
      "## NotPresent",
      'missing "## Inputs and outputs" section (required, item 8 in spec).',
    ],
    [
      "'## See also'",
      "## See also",
      "## NotPresent",
      'missing "## See also" section (required, item 9 in spec).',
    ],
  ])("flags a missing %s", (_label, original, replacement, expectedError) => {
    const text = CONFORMANT_REFERENCE.replace(original, replacement);
    expect(referenceStructureErrors(text, "test-script")).toContain(
      expectedError,
    );
  });

  // ---- disallowed column header -------------------------------------------

  test("flags the disallowed 'Declarative `validate:`' column header", () => {
    const text = [
      CONFORMANT_REFERENCE,
      "",
      "| Parameter | Declarative `validate:` | Description |",
      "| --- | --- | --- |",
    ].join("\n");
    expect(referenceStructureErrors(text, "test-script")).toContain(
      'config table uses disallowed "Declarative `validate:`" column header — rename to "Validation" (spec §Reference page, §Configuration schema table).',
    );
  });

  test("does not flag a 'Validation' column header (the correct label)", () => {
    const text = [
      CONFORMANT_REFERENCE,
      "",
      "| Parameter | Validation | Description |",
      "| --- | --- | --- |",
    ].join("\n");
    const errors = referenceStructureErrors(text, "test-script");
    expect(errors.some((e) => e.includes("Declarative"))).toBe(false);
  });

  // ---- multiple violations at once ----------------------------------------

  test("collects one error per violated rule when several sections are missing simultaneously", () => {
    // Only the blockquote is present; every required section is absent
    const text = "> **This page is the script's contract**";
    const errors = referenceStructureErrors(text, "test-script");
    expect(errors).toContain(
      'missing "## Purpose and scope" section (required, item 4 in spec).',
    );
    expect(errors).toContain(
      'missing "## Configuration schema" section (required, item 5 in spec).',
    );
    expect(errors).toContain(
      'missing "## Steps" section (required, item 6 in spec).',
    );
    expect(errors).toContain(
      'missing "## Inputs and outputs" section (required, item 8 in spec).',
    );
    expect(errors).toContain(
      'missing "## See also" section (required, item 9 in spec).',
    );
    expect(errors.length).toBeGreaterThanOrEqual(5);
  });

  test("returns all errors for a completely empty string", () => {
    const errors = referenceStructureErrors("", "test-script");
    // All required sections absent → at least 6 errors (blockquote + 5 sections)
    expect(errors.length).toBeGreaterThanOrEqual(6);
  });

  test("reports the disallowed column header in addition to missing sections when both are present", () => {
    const text = "Declarative `validate:` appears here but no sections exist.";
    const errors = referenceStructureErrors(text, "test-script");
    expect(errors).toContain(
      'config table uses disallowed "Declarative `validate:`" column header — rename to "Validation" (spec §Reference page, §Configuration schema table).',
    );
    expect(errors).toContain(
      'missing "## Purpose and scope" section (required, item 4 in spec).',
    );
  });
});
