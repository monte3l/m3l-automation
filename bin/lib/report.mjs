// Shared structured-output support for the agent-invoked bin/ scripts
// (ADR-0030). A script constructs one reporter, routes every message through
// it, and calls finish() last. In human mode (default) the reporter prints
// exactly the ✗/⚠/✓/Updated: lines the scripts always printed; with --json it
// stays silent and finish() emits ONE JSON object on stdout instead, so agents
// parse a stable shape rather than prose.
//
// Deliberately NOT owned by the reporter: process exit codes. Some scripts
// exit 1 on any error (check-*), others report errors yet still exit 0
// (gen-doc-counts skips unreadable files) — that behavior predates --json and
// must not change. Scripts keep their own exit logic; `report.ok` simply
// reflects whether error() was ever called.
import process from "node:process";

/**
 * Detect and strip the `--json` flag. Returns the remaining args so scripts
 * with positional/other flags (`--update`, `--affected`, slugs) parse what is
 * left without special-casing.
 *
 * @param {string[]} [argv] defaults to process.argv.slice(2)
 * @returns {{ json: boolean, argv: string[] }}
 */
export function parseJsonFlag(argv = process.argv.slice(2)) {
  const json = argv.includes("--json");
  return { json, argv: argv.filter((a) => a !== "--json") };
}

/**
 * Create a reporter. All message methods are no-ops on stdout/stderr in JSON
 * mode; they only accumulate. `info()` lines are human-only progress output
 * and never appear in the JSON payload.
 *
 * @param {boolean} json
 */
export function createReporter(json) {
  const report = {
    ok: true,
    summary: "",
    errors: [],
    warnings: [],
    updated: [],
    created: [],
    removed: [],
  };

  return {
    /** @param {string} message printed as `✗  <message>` on stderr in human mode */
    error(message) {
      report.ok = false;
      report.errors.push(message);
      if (!json) console.error(`✗  ${message}`);
    },

    /** @param {string} message printed as `⚠  <message>` on stderr in human mode */
    warn(message) {
      report.warnings.push(message);
      if (!json) console.error(`⚠  ${message}`);
    },

    /**
     * Record a file the script wrote, created, or removed.
     *
     * @param {"updated" | "created" | "removed"} kind
     * @param {string} file repo-relative path
     * @param {string} [note] human-mode suffix, e.g. "(implemented-list block)"
     */
    change(kind, file, note) {
      report[kind].push(file);
      if (!json) {
        const label = kind.charAt(0).toUpperCase() + kind.slice(1);
        console.log(`${label}: ${file}${note ? ` ${note}` : ""}`);
      }
    },

    /** @param {string} message human-only progress line; never in the JSON payload */
    info(message) {
      if (!json) console.log(message);
    },

    /** @param {string} message printed as `✓  <message>`; becomes report.summary */
    succeed(message) {
      report.summary = message;
      if (!json) console.log(`✓  ${message}`);
    },

    /**
     * Emit the JSON payload (JSON mode only) and hand the merged report back
     * so the script applies its own exit-code policy.
     *
     * @param {Record<string, unknown>} [extra] structured script-specific
     *   fields (e.g. derived counts) merged into the payload — must not
     *   collide with the base keys; a colliding key throws a `TypeError`
     *   naming the offending key
     * @returns {Record<string, unknown>} the base report merged with `extra`
     *   — the same object emitted as JSON in JSON mode
     */
    finish(extra = {}) {
      for (const key of Object.keys(extra)) {
        if (Object.hasOwn(report, key)) {
          throw new TypeError(
            `report.mjs finish(): extra field "${key}" collides with a base report key`,
          );
        }
      }
      const payload = { ...report, ...extra };
      if (json) console.log(JSON.stringify(payload));
      return payload;
    },
  };
}
