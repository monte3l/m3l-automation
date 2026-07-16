#!/usr/bin/env node
// Creates AND provisions a manual sibling-directory worktree in one step — the
// symmetric partner of `worktree-remove.mjs`. Wraps the two-command manual flow
// (git worktree add + pnpm worktree:setup) so create/teardown stay symmetric.
//
//   node bin/worktree-new.mjs <slug>          # branch feat/<slug>
//   node bin/worktree-new.mjs <slug> --fix    # branch fix/<slug>
//
// The worktree is created at ../m3l-automation-<slug>, branched fresh from
// origin/main (falling back to local main) per ADR-0013's worktree.baseRef,
// then provisioned via worktree-setup.mjs (installs deps, copies literal
// .worktreeinclude files).
import process from "node:process";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { parseJsonFlag, createReporter } from "./lib/report.mjs";

const { json, argv } = parseJsonFlag();
const reporter = createReporter(json);

const args = argv;
const flags = new Set(args.filter((a) => a.startsWith("--")));
const positionals = args.filter((a) => !a.startsWith("--"));
const slug = positionals[0];

if (!slug) {
  reporter.error(
    "worktree:new: missing <slug>.\n" +
      "   Usage: pnpm worktree:new <slug> [--fix]",
  );
  reporter.finish();
  process.exit(1);
}
if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
  reporter.error(
    `worktree:new: invalid slug "${slug}". Use kebab-case ` +
      "(lowercase letters, digits, single hyphens), e.g. `core-json`.",
  );
  reporter.finish();
  process.exit(1);
}

const prefix = flags.has("--fix") ? "fix" : "feat";
const branch = `${prefix}/${slug}`;

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

// Locate the main checkout (parent of the shared .git common dir) so the sibling
// directory sits alongside it regardless of where this runs.
const gitCommonDir = git([
  "rev-parse",
  "--path-format=absolute",
  "--git-common-dir",
]);
const mainCheckout = dirname(gitCommonDir);
const worktreePath = resolve(mainCheckout, "..", `m3l-automation-${slug}`);

// Fresh branch point: origin/main preferred, local main as fallback.
const startPoint = refExists("origin/main")
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

reporter.info(
  `→  Creating worktree ${worktreePath} on ${branch} (from ${startPoint}) ...`,
);
try {
  git(["worktree", "add", worktreePath, "-b", branch, startPoint], {
    // In JSON mode, an inherited child stdout would pollute stdout with prose
    // before the single JSON line finish() emits; human mode keeps "inherit"
    // so the operator sees git's own progress output live. stderr stays
    // inherited even in JSON mode — it never pollutes the stdout JSON
    // contract, and a failing child's diagnostics must still surface.
    stdio: json ? ["ignore", "ignore", "inherit"] : "inherit",
  });
} catch {
  reporter.error(
    `worktree:new: \`git worktree add\` failed. The branch \`${branch}\` or ` +
      `directory may already exist. Inspect \`git worktree list\` / ` +
      "`git branch --list` and retry with a different slug.",
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
  reporter.finish({ worktreePath, branch });
  process.exit(1);
}

reporter.info("");
reporter.succeed(`Worktree ready at ${worktreePath} on ${branch}.`);
reporter.info(
  `   Next: \`cd ${join("..", `m3l-automation-${slug}`)}\`, make changes, ` +
    "commit, and `git push -u origin HEAD`.\n" +
    `   Teardown when done: \`pnpm worktree:remove ${slug}\`.`,
);
reporter.finish({ worktreePath, branch });
