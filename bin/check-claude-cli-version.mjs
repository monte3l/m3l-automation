#!/usr/bin/env node
/**
 * Makes `.claude-code-version` authoritative for the Claude Code CLI that
 * `.github/workflows/skill-evals.yml` installs to run `pnpm eval:skills`.
 *
 * Background — Scorecard alert #17 (`PinnedDependenciesID`, severity `error`,
 * security severity `medium`, "score is 9: npmCommand not pinned by hash"):
 * the workflow ran a bare `npm install -g @anthropic-ai/claude-code`, so every
 * scheduled run silently picked up whatever version had shipped that morning.
 * The eval suite's verdicts depend on CLI behaviour — the flag that decides
 * whether skills load at all is a CLI flag — so an unpinned CLI makes an eval
 * regression indistinguishable from a CLI change.
 *
 * This gate is the deliberate INVERSE of `bin/check-node-version.mjs`. That one
 * *forbids* a literal (`node-version: 24`) because `actions/setup-node` can read
 * a file, so the file must be the only authority. A `run:` step cannot read a
 * file without shelling out, and Scorecard parses the command TEXT — writing
 * `@$(cat .claude-code-version)` would almost certainly still read as unpinned
 * and leave the alert open. So here the literal is REQUIRED, and this gate is
 * what pins it: the workflow text and `.claude-code-version` must agree
 * exactly, which gives the version one source of truth without hiding it from
 * the scanner.
 *
 * Why a gate and not just a comment: Dependabot does not bump versions inside
 * workflow `run:` steps, so nothing else in the repo would ever notice this pin
 * going stale or the two sites drifting apart.
 *
 * Usage:
 *   node bin/check-claude-cli-version.mjs          # human-readable report
 *   node bin/check-claude-cli-version.mjs --json   # structured report
 *   pnpm check:claude-cli-version
 */
import process from "node:process";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, posix } from "node:path";
import { parseJsonFlag, createReporter, repoRoot } from "./lib/report.mjs";

export const VERSION_FILE = ".claude-code-version";
export const CLI_PACKAGE = "@anthropic-ai/claude-code";

/**
 * Parse `.claude-code-version` into an exact version.
 *
 * Deliberately stricter than {@link parseNodeVersionFile}'s counterpart: a
 * bare major would not pin anything, and a range (`^2.1.251`) is exactly the
 * "resolves to whatever shipped today" behaviour the alert is about. Only a
 * full `x.y.z` is accepted.
 *
 * @param {string} text raw file contents
 * @returns {{ version: string } | null} null when unparseable
 */
export function parseClaudeCodeVersionFile(text) {
  const raw = (text ?? "").trim();
  return /^\d+\.\d+\.\d+$/.test(raw) ? { version: raw } : null;
}

/**
 * Find every site in a workflow that installs the Claude Code CLI globally.
 *
 * @param {string} text YAML source
 * @returns {Array<{ line: number, spec: string | null, text: string }>} spec is
 *   the version after `@`, or null when the install is unpinned
 */
export function scanClaudeCliInstalls(text) {
  const found = [];
  (text ?? "").split("\n").forEach((line, index) => {
    if (!line.includes(CLI_PACKAGE)) return;
    if (!/npm\s+(?:install|i|add)\b/.test(line)) return;
    // `@scope/name` itself contains an `@`, so anchor on the package name and
    // read only what follows it.
    const after = line.slice(line.indexOf(CLI_PACKAGE) + CLI_PACKAGE.length);
    const pinned = /^@(\S+)/.exec(after);
    found.push({
      line: index + 1,
      spec: pinned === null ? null : pinned[1],
      text: line.trim(),
    });
  });
  return found;
}

/**
 * Assert every CLI install site names exactly the pinned version.
 *
 * Pure over already-read workflow text so it is testable without a
 * filesystem.
 *
 * @param {string} pinned the version from {@link parseClaudeCodeVersionFile}
 * @param {Array<{ file: string, text: string }>} files
 * @returns {string[]} error messages
 */
export function findClaudeCliVersionDrift(pinned, files) {
  const errors = [];
  let siteCount = 0;

  for (const { file, text } of files) {
    for (const { line, spec } of scanClaudeCliInstalls(text)) {
      siteCount += 1;

      if (spec === null) {
        errors.push(
          `${file}:${line} installs ${CLI_PACKAGE} without a version — this ` +
            `is Scorecard alert #17 (PinnedDependenciesID). Write ` +
            `"${CLI_PACKAGE}@${pinned}" and keep ${VERSION_FILE} in step.`,
        );
        continue;
      }

      // A shell substitution reads as unpinned to Scorecard even though it
      // resolves correctly at runtime, so it defeats the point of the pin.
      if (/[$`]/.test(spec)) {
        errors.push(
          `${file}:${line} derives ${CLI_PACKAGE}'s version from a shell ` +
            `substitution (${spec}) — Scorecard parses the command text, so ` +
            `this still reads as unpinned. Use the literal ` +
            `"${CLI_PACKAGE}@${pinned}"; this gate is what keeps it honest.`,
        );
        continue;
      }

      if (spec !== pinned) {
        errors.push(
          `${file}:${line} installs ${CLI_PACKAGE}@${spec} but ` +
            `${VERSION_FILE} pins ${pinned} — the two drifted. Update both ` +
            `together.`,
        );
      }
    }
  }

  // A pin nothing reads is a pin that is authoritative for nobody — the exact
  // failure ADR-0003's amendment caught with `.node-version`.
  if (siteCount === 0) {
    errors.push(
      `${VERSION_FILE} pins ${CLI_PACKAGE}@${pinned} but no workflow installs ` +
        `it, so the pin has no authority. Either restore the install step or ` +
        `delete ${VERSION_FILE} together with this gate.`,
    );
  }

  return errors;
}

/**
 * Every workflow file that could install the CLI.
 *
 * @param {string} root repo root
 * @returns {string[]} repo-relative, POSIX-separated paths
 */
export function collectWorkflowFiles(root) {
  const dir = join(root, ".github/workflows");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => posix.join(".github/workflows", name))
    .sort();
}

// Main execution — only run when invoked directly, not when imported for testing.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = repoRoot(import.meta.url);
  const { json } = parseJsonFlag();
  const reporter = createReporter(json);

  const pinPath = join(root, VERSION_FILE);
  const pin = existsSync(pinPath)
    ? parseClaudeCodeVersionFile(readFileSync(pinPath, "utf8"))
    : null;

  if (pin === null) {
    reporter.error(
      existsSync(pinPath)
        ? `${VERSION_FILE} must contain an exact version (e.g. "2.1.251") — ` +
            `a range or a bare major pins nothing.`
        : `${VERSION_FILE} is missing — it is the single authority for the ` +
            `Claude Code CLI the skill-eval workflow installs.`,
      { file: VERSION_FILE },
    );
    reporter.finish({ pinned: null });
    process.exit(1);
  }

  const workflowPaths = collectWorkflowFiles(root);
  const workflows = workflowPaths.map((file) => ({
    file,
    text: readFileSync(join(root, file), "utf8"),
  }));

  const errors = findClaudeCliVersionDrift(pin.version, workflows);
  for (const error of errors) reporter.error(error);

  const extras = { pinned: pin.version, workflowCount: workflows.length };

  if (errors.length > 0) {
    if (!json) {
      console.error(`\n✗  ${errors.length} Claude Code CLI pin violation(s).`);
    }
    reporter.finish(extras);
    process.exit(1);
  }

  reporter.succeed(
    `${VERSION_FILE} (${CLI_PACKAGE}@${pin.version}) is authoritative across ` +
      `${workflows.length} workflow file(s).`,
  );
  reporter.finish(extras);
}
