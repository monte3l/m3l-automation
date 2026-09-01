#!/usr/bin/env node
// Validates the Claude Code hook wiring in .claude/settings.json:
//   1. Every hook `command` that runs a .claude/hooks/*.mjs script resolves to a
//      file that actually exists (a typo or a renamed/deleted hook is an error).
//   2. No orphans: every .claude/hooks/*.mjs file is referenced by at least one
//      hook command (a hook written but never wired is dead — warned, not fatal,
//      mirroring check-agents.mjs's unused-agent warning).
//   3. Every top-level key under `hooks` is a real Claude Code lifecycle event
//      (a typo like "PostToolUseX" would otherwise silently do nothing — error).
//   4. Every hook command carries an explicit `timeout` (seconds); a hook that
//      inherits the platform default has no repo-visible bound — warned, not
//      fatal, so this can be tightened incrementally.
//
// This is the hook-side analogue of check:agents. New hooks (the signed-push
// Bash guard, the decision-gate injector) get a safety net so a wiring mistake
// fails CI instead of silently doing nothing.
//
// Usage:
//   node bin/check-hooks.mjs   # exits 0 on success, 1 on any violation
import process from "node:process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, basename } from "node:path";
import { parseJsonFlag, createReporter, repoRoot } from "./lib/report.mjs";

const hooksReferenceRel = "docs/contributing/hooks-reference.md";

// The full set of Claude Code hook lifecycle events, per the official hooks
// reference: https://code.claude.com/docs/en/hooks
export const KNOWN_EVENTS = new Set([
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PostToolBatch",
  "UserPromptSubmit",
  "SessionStart",
  "SessionEnd",
  "Stop",
  "StopFailure",
  "SubagentStart",
  "SubagentStop",
  "Notification",
  "PreCompact",
  "PostCompact",
  "Setup",
  "PermissionRequest",
  "PermissionDenied",
]);

// Events whose `matcher` field is a documented, closed set of values rather
// than a free-form tool-name pattern (PreToolUse/PostToolUse's `matcher` is
// the latter — a tool name or `Tool1|Tool2` alternation — and has no fixed
// enum to validate against). A typo here (e.g. `matcher: "compct"`) would
// otherwise silently no-op the entry with no gate catching it — the exact
// failure mode that can disable post-compaction re-injection
// (`.claude/hooks/reinject-compact-handoff.mjs`, `SessionStart` + `matcher:
// "compact"`). Source: https://code.claude.com/docs/en/hooks (2026-09-01).
export const KNOWN_MATCHERS = new Map([
  ["SessionStart", new Set(["startup", "resume", "clear", "compact", "fork"])],
  ["PreCompact", new Set(["manual", "auto"])],
  ["PostCompact", new Set(["manual", "auto"])],
]);

/**
 * Pull the `.claude/hooks/<name>.mjs` script name out of a hook `command`
 * string, regardless of the `$CLAUDE_PROJECT_DIR` prefix / quoting around it.
 *
 * @param {string} command
 * @returns {string | null}
 */
export function extractHookScriptName(command) {
  const m = (command ?? "").match(/\.claude\/hooks\/([A-Za-z0-9._-]+\.mjs)/);
  return m === null ? null : m[1];
}

/**
 * Validate a parsed `.claude/settings.json` hook wiring against the on-disk
 * hook scripts. Pure function — takes the parsed `settings` object plus the
 * collaborators needed to check disk state, so it is unit-testable without
 * touching the filesystem.
 *
 * @param {{ hooks?: Record<string, Array<{ matcher?: string, hooks?: Array<{ command?: string, timeout?: number }> }>> }} settings
 * @param {{ hookFileExists: (name: string) => boolean, onDiskHookNames: string[] }} deps
 * @returns {{ errors: string[], warnings: string[], referenced: Set<string> }}
 */
export function validateHooksConfig(
  settings,
  { hookFileExists, onDiskHookNames },
) {
  const errors = [];
  const warnings = [];
  const referenced = new Set();

  for (const [event, entries] of Object.entries(settings.hooks ?? {})) {
    if (!KNOWN_EVENTS.has(event)) {
      errors.push(
        `.claude/settings.json wires unknown hook event "${event}" ` +
          `(not in the documented Claude Code event set — typo?).`,
      );
    }

    const knownMatchers = KNOWN_MATCHERS.get(event);
    for (const entry of entries) {
      if (knownMatchers !== undefined && typeof entry.matcher === "string") {
        for (const token of entry.matcher.split("|")) {
          if (!knownMatchers.has(token)) {
            errors.push(
              `.claude/settings.json's "${event}" entry has matcher ` +
                `"${entry.matcher}" — "${token}" is not one of the ` +
                `documented values [${[...knownMatchers].join(", ")}] ` +
                `(typo? a mismatched matcher silently never fires).`,
            );
          }
        }
      }

      for (const hook of entry.hooks ?? []) {
        const name = extractHookScriptName(hook.command ?? "");
        if (name === null) continue;
        referenced.add(name);
        if (!hookFileExists(name)) {
          errors.push(
            `.claude/settings.json wires "${name}" but ` +
              `.claude/hooks/${name} does not exist.`,
          );
        }
        if (typeof hook.timeout !== "number") {
          warnings.push(
            `.claude/hooks/${name} (${event}) has no explicit "timeout" — ` +
              `it inherits the platform default instead of a repo-visible bound.`,
          );
        }
      }
    }
  }

  for (const name of onDiskHookNames) {
    if (!referenced.has(basename(name))) {
      warnings.push(
        `.claude/hooks/${name} exists but is not wired into ` +
          `.claude/settings.json (dead hook?).`,
      );
    }
  }

  return { errors, warnings, referenced };
}

/**
 * Extract the bare glob from a Claude Code `if:` permission-rule string
 * like `Write(dist/glob-here)` or `Edit(*.md)`.
 *
 * @param {string} ifRule
 * @returns {string | null}
 */
export function extractIfGlob(ifRule) {
  const m = (ifRule ?? "").match(/^(?:Write|Edit)\(([^)]*)\)$/);
  return m === null ? null : m[1];
}

/**
 * Group every `if:`-scoped glob actually wired in `.claude/settings.json`,
 * keyed by `${event}::${hookScriptName}`, deduplicated — a guard scoped to
 * one glob is typically wired twice (once for `Write`, once for `Edit`).
 *
 * @param {{ hooks?: Record<string, Array<{ hooks?: Array<{ command?: string, if?: string }> }>> }} settings
 * @returns {Map<string, Set<string>>}
 */
export function collectSettingsIfGlobs(settings) {
  /** @type {Map<string, Set<string>>} */
  const byKey = new Map();
  for (const [event, entries] of Object.entries(settings.hooks ?? {})) {
    for (const entry of entries) {
      for (const hook of entry.hooks ?? []) {
        const name = extractHookScriptName(hook.command ?? "");
        if (name === null) continue;
        const glob = extractIfGlob(hook.if ?? "");
        if (glob === null) continue;
        const key = `${event}::${name}`;
        if (!byKey.has(key)) byKey.set(key, new Set());
        byKey.get(key).add(glob);
      }
    }
  }
  return byKey;
}

/**
 * Parse `docs/contributing/hooks-reference.md`'s hook inventory table into
 * one row per (event, hook), pulling any `if \`glob\`[, \`glob\`...]` clause
 * out of the Matcher cell. A markdown table cell escapes a literal pipe as
 * `\|` (e.g. `` `Write\|Edit` ``) — that escape is honored so the cell isn't
 * mis-split on it.
 *
 * @param {string} markdown
 * @returns {Array<{ event: string, hookName: string, ifGlobs: string[] }>}
 */
export function parseHooksReferenceTable(markdown) {
  const ESCAPED_PIPE = "\u0000PIPE\u0000";
  /** @type {Array<{ event: string, hookName: string, ifGlobs: string[] }>} */
  const rows = [];
  for (const line of markdown.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line
      .replace(/\\\|/g, ESCAPED_PIPE)
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim().replaceAll(ESCAPED_PIPE, "|"));
    if (cells.length < 3) continue;
    const [eventCell, matcherCell, hookCell] = cells;
    if (eventCell === "Event" || /^-+$/.test(eventCell.replace(/\s/g, "")))
      continue;
    const hookMatch = hookCell.match(/^`([\w.-]+\.mjs)`$/);
    if (hookMatch === null) continue;
    const ifMatch = matcherCell.match(/\bif\b(.+)$/);
    const ifGlobs =
      ifMatch === null
        ? []
        : [...ifMatch[1].matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    rows.push({ event: eventCell, hookName: hookMatch[1], ifGlobs });
  }
  return rows;
}

/**
 * Diff `docs/contributing/hooks-reference.md`'s documented `if:` globs
 * against what `.claude/settings.json` actually wires, in both directions —
 * a stale doc that still shows a bare matcher for a since-scoped guard is
 * exactly the drift a 2026-08-31 audit against Anthropic's AI-native SDLC
 * playbook found in 9 of the table's rows.
 *
 * @param {Array<{ event: string, hookName: string, ifGlobs: string[] }>} docRows
 * @param {Map<string, Set<string>>} settingsIfGlobs from {@link collectSettingsIfGlobs}
 * @returns {Array<{ event: string, hookName: string, documented: string[], actual: string[] }>}
 */
export function diffHooksReferenceIfGlobs(docRows, settingsIfGlobs) {
  const mismatches = [];
  for (const row of docRows) {
    const key = `${row.event}::${row.hookName}`;
    const actualSet = settingsIfGlobs.get(key) ?? new Set();
    const documented = [...new Set(row.ifGlobs)].sort();
    const actual = [...actualSet].sort();
    const same =
      documented.length === actual.length &&
      documented.every((g, i) => g === actual[i]);
    if (!same) {
      mismatches.push({
        event: row.event,
        hookName: row.hookName,
        documented,
        actual,
      });
    }
  }
  return mismatches;
}

// Main execution — only run when invoked directly, not when imported for testing.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = repoRoot(import.meta.url);
  const settingsPath = join(root, ".claude/settings.json");
  const hooksDir = join(root, ".claude/hooks");
  const { json } = parseJsonFlag();
  const reporter = createReporter(json);

  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  const onDiskHookNames = existsSync(hooksDir)
    ? readdirSync(hooksDir).filter((n) => n.endsWith(".mjs"))
    : [];

  const { errors, warnings, referenced } = validateHooksConfig(settings, {
    hookFileExists: (name) => existsSync(join(hooksDir, name)),
    onDiskHookNames,
  });

  // hooks-reference.md's documented `if:` globs vs. what's actually wired —
  // catches the doc-vs-settings drift a matcher-column edit can silently
  // leave behind (2026-08-31 audit).
  const hooksReferencePath = join(root, hooksReferenceRel);
  const hooksReferenceMd = existsSync(hooksReferencePath)
    ? readFileSync(hooksReferencePath, "utf8")
    : null;
  const docRows =
    hooksReferenceMd === null ? [] : parseHooksReferenceTable(hooksReferenceMd);
  const settingsIfGlobs = collectSettingsIfGlobs(settings);
  const ifGlobMismatches = diffHooksReferenceIfGlobs(docRows, settingsIfGlobs);

  if (hooksReferenceMd === null) {
    errors.push(`${hooksReferenceRel} does not exist — cannot verify parity.`);
  }
  for (const m of ifGlobMismatches) {
    errors.push(
      `${hooksReferenceRel}'s "${m.hookName}" row (${m.event}) documents ` +
        `if-scope [${m.documented.join(", ")}] but .claude/settings.json wires ` +
        `[${m.actual.join(", ")}] — update the Matcher cell to match.`,
    );
  }

  for (const warning of warnings) {
    reporter.warn(warning, { file: ".claude/settings.json" });
  }
  for (const error of errors) {
    reporter.error(error, { file: ".claude/settings.json" });
  }

  if (errors.length > 0) {
    if (!json) console.error(`\n✗  ${errors.length} hook wiring violation(s).`);
    reporter.finish();
    process.exit(1);
  }

  reporter.succeed(
    `${referenced.size} wired hooks valid: every referenced script exists; ` +
      `${docRows.length} hooks-reference.md row(s) match settings.json's if-scoping.`,
  );
  reporter.finish();
}
