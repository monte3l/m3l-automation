#!/usr/bin/env node
// Creates AND provisions a manual sibling-directory worktree in one step — the
// symmetric partner of `worktree-remove.mjs`. Wraps the two-command manual flow
// (git worktree add + pnpm worktree:setup) so create/teardown stay symmetric.
//
//   node bin/worktree-new.mjs <slug>                # branch feat/<slug>
//   node bin/worktree-new.mjs <slug> --fix          # branch fix/<slug>
//   node bin/worktree-new.mjs <slug> --from <ref>   # detached HEAD at <ref>
//
// The worktree is created at ../m3l-automation-<slug>, branched fresh from
// origin/main (falling back to local main) per ADR-0013's worktree.baseRef,
// then provisioned via worktree-setup.mjs (installs deps, copies literal
// .worktreeinclude files). `--from <ref>` checks out an existing ref as a
// detached-HEAD worktree instead — for investigating/auditing a branch you
// don't intend to develop on — and is mutually exclusive with `--fix` since
// no new branch is created (ADR-0014 amendment).
//
// Argument parsing lives in `bin/lib/worktree-new.mjs` (pure, unit-tested);
// this file stays the thin shell wiring it to git and the reporter.
import process from "node:process";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { parseJsonFlag, createReporter } from "./lib/report.mjs";
import { parseWorktreeNewArgs, worktreeDirName } from "./lib/worktree-new.mjs";

const { json, argv } = parseJsonFlag();
const reporter = createReporter(json);

const parsed = parseWorktreeNewArgs(argv);
if (!parsed.ok) {
  reporter.error(parsed.error);
  reporter.finish();
  process.exit(1);
}
const { slug, kind, from } = parsed;
const branch = from === null ? `${kind}/${slug}` : null;

function git(gitArgs, opts = {}) {
  // With stdio: "inherit" execFileSync returns null (output not captured), so
  // guard the .trim() — callers that inherit don't need the return value.
  const out = execFileSync("git", gitArgs, { encoding: "utf8", ...opts });
  return typeof out === "string" ? out.trim() : "";
}

function refExists(ref) {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", ref], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

if (from !== null && !refExists(from)) {
  reporter.error(
    `worktree:new: ref "${from}" does not exist. Run \`git fetch\` if it's ` +
      "a remote branch that hasn't been fetched yet, or check the spelling.",
  );
  reporter.finish();
  process.exit(1);
}

// Locate the main checkout (parent of the shared .git common dir) so the sibling
// directory sits alongside it regardless of where this runs.
const gitCommonDir = git([
  "rev-parse",
  "--path-format=absolute",
  "--git-common-dir",
]);
const mainCheckout = dirname(gitCommonDir);
const worktreePath = resolve(mainCheckout, "..", worktreeDirName(slug));

let startPoint = null;
if (from === null) {
  // Fresh branch point: origin/main preferred, local main as fallback.
  startPoint = refExists("origin/main")
    ? "origin/main"
    : refExists("refs/heads/main")
      ? "main"
      : null;
  if (startPoint === null) {
    reporter.error(
      "worktree:new: no `origin/main` or local `main` to branch from. " +
        "Fetch or check out `main` first.",
    );
    reporter.finish();
    process.exit(1);
  }
}

reporter.info(
  from === null
    ? `→  Creating worktree ${worktreePath} on ${branch} (from ${startPoint}) ...`
    : `→  Creating worktree ${worktreePath} detached at ${from} ...`,
);
try {
  const addArgs =
    from === null
      ? [
          "worktree",
          "add",
          worktreePath,
          "-b",
          /** @type {string} */ (branch),
          startPoint,
        ]
      : ["worktree", "add", "--detach", worktreePath, from];
  git(addArgs, {
    // In JSON mode, an inherited child stdout would pollute stdout with prose
    // before the single JSON line finish() emits; human mode keeps "inherit"
    // so the operator sees git's own progress output live. stderr stays
    // inherited even in JSON mode — it never pollutes the stdout JSON
    // contract, and a failing child's diagnostics must still surface.
    stdio: json ? ["ignore", "ignore", "inherit"] : "inherit",
  });
} catch {
  reporter.error(
    from === null
      ? `worktree:new: \`git worktree add\` failed. The branch \`${branch}\` or ` +
          `directory may already exist. Inspect \`git worktree list\` / ` +
          "`git branch --list` and retry with a different slug."
      : `worktree:new: \`git worktree add --detach\` failed. The directory ` +
          `may already exist. Inspect \`git worktree list\` and retry with a ` +
          "different slug.",
  );
  reporter.finish();
  process.exit(1);
}

reporter.info(`→  Provisioning ${worktreePath} ...`);
const setupScript = fileURLToPath(
  new URL("./worktree-setup.mjs", import.meta.url),
);
try {
  execFileSync("node", [setupScript], {
    // See the rationale above: stdout is suppressed in JSON mode, stderr
    // stays inherited so a failing setup's diagnostics are never swallowed.
    stdio: json ? ["ignore", "ignore", "inherit"] : "inherit",
    cwd: worktreePath,
  });
} catch {
  reporter.error(
    "worktree:new: the worktree was created but provisioning failed. " +
      `Fix the error above, then re-run \`pnpm worktree:setup\` from inside ` +
      `${worktreePath}.`,
  );
  reporter.finish({ worktreePath, branch, ref: from, detached: from !== null });
  process.exit(1);
}

reporter.info("");
reporter.succeed(
  from === null
    ? `Worktree ready at ${worktreePath} on ${branch}.`
    : `Worktree ready at ${worktreePath}, detached at ${from}.`,
);
reporter.info(
  from === null
    ? `   Next: \`cd ${join("..", worktreeDirName(slug))}\`, then \`pnpm ` +
        `session:launch\` to open a Claude Code session already named ` +
        `\`${branch?.replace("/", "-")}\` (ADR-0088) before you make changes, ` +
        "commit, and `git push -u origin HEAD`.\n" +
        `   Teardown when done: \`pnpm worktree:remove ${slug}\`.`
    : `   Next: \`cd ${join("..", worktreeDirName(slug))}\` to investigate. ` +
        "To develop from here, `git switch -c <name>` first.\n" +
        `   Teardown when done: \`pnpm worktree:remove ${slug}\`.`,
);
reporter.finish({ worktreePath, branch, ref: from, detached: from !== null });
