/**
 * Tests for the CLI contract-page structure checker (bin/check-cli-docs.mjs)
 * — covers the exported pure functions only. The module's CLI main block is
 * guarded behind `if (process.argv[1] === fileURLToPath(import.meta.url))`, so
 * importing it here executes nothing (the bin/check-script-deps.mjs
 * convention).
 *
 * Every check gets at least one synthetic FAILING fixture. The
 * `shippedCommandNames` block matters most: if that extraction silently
 * returned `[]`, the entire `## Commands` docs<->code cross-check would pass
 * vacuously, which is exactly how a gate ships dead (see
 * .claude/rules/tests.md).
 */
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CLI_CANONICAL_SECTIONS,
  CLI_DOC_PATH,
  CLI_DOC_TITLE,
  CLI_MAIN_PATH,
  CLI_NEAR_MISS_HEADINGS,
  CLI_REQUIRED_EXIT_CODES,
  cliDocStructureErrors,
  shippedCommandNames,
} from "../check-cli-docs.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

const COMMANDS = ["list", "inspect", "run", "help"];

/** A minimal page satisfying every rule — the base for negative fixtures. */
const CONFORMANT_CLI_DOC = `${CLI_DOC_TITLE}

Invocation: \`pnpm m3l <command>\` from the workspace root.

This page is the CLI's contract. It grows one section per shipped phase.

## Design invariants

- **Import-inert modules.** Nothing executes at import time.

## Commands

### Phase 8b — discovery

#### \`m3l list\`

Enumerates every script.

#### \`m3l inspect <script>\`

Prints one script's parameters.

#### \`m3l help\` / \`m3l --version\`

Usage text and the package version.

### Phase 8c — execution

#### \`m3l run <script> -- [args...]\`

Spawns the named script.

#### \`m3l <script> [--param value ...]\`

Dynamic per-script dispatch.

## Exit codes

| Code | Meaning | Raised by |
| ---- | ------- | --------- |
| \`0\` | Success | every happy path |
| \`1\` | Operational failure | a named M3LCliError |
| \`2\` | Usage error | an unknown command |
`;

/** Replace one substring in the conformant fixture. */
function docWithout(fragment: string, replacement = ""): string {
  if (!CONFORMANT_CLI_DOC.includes(fragment)) {
    throw new Error(`fixture drift: ${JSON.stringify(fragment)} not present`);
  }
  return CONFORMANT_CLI_DOC.replace(fragment, replacement);
}

describe("the fixture and the canonical list", () => {
  test("the conformant fixture produces no problems", () => {
    expect(cliDocStructureErrors(CONFORMANT_CLI_DOC, COMMANDS)).toEqual([]);
  });

  test("the canonical list is the five documented sections in order", () => {
    expect(CLI_CANONICAL_SECTIONS.map((section) => section.heading)).toEqual([
      "## Design invariants",
      "## Commands",
      "## Flows",
      "## Completion",
      "## Exit codes",
    ]);
  });

  test("only Flows and Completion are conditional, each tagged with its phase", () => {
    const optional = CLI_CANONICAL_SECTIONS.filter(
      (section) => !section.required,
    );
    expect(optional.map((section) => [section.heading, section.since])).toEqual(
      [
        ["## Flows", "U10"],
        ["## Completion", "U12"],
      ],
    );
  });

  test("every near-miss heading maps to a canonical heading", () => {
    const canonical = CLI_CANONICAL_SECTIONS.map((section) => section.heading);
    for (const target of Object.values(CLI_NEAR_MISS_HEADINGS)) {
      expect(canonical).toContain(target);
    }
  });
});

describe("title and preamble", () => {
  test("flags a wrong H1", () => {
    const errors = cliDocStructureErrors(
      CONFORMANT_CLI_DOC.replace(CLI_DOC_TITLE, "# The m3l CLI"),
      COMMANDS,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("first line must be exactly");
  });

  test("flags an empty preamble", () => {
    const errors = cliDocStructureErrors(
      `${CLI_DOC_TITLE}\n\n## Design invariants\n\n- ok\n\n## Commands\n\n### Phase\n\n#### \`m3l list\`\n\n#### \`m3l inspect\`\n\n#### \`m3l run\`\n\n#### \`m3l help\`\n\n## Exit codes\n\n| Code | Meaning |\n| ---- | ------- |\n| \`0\` | ok |\n| \`1\` | fail |\n| \`2\` | usage |\n`,
      COMMANDS,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("preamble");
  });

  test("flags a preamble that never names the pnpm m3l invocation", () => {
    const errors = cliDocStructureErrors(
      docWithout(
        "Invocation: `pnpm m3l <command>` from the workspace root.",
        "Run it.",
      ),
      COMMANDS,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("pnpm m3l");
  });

  test("flags a preamble missing the contract sentence", () => {
    const errors = cliDocStructureErrors(
      docWithout("This page is the CLI's contract.", "Some notes."),
      COMMANDS,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("contract");
  });
});

describe("required sections", () => {
  test.each(
    CLI_CANONICAL_SECTIONS.filter((section) => section.required).map(
      (section) => section.heading,
    ),
  )("flags a missing %s", (heading) => {
    const errors = cliDocStructureErrors(
      docWithout(`${heading}\n`, "## Something else\n"),
      COMMANDS,
    );
    expect(errors.join("\n")).toContain(`missing "${heading}" section`);
  });

  test("does not require the conditional sections", () => {
    const headings = CONFORMANT_CLI_DOC.match(/^## .+$/gm) ?? [];
    expect(headings).not.toContain("## Flows");
    expect(headings).not.toContain("## Completion");
    expect(cliDocStructureErrors(CONFORMANT_CLI_DOC, COMMANDS)).toEqual([]);
  });
});

describe("section ordering", () => {
  test("flags Exit codes placed before Commands", () => {
    const reordered = `${CLI_DOC_TITLE}

Invocation: \`pnpm m3l <command>\`.

This page is the CLI's contract.

## Design invariants

- ok

## Exit codes

| Code | Meaning |
| ---- | ------- |
| \`0\` | ok |
| \`1\` | fail |
| \`2\` | usage |

## Commands

### Phase 8b

#### \`m3l list\`

#### \`m3l inspect\`

#### \`m3l run\`

#### \`m3l help\`
`;
    const errors = cliDocStructureErrors(reordered, COMMANDS);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("## Commands");
    expect(errors[0]).toContain("canonical order");
  });

  test("an ABSENT optional section does not break its neighbours' order", () => {
    // The load-bearing ordering case: `## Flows` and `## Completion` sit
    // between `## Commands` and `## Exit codes` in the canonical list, so a
    // naive index comparison would reject the shipped page outright.
    expect(cliDocStructureErrors(CONFORMANT_CLI_DOC, COMMANDS)).toEqual([]);
  });

  test("a non-canonical H2 between two canonical ones carries no ordering opinion", () => {
    const withExtra = CONFORMANT_CLI_DOC.replace(
      "## Exit codes",
      "## See also\n\nADR-0053.\n\n## Exit codes",
    );
    expect(cliDocStructureErrors(withExtra, COMMANDS)).toEqual([]);
  });
});

describe("conditional sections", () => {
  test("accepts a Flows section carrying a named flow", () => {
    const withFlows = CONFORMANT_CLI_DOC.replace(
      "## Exit codes",
      "## Flows\n\n### queue-reconciliation\n\nA named flow.\n\n## Exit codes",
    );
    expect(cliDocStructureErrors(withFlows, COMMANDS)).toEqual([]);
  });

  test("flags a Flows section with no subsection", () => {
    const withFlows = CONFORMANT_CLI_DOC.replace(
      "## Exit codes",
      "## Flows\n\nComing in U10.\n\n## Exit codes",
    );
    const errors = cliDocStructureErrors(withFlows, COMMANDS);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("## Flows");
  });

  test("accepts a Completion section naming a shell", () => {
    const withCompletion = CONFORMANT_CLI_DOC.replace(
      "## Exit codes",
      "## Completion\n\nInstall the zsh completion script.\n\n## Exit codes",
    );
    expect(cliDocStructureErrors(withCompletion, COMMANDS)).toEqual([]);
  });

  test("flags a Completion section naming no shell", () => {
    const withCompletion = CONFORMANT_CLI_DOC.replace(
      "## Exit codes",
      "## Completion\n\nTab completion is supported.\n\n## Exit codes",
    );
    const errors = cliDocStructureErrors(withCompletion, COMMANDS);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("names no shell");
  });

  test("both conditional sections are validated independently when both are present", () => {
    const withBoth = CONFORMANT_CLI_DOC.replace(
      "## Exit codes",
      "## Flows\n\nProse only.\n\n## Completion\n\nProse only.\n\n## Exit codes",
    );
    expect(cliDocStructureErrors(withBoth, COMMANDS)).toHaveLength(2);
  });
});

describe("near-miss headings", () => {
  test.each(Object.entries(CLI_NEAR_MISS_HEADINGS))(
    "flags %s in favour of the canonical name",
    (nearMiss, canonical) => {
      const withNearMiss = CONFORMANT_CLI_DOC.replace(
        "## Exit codes",
        `${nearMiss}\n\nSomething.\n\n## Exit codes`,
      );
      const errors = cliDocStructureErrors(withNearMiss, COMMANDS);
      expect(errors.join("\n")).toContain(canonical);
    },
  );
});

describe("## Commands substructure", () => {
  test("flags a Commands section with no phase subsection", () => {
    // Both phase headings have to go — one surviving `### ` satisfies the rule.
    const flattened = docWithout("### Phase 8b — discovery\n\n").replace(
      "### Phase 8c — execution\n\n",
      "",
    );
    const errors = cliDocStructureErrors(flattened, COMMANDS);
    expect(errors.join("\n")).toContain('"## Commands" has no "### "');
  });

  test("flags a dispatched command with no #### heading", () => {
    const errors = cliDocStructureErrors(
      docWithout(
        "#### `m3l inspect <script>`\n\nPrints one script's parameters.\n\n",
      ),
      COMMANDS,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("does not document `m3l inspect`");
  });

  test("flags a documented command main.ts does not dispatch", () => {
    const errors = cliDocStructureErrors(
      CONFORMANT_CLI_DOC.replace(
        "#### `m3l list`",
        "#### `m3l list`\n\nOne.\n\n#### `m3l deploy`",
      ),
      COMMANDS,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("documents `m3l deploy`");
  });

  test("the <script> placeholder heading is not treated as a command", () => {
    expect(CONFORMANT_CLI_DOC).toContain("#### `m3l <script>");
    expect(cliDocStructureErrors(CONFORMANT_CLI_DOC, COMMANDS)).toEqual([]);
  });

  test("a non-command #### subsection is left alone", () => {
    // `#### Preset writing (8g consumer)` is a real, legitimate heading on the
    // shipped page — the gate must not require every #### to name a command.
    const withProseHeading = CONFORMANT_CLI_DOC.replace(
      "## Exit codes",
      "",
    ).replace(
      "Dynamic per-script dispatch.",
      "Dynamic per-script dispatch.\n\n#### Preset writing (8g consumer)\n\nInternal.",
    );
    const errors = cliDocStructureErrors(withProseHeading, COMMANDS);
    expect(errors.join("\n")).not.toContain("Preset writing");
  });

  test("matches on the command token, not the full signature", () => {
    // A `#### \`m3l help\` / \`m3l --version\`` heading documents `help`: the
    // gate reads the first token of the backticked span, not the whole line.
    const onlyHelp = `${CLI_DOC_TITLE}

Invocation: \`pnpm m3l <command>\`.

This page is the CLI's contract.

## Design invariants

- ok

## Commands

### Phase 8b

#### \`m3l help\` / \`m3l --version\`

Usage text.

## Exit codes

| Code | Meaning |
| ---- | ------- |
| \`0\` | ok |
| \`1\` | fail |
| \`2\` | usage |
`;
    expect(cliDocStructureErrors(onlyHelp, ["help"])).toEqual([]);
  });
});

describe("shippedCommandNames", () => {
  test("extracts all ten commands from the real main.ts", () => {
    const names = shippedCommandNames(
      readFileSync(join(repoRoot, CLI_MAIN_PATH), "utf8"),
    );
    expect(names).toEqual([
      "list",
      "inspect",
      "run",
      "doctor",
      "presets",
      "history",
      "new",
      "wizard",
      "completion",
      "help",
    ]);
  });

  test("returns an empty array when the literal is absent", () => {
    // The caller MUST treat this as a failure — an empty set would silently
    // reduce the whole `## Commands` cross-check to a no-op.
    expect(shippedCommandNames("export const OTHER = [];")).toEqual([]);
  });

  test("extracts a ninth name added to a synthetic literal", () => {
    // This is the case that proves the cross-check is not hard-coded: a new
    // command in main.ts becomes a documentation requirement immediately.
    const synthetic = `const STATIC_COMMAND_NAMES: readonly string[] = [
  "list",
  "inspect",
  "run",
  "doctor",
  "presets",
  "history",
  "wizard",
  "help",
  "flow",
];`;
    const names = shippedCommandNames(synthetic);
    expect(names).toHaveLength(9);
    expect(names).toContain("flow");
    // …and the shipped page, which documents no `m3l flow`, must now fail.
    const errors = cliDocStructureErrors(
      readFileSync(join(repoRoot, CLI_DOC_PATH), "utf8"),
      names,
    );
    expect(errors.join("\n")).toContain("does not document `m3l flow`");
  });
});

describe("## Exit codes substance", () => {
  test("flags an Exit codes section with prose but no table", () => {
    const errors = cliDocStructureErrors(
      CONFORMANT_CLI_DOC.replace(
        /## Exit codes\n[\s\S]*$/,
        "## Exit codes\n\nThe CLI exits `0`, `1` or `2`.\n",
      ),
      COMMANDS,
    );
    expect(errors.join("\n")).toContain("no markdown table");
  });

  test.each(CLI_REQUIRED_EXIT_CODES)(
    "flags an Exit codes table with no row for %s",
    (code) => {
      const errors = cliDocStructureErrors(
        CONFORMANT_CLI_DOC.replace(`| \`${code}\` |`, "| `9` |"),
        COMMANDS,
      );
      expect(errors.join("\n")).toContain(`no table row for \`${code}\``);
    },
  );
});

describe("the real docs/reference/cli.md", () => {
  test("conforms against the real main.ts command set", () => {
    const names = shippedCommandNames(
      readFileSync(join(repoRoot, CLI_MAIN_PATH), "utf8"),
    );
    expect(names.length).toBeGreaterThan(0);
    expect(
      cliDocStructureErrors(
        readFileSync(join(repoRoot, CLI_DOC_PATH), "utf8"),
        names,
      ),
    ).toEqual([]);
  });
});

describe("aggregate reporting", () => {
  test("reports every violation at once rather than stopping at the first", () => {
    const errors = cliDocStructureErrors("# Wrong title\n", COMMANDS);
    expect(errors.length).toBeGreaterThan(3);
  });

  test("an empty document fails on title, preamble and all required sections", () => {
    const errors = cliDocStructureErrors("", COMMANDS);
    expect(errors.join("\n")).toContain("first line must be exactly");
    expect(errors.join("\n")).toContain("preamble");
    for (const section of CLI_CANONICAL_SECTIONS.filter((s) => s.required)) {
      expect(errors.join("\n")).toContain(`missing "${section.heading}"`);
    }
  });
});
