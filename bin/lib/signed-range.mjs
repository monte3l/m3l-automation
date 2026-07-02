/**
 * Shared git-signature helpers for the push-time guards.
 *
 * Two consumers rely on this so they agree on what "signed" means:
 *   - `.claude/hooks/guard-git-push-signed.mjs` — the agent-side PreToolUse hook
 *     that inspects a `git push` Bash command before it runs.
 *   - `bin/verify-signed-range.mjs` — the lefthook `pre-push` backstop that runs
 *     for every local push (agent or human).
 *
 * The authoritative enforcement is GitHub branch protection's "Require signed
 * commits" (see docs/contributing/branch-protection.md); these are the in-repo
 * early/local layers. Kept pattern-parallel with bin/lib/worktree-include.mjs:
 * a shared, unit-testable module rather than duplicated logic.
 */
import { execFileSync } from "node:child_process";

/**
 * Signature codes that `git`'s `%G?` placeholder considers acceptable:
 *   G = a good (validly verified) signature,
 *   U = a good signature with unknown validity (signer key not in the local
 *       trust store) — still cryptographically valid, so we accept it.
 * Everything else — N (none), B (bad), E (cannot check), X/Y/R (expired/revoked)
 * — is treated as unsigned/unverified.
 */
export const VALID_SIGNATURE_CODES = new Set(["G", "U"]);

/**
 * Default git runner; returns stdout as a string. Injectable for tests.
 * stderr is discarded so the expected failures while probing candidate bases
 * (e.g. "no upstream configured") don't leak into the hook's output — the
 * throw is what callers act on.
 */
function defaultRunGit(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

// `git` global options that consume the following token as their argument, so
// we can skip past them when hunting for the subcommand (e.g. `git -c k=v push`).
const GLOBAL_OPTS_WITH_ARG = new Set([
  "-c",
  "-C",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
]);

/**
 * Decide whether a shell command string performs a real `git push` (as opposed
 * to a dry run or some other git subcommand). Handles `&&`/`||`/`;`/newline
 * chains by inspecting each segment, and skips git global options.
 *
 * @param {string} command
 * @returns {{ isPush: boolean, dryRun: boolean }}
 */
export function parseGitPush(command) {
  if (typeof command !== "string") return { isPush: false, dryRun: false };
  for (const segment of command.split(/&&|\|\||;|\n/)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    let i = tokens.findIndex((t) => t === "git" || t.endsWith("/git"));
    if (i === -1) continue;
    i += 1;
    // Walk past git's own global flags to reach the subcommand.
    while (i < tokens.length) {
      const t = tokens[i];
      if (GLOBAL_OPTS_WITH_ARG.has(t)) {
        i += 2;
        continue;
      }
      if (t.startsWith("-")) {
        i += 1;
        continue;
      }
      break;
    }
    if (tokens[i] !== "push") continue;
    const rest = tokens.slice(i + 1);
    const dryRun = rest.includes("--dry-run") || rest.includes("-n");
    return { isPush: true, dryRun };
  }
  return { isPush: false, dryRun: false };
}

/**
 * The commits that a push would send: everything reachable from `HEAD` but not
 * from the branch's upstream. Falls back to `origin/main`, then `main`, and
 * finally to just `HEAD` when no base resolves (a brand-new repo/branch).
 * Already-pushed history is intentionally excluded — we only vet what's new.
 *
 * @param {(args: string[]) => string} [runGit]
 * @returns {string[]} commit SHAs (newest first), possibly empty
 */
export function outgoingCommits(runGit = defaultRunGit) {
  for (const base of ["@{upstream}", "origin/main", "main"]) {
    try {
      const out = runGit(["rev-list", `${base}..HEAD`]);
      return out
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
    } catch {
      // base doesn't resolve (no upstream, no origin/main); try the next one.
    }
  }
  try {
    return [runGit(["rev-parse", "HEAD"]).trim()].filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * The `%G?` signature code for a single commit.
 *
 * @param {string} sha
 * @param {(args: string[]) => string} [runGit]
 * @returns {string}
 */
export function commitSignatureCode(sha, runGit = defaultRunGit) {
  return runGit(["show", "--no-patch", "--format=%G?", sha]).trim();
}

/**
 * Filter a list of commit SHAs down to those whose signature is missing or
 * invalid (i.e. `%G?` is not in {@link VALID_SIGNATURE_CODES}). A commit whose
 * code cannot be read is reported as unsigned rather than silently skipped.
 *
 * @param {string[]} shas
 * @param {(args: string[]) => string} [runGit]
 * @returns {{ sha: string, code: string }[]}
 */
export function unsignedCommits(shas, runGit = defaultRunGit) {
  const bad = [];
  for (const sha of shas) {
    let code;
    try {
      code = commitSignatureCode(sha, runGit);
    } catch {
      code = "E"; // cannot check → treat as unverified
    }
    if (!VALID_SIGNATURE_CODES.has(code)) bad.push({ sha, code });
  }
  return bad;
}
