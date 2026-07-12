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
import { dirname, join, basename } from "node:path";

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
 * @param {{ hooks?: Record<string, Array<{ hooks?: Array<{ command?: string, timeout?: number }> }>> }} settings
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

    for (const entry of entries) {
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

// Main execution — only run when invoked directly, not when imported for testing.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const settingsPath = join(root, ".claude/settings.json");
  const hooksDir = join(root, ".claude/hooks");

  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  const onDiskHookNames = existsSync(hooksDir)
    ? readdirSync(hooksDir).filter((n) => n.endsWith(".mjs"))
    : [];

  const { errors, warnings, referenced } = validateHooksConfig(settings, {
    hookFileExists: (name) => existsSync(join(hooksDir, name)),
    onDiskHookNames,
  });

  for (const warning of warnings) console.warn(`⚠  ${warning}`);
  for (const error of errors) console.error(`✗  ${error}`);

  if (errors.length > 0) {
    console.error(`\n✗  ${errors.length} hook wiring violation(s).`);
    process.exit(1);
  }

  console.log(
    `✓  ${referenced.size} wired hooks valid: every referenced script exists.`,
  );
}
