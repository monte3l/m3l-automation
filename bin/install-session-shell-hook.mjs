#!/usr/bin/env node
// ADR-0088's optional, opt-in shell-integration recipe: appends a `claude`
// shell function to the caller's shell rc file that delegates to
// `pnpm session:launch` when one is available, no explicit naming/resume
// flag is already present, and the current branch is `feat/<slug>` or
// `fix/<slug>` (the only shape `session:launch` can derive a name from,
// without a `--kind`) — falling through to the real `claude` binary
// otherwise. Never wired into `prepare` — this mutates a file OUTSIDE the
// repo (the user's home directory), so it stays a deliberate, separate
// command the user runs once.
//
// Idempotent: a marker-comment pair guards re-runs, mirroring
// bin/install-merge-drivers.mjs's idempotency contract for the shared
// `.git/config` — running twice with `--write` produces no duplicate block.
//
// Defaults to a dry run (prints what would change, writes nothing);
// `--write` is required to actually mutate the file. `--rc-path <path>`
// overrides the detected target — the seam that makes this testable without
// touching a real home-directory dotfile.
//
// Usage:
//   node bin/install-session-shell-hook.mjs                # dry run
//   node bin/install-session-shell-hook.mjs --write         # install
//   node bin/install-session-shell-hook.mjs --rc-path <p> --write
import process from "node:process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonFlag, createReporter } from "./lib/report.mjs";
import { BRANCH_KINDS } from "./lib/session-name.mjs";

export const MARKER_BEGIN = "# >>> m3l-automation session:launch hook >>>";
export const MARKER_END = "# <<< m3l-automation session:launch hook <<<";

/**
 * The shell function block, wrapped in its marker comments. Kept as a single
 * exported constant so the installer and its tests read the exact same
 * text — nothing here is templated per-install.
 *
 * @returns {string}
 */
export function buildShellFunctionBlock() {
  // Derived from BRANCH_KINDS, not a hardcoded "(feat|fix)" literal — this
  // exact bug class (the shell check silently drifting out of sync with
  // bin/lib/session-name.mjs's own branch-derivable kinds) has already
  // recurred twice on this file.
  const kindAlternation = BRANCH_KINDS.join("|");
  return [
    MARKER_BEGIN,
    "# ADR-0088: shadows `claude` so it launches already named, when a",
    "# pnpm session:launch script is available and no explicit naming/resume",
    "# flag is already present. Bypass per-invocation with",
    "# CLAUDE_SESSION_LAUNCH_DISABLE=1; uninstall by deleting this block.",
    "# Only checks the current directory for package.json — invoking `claude`",
    "# from a subdirectory of a session:launch-enabled repo falls through to",
    "# the real binary; `cd` to the repo root first. Also requires a",
    "# feat/<slug> or fix/<slug> branch — session:launch has no way to derive",
    "# a name on any other branch and exits without launching, so this must",
    "# match its own derivable-branch check (bin/lib/session-name.mjs) or a",
    "# bare `claude` on e.g. `main` would hard-fail instead of falling through.",
    "claude() {",
    '  if [ -z "${CLAUDE_SESSION_LAUNCH_DISABLE:-}" ] \\',
    "     && ! printf '%s\\n' \"$@\" | grep -qE '^(-n|--name(=.+)?|--resume(=.+)?|--continue|-p)$' \\",
    "     && [ -f package.json ] \\",
    "     && grep -q '\"session:launch\"' package.json 2>/dev/null \\",
    `     && git rev-parse --abbrev-ref HEAD 2>/dev/null | grep -qE '^(${kindAlternation})/[a-z0-9]+(-[a-z0-9]+)*$'; then`,
    '    pnpm session:launch -- "$@"',
    "  else",
    '    command claude "$@"',
    "  fi",
    "}",
    MARKER_END,
  ].join("\n");
}

/**
 * Detects the shell rc file to target from `$SHELL`, falling back through
 * the common candidates when the shell can't be identified. Pure function
 * of `env`/`home` so tests never touch a real home directory.
 *
 * @param {{ SHELL?: string }} env
 * @param {string} home
 * @returns {string}
 */
export function detectRcPath(env, home) {
  const shell = env.SHELL ?? "";
  if (shell.endsWith("/zsh")) return join(home, ".zshrc");
  if (shell.endsWith("/bash")) return join(home, ".bashrc");
  return join(home, ".profile");
}

/**
 * Computes the install plan against the rc file's current content (or `null`
 * if the file doesn't exist yet, treated as empty) — pure, no I/O, so the
 * idempotency and content-shape logic is exercised without a filesystem.
 *
 * @param {string | null} currentContent
 * @returns {{ alreadyInstalled: boolean, newContent: string }}
 */
export function computeInstallPlan(currentContent) {
  const content = currentContent ?? "";
  if (content.includes(MARKER_BEGIN)) {
    return { alreadyInstalled: true, newContent: content };
  }
  const separator = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
  const block = buildShellFunctionBlock();
  const newContent =
    content.length > 0 ? `${content}${separator}\n${block}\n` : `${block}\n`;
  return { alreadyInstalled: false, newContent };
}

// Guarded so importing this module for its pure functions (as the test file
// does) never executes the CLI body — without this, every test run would
// read (and, depending on argv, could write) the real user's shell rc file.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { json, argv } = parseJsonFlag();
  const reporter = createReporter(json);

  const write = argv.includes("--write");
  const rcPathIndex = argv.indexOf("--rc-path");
  let rcPathOverride = null;
  if (rcPathIndex !== -1) {
    const value = argv[rcPathIndex + 1];
    if (value === undefined || value.startsWith("--") || value.length === 0) {
      reporter.error(
        "install-session-shell-hook: `--rc-path` requires a non-empty path argument.\n" +
          "   Usage: pnpm session:install-shell-hook -- --rc-path <path> [--write]",
      );
      reporter.finish();
      process.exit(1);
    }
    rcPathOverride = value;
  }

  const rcPath = rcPathOverride ?? detectRcPath(process.env, homedir());
  const currentContent = existsSync(rcPath)
    ? readFileSync(rcPath, "utf8")
    : null;
  const { alreadyInstalled, newContent } = computeInstallPlan(currentContent);

  if (alreadyInstalled) {
    reporter.succeed(
      `${rcPath} already has the session:launch hook installed — nothing to do.`,
    );
    reporter.finish({ rcPath, alreadyInstalled: true, wrote: false });
  } else if (write) {
    writeFileSync(rcPath, newContent, "utf8");
    reporter.succeed(`Installed the session:launch hook into ${rcPath}.`);
    reporter.info(
      "   Restart your shell (or `source` the file) for it to take effect.",
    );
    reporter.finish({ rcPath, alreadyInstalled: false, wrote: true });
  } else {
    reporter.info(`Dry run — would append this block to ${rcPath}:\n`);
    reporter.info(buildShellFunctionBlock());
    reporter.info(`\nRe-run with --write to actually install it.`);
    reporter.finish({ rcPath, alreadyInstalled: false, wrote: false });
  }
}
