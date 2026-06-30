#!/usr/bin/env node
// Enforces two doc-sync checks:
//
// Check 1 — Commands table ↔ package.json scripts
//   Every user-facing package.json script (excluding "prepare") must appear
//   as `pnpm <script>` in the CLAUDE.md Commands table, and every `pnpm <x>`
//   entry in that table where <x> exactly matches a script key must correspond
//   to a real script. Table entries that are not of the form `pnpm <key>` (e.g.
//   `pnpm vitest run tests/x.test.ts`) are skipped — they don't map to a single
//   script name and are intentionally freeform.
//
// Check 2 — Hooks enumeration ↔ filesystem + CLAUDE.md
//   Every .mjs hook registered in .claude/settings.json must be mentioned in
//   CLAUDE.md, and every .mjs basename mentioned in the CLAUDE.md hooks section
//   must be registered in .claude/settings.json.
//
// Usage:
//   node bin/check-doc-sync.mjs   # verify sync (exits 1 on any mismatch)
import process from "node:process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read a file relative to repo root, return its contents or null on error. */
function readFile(relPath) {
  try {
    return readFileSync(join(root, relPath), "utf8");
  } catch {
    return null;
  }
}

/**
 * Extract the text between a start marker (inclusive line match) and the next
 * `## ` heading. The start line itself is included.
 */
function extractSection(content, startMarker) {
  const lines = content.split("\n");
  const startIdx = lines.findIndex((l) => l.includes(startMarker));
  if (startIdx === -1) return null;
  const end = lines.findIndex((l, i) => i > startIdx && /^## /.test(l));
  return lines.slice(startIdx, end === -1 ? undefined : end).join("\n");
}

// ---------------------------------------------------------------------------
// Check 1: Commands table ↔ package.json scripts
// ---------------------------------------------------------------------------

let errors = 0;

const pkgContent = readFile("package.json");
if (!pkgContent) {
  process.stderr.write("✗  check:doc-sync: cannot read package.json\n");
  process.exit(1);
}
const pkg = JSON.parse(pkgContent);
const allScripts = Object.keys(pkg.scripts ?? {});
// User-facing: everything except "prepare" (internal lifecycle hook)
const userFacingScripts = new Set(allScripts.filter((s) => s !== "prepare"));

const claudeContent = readFile("CLAUDE.md");
if (!claudeContent) {
  process.stderr.write("✗  check:doc-sync: cannot read CLAUDE.md\n");
  process.exit(1);
}

// Extract the Commands section (between ## Commands and the next ##)
const commandsSection = extractSection(claudeContent, "## Commands");
if (!commandsSection) {
  process.stderr.write(
    "✗  check:doc-sync: ## Commands section not found in CLAUDE.md\n",
  );
  errors++;
}

// Parse table rows: lines starting with | that are not header or separator
// Column 2 (index 1) holds the command cell. Extract backtick spans from it.
const tableCommandScripts = new Set();
const tableRawEntries = []; // all `pnpm ...` strings found in table

if (commandsSection) {
  const tableRows = commandsSection
    .split("\n")
    .filter((l) => l.startsWith("|") && !l.match(/^\|\s*[-:]+\s*\|/));

  for (const row of tableRows) {
    // Split on | and take the second column (index 1, 0-based after split)
    const cols = row.split("|");
    if (cols.length < 3) continue; // need at least | col1 | col2 |
    const col2 = cols[2]; // second data column
    // Find all backtick spans
    const spans = [...col2.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim());
    for (const span of spans) {
      if (!span.startsWith("pnpm ")) continue;
      tableRawEntries.push(span);
      const rest = span.slice("pnpm ".length).trim();
      // Only treat it as a direct script reference if `rest` has no spaces
      // (i.e. `pnpm test`, `pnpm check:api` — not `pnpm vitest run ...`)
      if (!rest.includes(" ")) {
        tableCommandScripts.add(rest);
      }
    }
  }
}

// Forward direction: every user-facing package.json script must appear in table
for (const script of userFacingScripts) {
  if (!tableCommandScripts.has(script)) {
    process.stderr.write(
      `✗  check:doc-sync: 'pnpm ${script}' is in package.json scripts but not in CLAUDE.md Commands table\n`,
    );
    errors++;
  }
}

// Reverse direction: every simple `pnpm <x>` in table must exist as a script
for (const script of tableCommandScripts) {
  if (!userFacingScripts.has(script)) {
    process.stderr.write(
      `✗  check:doc-sync: 'pnpm ${script}' is in CLAUDE.md Commands table but not in package.json scripts\n`,
    );
    errors++;
  }
}

// ---------------------------------------------------------------------------
// Check 2: Hooks enumeration ↔ CLAUDE.md
// ---------------------------------------------------------------------------

const settingsContent = readFile(".claude/settings.json");
if (!settingsContent) {
  process.stderr.write(
    "✗  check:doc-sync: cannot read .claude/settings.json\n",
  );
  errors++;
} else {
  // Extract all .mjs basenames from hook "command" values in settings.json.
  // Parse as JSON (not regex) because the command strings contain escaped quotes.
  let settingsObj;
  try {
    settingsObj = JSON.parse(settingsContent);
  } catch {
    process.stderr.write(
      "✗  check:doc-sync: .claude/settings.json is not valid JSON\n",
    );
    errors++;
    settingsObj = null;
  }

  /** Recursively collect all string values of "command" keys. */
  function collectCommands(node, acc = []) {
    if (Array.isArray(node)) {
      for (const v of node) collectCommands(v, acc);
    } else if (node !== null && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) {
        if (k === "command" && typeof v === "string") {
          acc.push(v);
        } else {
          collectCommands(v, acc);
        }
      }
    }
    return acc;
  }

  const settingsHooks = new Set(
    collectCommands(settingsObj ?? {})
      .filter((cmd) => cmd.includes(".mjs"))
      .map((cmd) => {
        const match = cmd.match(/([\w.-]+\.mjs)/);
        return match ? match[1] : null;
      })
      .filter(Boolean),
  );

  // Extract .mjs basenames mentioned in the CLAUDE.md hooks section
  // The hooks section starts at "**Claude Code hooks**" and ends at the next ##
  const hooksSection = extractSection(claudeContent, "**Claude Code hooks**");
  const claudeHooks = new Set();
  if (hooksSection) {
    for (const match of hooksSection.matchAll(/([\w.-]+\.mjs)/g)) {
      claudeHooks.add(match[1]);
    }
  } else {
    process.stderr.write(
      "✗  check:doc-sync: hooks section (**Claude Code hooks**) not found in CLAUDE.md\n",
    );
    errors++;
  }

  // Forward: every hook registered in settings.json must be mentioned in CLAUDE.md
  for (const hook of settingsHooks) {
    if (!claudeHooks.has(hook)) {
      process.stderr.write(
        `✗  check:doc-sync: '${hook}' is registered in settings.json but not mentioned in CLAUDE.md\n`,
      );
      errors++;
    }
  }

  // Reverse: every hook mentioned in CLAUDE.md hooks section must be in settings.json
  for (const hook of claudeHooks) {
    if (!settingsHooks.has(hook)) {
      process.stderr.write(
        `✗  check:doc-sync: '${hook}' is mentioned in CLAUDE.md but not registered in settings.json\n`,
      );
      errors++;
    }
  }
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

if (errors > 0) {
  process.exit(1);
}

console.log("✓  check:doc-sync — all sync checks passed.");
