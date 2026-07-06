#!/usr/bin/env node
/**
 * UserPromptSubmit: when a prompt looks like change-work, inject a short
 * decision-gate reminder as additional context.
 *
 * This is the repo's only UserPromptSubmit hook and the only one that *injects*
 * context (every other hook communicates via stderr + exit code). It surfaces
 * the four decisions the `/start-work` skill formalizes — location, branch, PR,
 * push target — up front, so isolation is chosen deliberately instead of being
 * discovered when `guard-branch-isolation.mjs` blocks a src/test write on `main`.
 *
 * It is advisory: it emits `additionalContext` and exits 0. It never blocks. The
 * heuristic is deliberately loose (inject on any change-intent verb, stay quiet
 * on obvious reads) — a spurious reminder is cheap; a missed one costs a
 * mid-task branch scramble.
 */
import process from "node:process";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

// Verbs that signal the user is about to change the tree, not just ask about it.
const CHANGE_INTENT =
  /\b(implement|build|add|create|write|fix|refactor|scaffold|rename|migrate|wire up|delete|remove|update|change|edit|generate)\b/i;
// Strong read-only openers; if the prompt is one of these and carries no change
// verb, stay quiet.
const READ_ONLY_OPENER =
  /^\s*(what|why|how|when|where|which|who|explain|describe|show|list|read|find|search|look|review|audit|is|are|does|can|should|could)\b/i;

/** Current branch, or "" if git isn't available. "HEAD" means detached. */
function currentBranch() {
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf8",
    }).trim();
  } catch {
    return "";
  }
}

/**
 * Heuristic: does this prompt look like it will change the tree (vs. a read)?
 *
 * @param {string} prompt
 * @returns {boolean}
 */
export function looksLikeChangeWork(prompt) {
  if (typeof prompt !== "string" || prompt.trim().length === 0) return false;
  if (!CHANGE_INTENT.test(prompt)) return false;
  // A question-shaped prompt with no imperative change verb up front is a read.
  if (
    READ_ONLY_OPENER.test(prompt) &&
    !/^\s*\S+\s+(the|this|a|an)\b/i.test(prompt)
  )
    return false;
  return true;
}

/**
 * Build the decision-gate reminder text for the current branch.
 *
 * @param {string} branch  current branch ("main", "HEAD" for detached, "" for no repo)
 * @returns {string}
 */
export function buildContext(branch) {
  const onMain = branch === "main" || branch === "HEAD" || branch === "";
  const branchLine =
    branch === ""
      ? "not a git repo"
      : branch === "HEAD"
        ? "detached HEAD"
        : `on \`${branch}\``;
  return [
    "Decision gate (before editing code/tests/scripts) — currently " +
      `${branchLine}. Settle these first, ideally via \`/start-work\`:`,
    "  • Location — shared checkout, or an opt-in linked worktree for concurrent work?",
    "  • Branch — `feat/<slug>` or `fix/<slug>` off `main` (never `main`" +
      (onMain ? ", and you appear to be on/at `main` now" : "") +
      ").",
    "  • PR — any `src/`/`tests/` change lands via PR, never a direct commit to `main`.",
    "  • Push — `origin <branch>`, not `origin main`.",
    "guard-branch-isolation.mjs will block src/test writes on `main`, so branch first.",
  ].join("\n");
}

// Only run when invoked directly, not when imported for testing.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  let input;
  try {
    input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    process.exit(0);
  }

  if (!looksLikeChangeWork(input.prompt ?? "")) process.exit(0);

  const output = {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: buildContext(currentBranch()),
    },
  };
  process.stdout.write(JSON.stringify(output));
  process.exit(0);
}
