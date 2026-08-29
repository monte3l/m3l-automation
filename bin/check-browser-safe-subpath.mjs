#!/usr/bin/env node
/**
 * Machine-enforced backstop for the ADR-0004 Update's narrow exception to
 * the three-entry `exports` map: a fourth+ subpath is permitted only when
 * the submodule it exposes is provably free of `node:` builtins and
 * third-party bare specifiers, so a browser bundler never needs to
 * externalize anything to resolve it. Without this gate, the invariant is
 * just a comment someone could invalidate by adding one `node:crypto`
 * import three hops deep in the graph — exactly the class of drift
 * `check:api` and `check:exports` don't catch (they validate the map's
 * *shape*, not what its entries transitively import).
 *
 * Walks each registered subpath's entry file's TypeScript *source* (not
 * built `dist/`), so this runs in the pre-build CI lane alongside
 * `check:api` rather than after `pnpm build`.
 *
 * Usage:
 *   node bin/check-browser-safe-subpath.mjs [--json]
 *
 * Exit codes:
 *   0  Every registered subpath's import graph is browser-safe.
 *   1  At least one subpath's graph imports a `node:` builtin or a bare
 *      third-party specifier.
 */
import process from "node:process";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import { parseJsonFlag, createReporter, repoRoot } from "./lib/report.mjs";
import { walkImportGraph } from "./lib/browser-safe-subpath.mjs";

const root = repoRoot(import.meta.url);

/**
 * Every `exports` entry the ADR-0004 Update's browser-safety exception
 * covers, keyed by its subpath and the repo-relative entry file its
 * transitive import graph is walked from. Add an entry here alongside any
 * future exports-map addition made under that exception.
 */
export const BROWSER_SAFE_SUBPATHS = [
  {
    subpath: "./core/errors",
    entry: "packages/m3l-common/src/core/errors/index.ts",
  },
];

/**
 * Checks every registered subpath and reports each violation found.
 *
 * @param {{ error(message: string, loc?: { file?: string }): void, succeed(message: string): void }} reporter
 * @returns {boolean} true when every subpath's graph is browser-safe
 */
export function runCheck(reporter) {
  let ok = true;
  for (const { subpath, entry } of BROWSER_SAFE_SUBPATHS) {
    const { violations } = walkImportGraph(join(root, entry));
    if (violations.length === 0) {
      reporter.succeed(`${subpath} import graph is browser-safe (${entry}).`);
      continue;
    }
    ok = false;
    for (const violation of violations) {
      const file = relative(root, violation.file);
      reporter.error(
        `${subpath} is exported to browser-target consumers but its import ` +
          `graph reaches non-relative specifier "${violation.specifier}" ` +
          `from ${file} — a browser bundler cannot resolve a node:/bare ` +
          `specifier without externalizing it. See docs/adr/0004-exports-map-contract.md's ` +
          `Update for the exception this subpath must keep satisfying.`,
        { file },
      );
    }
  }
  return ok;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { json } = parseJsonFlag();
  const reporter = createReporter(json);
  const ok = runCheck(reporter);
  reporter.finish();
  process.exit(ok ? 0 : 1);
}
