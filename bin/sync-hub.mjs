#!/usr/bin/env node
// Umbrella runner for the ADR-0032 hub-sync write-back: runs
// bin/sync-hub-issues.mjs then bin/sync-hub-projects.mjs, in that order,
// forwarding every CLI flag (--apply, --init, --json, ...) verbatim to
// BOTH phases.
//
// Why this file exists: pnpm only appends passthrough args after the LAST
// command in a package.json `&&` chain, so a bare
// `"sync:hub": "pnpm sync:hub-issues && pnpm sync:hub-projects"` script
// would let `pnpm sync:hub --apply` silently leave the issues phase
// dry-run while the projects phase applied — exactly the kind of
// half-mutated, order-dependent state this sync exists to avoid. Spawning
// both phase scripts directly with the identical argv guarantees both see
// the same flags.
//
// Dry-run by default (inherited from both phases): with no flags, this
// prints both phases' plans and makes no mutating `gh` call. Pass --apply
// to execute both.
//
// Maintainer-run, locally, only — never wired into CI. The Actions
// GITHUB_TOKEN cannot write GitHub Projects v2 (see the ADR-0032 update
// note and the header comments on the two phase scripts), so the whole
// hub-sync write-back stays local, invoked by a human with an
// authenticated `gh`.
//
// Usage:
//   node bin/sync-hub.mjs             # dry run, both phases
//   node bin/sync-hub.mjs --init      # one-time board setup (projects phase only reads this)
//   node bin/sync-hub.mjs --apply     # apply, both phases
//   node bin/sync-hub.mjs --json      # ADR-0030 structured report, both phases
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Issues before projects: the projects board is a view over the issues
// bin/sync-hub-issues.mjs owns, so it must run first for the projects
// phase to see up-to-date issue state on the same invocation.
const PHASES = ["sync-hub-issues.mjs", "sync-hub-projects.mjs"];

/**
 * Spawn one phase script with `args` forwarded verbatim, inheriting stdio
 * so its human- or JSON-mode output streams straight through. Returns the
 * child's exit code (0 on success) instead of throwing, so {@link runPhases}
 * can stop at the first failure and mirror its exact exit code.
 *
 * @param {string} script basename under bin/
 * @param {string[]} args
 * @returns {number}
 */
function defaultSpawn(script, args) {
  try {
    execFileSync(process.execPath, [join(root, "bin", script), ...args], {
      cwd: root,
      stdio: "inherit",
    });
    return 0;
  } catch (cause) {
    if (
      cause &&
      typeof cause === "object" &&
      "status" in cause &&
      typeof cause.status === "number"
    ) {
      return cause.status;
    }
    return 1;
  }
}

/**
 * Run every phase in {@link PHASES}, forwarding `argv` verbatim to each,
 * stopping at (and returning) the first non-zero exit code. `spawn` is
 * injected so this loop stays testable without spawning real processes.
 *
 * @param {string[]} argv every CLI flag/arg this invocation received
 * @param {(script: string, args: string[]) => number} [spawn]
 * @returns {number} the process exit code: 0 if every phase succeeded,
 *   otherwise the first failing phase's exit code
 * @example
 * ```js
 * import { runPhases } from "./sync-hub.mjs";
 *
 * runPhases(["--json"], () => 0); // 0 — both phases stubbed to succeed
 * ```
 */
export function runPhases(argv, spawn = defaultSpawn) {
  for (const script of PHASES) {
    const code = spawn(script, argv);
    if (code !== 0) return code;
  }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(runPhases(process.argv.slice(2)));
}
