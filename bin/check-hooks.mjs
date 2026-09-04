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
// reference: https://code.claude.com/docs/en/hooks (re-verified 2026-09-04,
// widened from 17 to the documented ~32 — the prior, narrower set made
// wiring any of the missing events a false-positive gate failure; see
// docs/research/harness-refresh.md outstanding drift #5).
export const KNOWN_EVENTS = new Set([
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PostToolBatch",
  "UserPromptSubmit",
  "UserPromptExpansion",
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
  "MessageDisplay",
  "TaskCreated",
  "TaskCompleted",
  "TeammateIdle",
  "InstructionsLoaded",
  "ConfigChange",
  "CwdChanged",
  "DirectoryAdded",
  "FileChanged",
  "WorktreeCreate",
  "WorktreeRemove",
  "PreModelSwitch",
  "PostModelSwitch",
  "Elicitation",
  "ElicitationResult",
]);

// Events whose `matcher` field is a documented, closed set of values rather
// than a free-form tool-name pattern (PreToolUse/PostToolUse's `matcher` is
// the latter — a tool name or `Tool1|Tool2` alternation — and has no fixed
// enum to validate against). A typo here (e.g. `matcher: "compct"`) would
// otherwise silently no-op the entry with no gate catching it — the exact
// failure mode that can disable post-compaction re-injection
// (`.claude/hooks/reinject-compact-handoff.mjs`, `SessionStart` + `matcher:
// "compact"`). Source: https://code.claude.com/docs/en/hooks (re-verified
// 2026-09-04 — widened to cover SessionEnd and DirectoryAdded, the same
// silent-no-op risk this set already guards against for
// SessionStart/PreCompact/PostCompact).
//
// Deliberately NOT added here, despite being closed-enum candidates:
//   - WorktreeCreate/WorktreeRemove — the docs state plainly "no matcher
//     support... always fires on every occurrence" (confirmed by two
//     independent direct fetches this session); there is no enum to
//     validate against.
//   - Notification — three independent fetches of this page (one this
//     session, two in a prior sweep) returned mutually inconsistent
//     matcher-value lists for it; a raw-cell fetch returned the description
//     "notification type" rather than an enum. This page is already flagged
//     (docs/research/harness-refresh.md) as prone to fetch-summarizer
//     instability — a prior sweep saw the same effect on SessionStart's
//     input field name. Encoding an unverified enum into a blocking gate
//     risks false-positive rejection of a legitimate matcher — safer to
//     leave it unchecked (falls through to the free-form path, same as
//     PreToolUse/PostToolUse) until a raw-HTML fetch confirms the exact
//     values.
export const KNOWN_MATCHERS = new Map([
  ["SessionStart", new Set(["startup", "resume", "clear", "compact", "fork"])],
  [
    "SessionEnd",
    new Set(["clear", "resume", "logout", "prompt_input_exit", "other"]),
  ],
  ["PreCompact", new Set(["manual", "auto"])],
  ["PostCompact", new Set(["manual", "auto"])],
  ["DirectoryAdded", new Set(["slash_command", "register_repo_root"])],
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
 * @param {{ hooks?: Record<string, Array<{ matcher?: string, hooks?: Array<{ command?: string, timeout?: number }> }>>, statusLine?: { command?: string }, subagentStatusLine?: { command?: string } }} settings
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

  // `statusLine` is a separate top-level settings key, not a lifecycle
  // event under `hooks` — without this, a valid statusLine script would
  // false-positive as a "dead hook?" below.
  const statusLineCommand = settings.statusLine?.command;
  if (typeof statusLineCommand === "string") {
    const name = extractHookScriptName(statusLineCommand);
    if (name !== null) {
      referenced.add(name);
      if (!hookFileExists(name)) {
        errors.push(
          `.claude/settings.json's "statusLine" wires "${name}" but ` +
            `.claude/hooks/${name} does not exist.`,
        );
      }
    }
  }

  // `subagentStatusLine` is the sibling top-level settings key rendering a
  // per-subagent row body (code.claude.com/docs/en/statusline#subagent-status-lines)
  // — same false-positive risk as `statusLine` above: without this, a valid
  // subagentStatusLine script would wrongly warn as a "dead hook?" below.
  const subagentStatusLineCommand = settings.subagentStatusLine?.command;
  if (typeof subagentStatusLineCommand === "string") {
    const name = extractHookScriptName(subagentStatusLineCommand);
    if (name !== null) {
      referenced.add(name);
      if (!hookFileExists(name)) {
        errors.push(
          `.claude/settings.json's "subagentStatusLine" wires "${name}" but ` +
            `.claude/hooks/${name} does not exist.`,
        );
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
 * The two settings keys that wire a "statusline" command script —
 * `statusLine` (the main line) and `subagentStatusLine` (the per-subagent row
 * body). Both share the same `{ type, command, refreshInterval? }` shape
 * (code.claude.com/docs/en/statusline), and both scripts are bound by
 * ADR-0080's "no subprocess, no network" invariant.
 */
export const STATUSLINE_SETTINGS_KEYS = /** @type {const} */ ([
  "statusLine",
  "subagentStatusLine",
]);

/**
 * Validates the `type`/`refreshInterval` shape of the `statusLine` and
 * `subagentStatusLine` settings keys. A `type` other than `"command"`
 * silently disables the feature (Claude Code renders nothing rather than
 * erroring); a non-numeric or sub-1 `refreshInterval` is a documented-shape
 * violation with no other gate catching it.
 *
 * @param {Record<string, unknown>} settings
 * @returns {string[]} error messages, empty when both keys are absent or valid.
 */
export function validateStatuslineShape(settings) {
  const errors = [];
  for (const key of STATUSLINE_SETTINGS_KEYS) {
    const value = settings[key];
    if (typeof value !== "object" || value === null) continue;
    const config =
      /** @type {{ type?: unknown, refreshInterval?: unknown }} */ (value);
    if (config.type !== "command") {
      errors.push(
        `.claude/settings.json's "${key}.type" is ${JSON.stringify(config.type)} ` +
          `— must be the literal "command" (any other value silently disables it).`,
      );
    }
    if (
      config.refreshInterval !== undefined &&
      (typeof config.refreshInterval !== "number" ||
        !Number.isFinite(config.refreshInterval) ||
        config.refreshInterval < 1)
    ) {
      errors.push(
        `.claude/settings.json's "${key}.refreshInterval" is ` +
          `${JSON.stringify(config.refreshInterval)} — must be a number >= 1.`,
      );
    }
  }
  return errors;
}

/**
 * Source patterns that violate ADR-0080's "no subprocess, no network"
 * invariant for a statusline script — a subprocess spawn or a network call
 * inside a script that runs on every render (`statusLine`) or refresh
 * (`subagentStatusLine`) risks reintroducing the resource-pressure incident
 * ADR-0080 records. `node:https` is checked alongside `node:http` since both
 * serve the same "no network" invariant this scan exists to enforce.
 *
 * `spawn`/`exec*` require a preceding non-`.` boundary so a legitimate
 * `RegExp.prototype.exec(...)` / `.exec(...)` method call (both statusline
 * scripts use one to parse `.git/HEAD`) never false-positives — a bare
 * `exec(...)`/`spawn(...)` call, unlike a `.exec(...)` method call, can only
 * exist if the name was imported, which is exactly the risk this pattern
 * exists to catch.
 */
export const FORBIDDEN_STATUSLINE_PATTERNS = [
  { pattern: /\bnode:child_process\b/, label: "imports node:child_process" },
  { pattern: /(?<!\.)\bspawn\s*\(/, label: "calls spawn(...)" },
  {
    pattern: /(?<!\.)\bexec(?:Sync|File|FileSync)?\s*\(/,
    label: "calls exec*(...)",
  },
  { pattern: /\bfetch\s*\(/, label: "calls fetch(...)" },
  { pattern: /\bnode:https?\b/, label: "imports node:http(s)" },
];

/**
 * Scans one statusline script's source for a forbidden subprocess/network
 * pattern (ADR-0080).
 *
 * @param {string} scriptName e.g. "statusline-context-pressure.mjs"
 * @param {string} source the script's file content
 * @returns {string[]} error messages, empty when clean.
 */
export function scanStatuslineScriptForForbiddenPatterns(scriptName, source) {
  const errors = [];
  for (const { pattern, label } of FORBIDDEN_STATUSLINE_PATTERNS) {
    if (pattern.test(source)) {
      errors.push(
        `.claude/hooks/${scriptName} ${label} — violates ADR-0080's ` +
          `"no subprocess, no network" invariant for a statusline script.`,
      );
    }
  }
  return errors;
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

  // Hardening (ADR-0080): the statusLine/subagentStatusLine settings shape,
  // then a source scan of each wired script for a subprocess/network call.
  errors.push(...validateStatuslineShape(settings));
  for (const key of STATUSLINE_SETTINGS_KEYS) {
    const value = /** @type {Record<string, unknown> | undefined} */ (
      settings[key]
    );
    const command =
      typeof value === "object" && value !== null ? value.command : undefined;
    if (typeof command !== "string") continue;
    const name = extractHookScriptName(command);
    if (name === null) continue;
    const scriptPath = join(hooksDir, name);
    if (!existsSync(scriptPath)) continue; // already reported above
    const source = readFileSync(scriptPath, "utf8");
    errors.push(...scanStatuslineScriptForForbiddenPatterns(name, source));
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
