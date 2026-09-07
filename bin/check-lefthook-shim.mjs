#!/usr/bin/env node
// Warns (non-blocking) when an installed lefthook git-hook shim fails OPEN:
// its final unresolved-binary branch echoes "Can't find lefthook in PATH"
// with no `exit 1`, so a push/commit on a machine where no lefthook binary
// resolves silently exits 0 with every gate skipped (H14, issue #1097).
//
// This is detection only — the fix is `lefthook.yml`'s
// `assert_lefthook_installed: true` (which makes every future `lefthook
// install` regenerate a fail-closed shim) plus re-running:
//   pnpm exec lefthook install
// A gate wired only into the `pre-push` chain cannot itself catch the
// defect it warns about — if the shim fails open, `pre-push` never runs, so
// this gate never runs either. It catches the PRECURSOR: a stale shim that
// still resolves lefthook today but predates the assert config, so the next
// person to lose their lefthook binary would silently skip every gate. The
// case that matters in the moment — an agent-driven `git push` about to hit
// a fail-open shim right now — is caught by
// `.claude/hooks/guard-lefthook-shim.mjs` instead, which blocks.
//
// Modelled on bin/check-staleness.mjs (H2/#1044): same reporter, same
// always-exit-0 shape. The shim is untracked and per-machine, so this gate
// can never be authoritative in CI — CI's ephemeral checkout always runs
// `pnpm install` fresh (assert_lefthook_installed already fixed), so it
// naturally finds nothing to warn about.
//
// Usage:
//   node bin/check-lefthook-shim.mjs
//   node bin/check-lefthook-shim.mjs --json    # ADR-0030 structured report
//   pnpm check:lefthook-shim
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createReporter, parseJsonFlag, repoRoot } from "./lib/report.mjs";
import { shimsDir, scanShims } from "./lib/lefthook-shim.mjs";

const root = repoRoot(import.meta.url);

/**
 * Run the scan against injected seams and report findings. Returns the
 * outcome rather than exiting, so tests can assert on it directly —
 * `ok: false` here does NOT mean a non-zero exit; the CLI guard below always
 * exits 0 (advisory only, per the header comment).
 *
 * @param {object} deps
 * @param {(args: string[]) => string} deps.runGit
 * @param {(dir: string) => string[]} deps.readdir
 * @param {(path: string) => string} deps.readFile
 * @param {ReturnType<typeof createReporter>} deps.reporter
 * @returns {{ ok: boolean, shims: ReturnType<typeof scanShims> }}
 */
export function runLefthookShimCheck({ runGit, readdir, readFile, reporter }) {
  let commonDir;
  try {
    commonDir = runGit([
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]).trim();
  } catch (cause) {
    reporter.warn(
      "check:lefthook-shim: could not resolve the git common dir — " +
        `skipping the shim scan. (${
          cause instanceof Error ? cause.message : String(cause)
        })`,
    );
    reporter.finish({ shims: [] });
    return { ok: true, shims: [] };
  }

  const shims = scanShims(shimsDir(commonDir), { readdir, readFile });
  const failOpen = shims.filter((s) => s.failsOpen);

  for (const { hookName } of failOpen) {
    reporter.warn(
      `The installed \`${hookName}\` git hook shim fails OPEN: it falls ` +
        "through with no `exit 1` when no lefthook binary resolves, so a " +
        "run where lefthook can't be found silently skips every check. " +
        "Re-run `pnpm exec lefthook install` to regenerate it — " +
        "`assert_lefthook_installed: true` in lefthook.yml now makes the " +
        "regenerated shim fail closed instead.",
    );
  }

  if (failOpen.length === 0) {
    reporter.succeed(
      shims.length > 0
        ? `${shims.length} installed lefthook shim(s) all fail closed.`
        : "No installed lefthook shims found (nothing to check).",
    );
  }

  reporter.finish({ shims });
  return { ok: failOpen.length === 0, shims };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { json } = parseJsonFlag();
  const reporter = createReporter(json);

  runLefthookShimCheck({
    runGit: (args) =>
      execFileSync("git", args, { encoding: "utf8", cwd: root }),
    readdir: (dir) => readdirSync(dir),
    readFile: (path) => readFileSync(path, "utf8"),
    reporter,
  });

  // Advisory only — never blocks a commit or push. See the header comment.
  process.exit(0);
}
