#!/usr/bin/env node
/**
 * PreToolUse guard (Bash): block a `git push` issued through the agent's
 * Bash tool when the installed lefthook `pre-push` shim fails OPEN — its
 * unresolved-binary branch echoes "Can't find lefthook in PATH" and falls
 * through with no `exit 1` (H14, issue #1097). Pushing through such a shim
 * runs no gate at all if lefthook can't be found on the machine, and the
 * push would look clean while every check silently didn't run.
 *
 * This is the layer that fires in the actual failure case. A `pre-push`-
 * chain `check:*` gate (`bin/check-lefthook-shim.mjs`) cannot detect this
 * defect live: if the shim fails open, `pre-push` never runs, so nothing
 * wired inside it runs either — it only catches the precursor (a stale shim
 * discovered on some other push). This hook inspects the shim BEFORE the
 * push runs, the same position `guard-git-push-signed.mjs` occupies for
 * unsigned commits, and blocks (exit 2) rather than warns — the shim being
 * fail-open on THIS push, right now, is the one case with no cheaper
 * detection.
 *
 * Fail-open on everything ambiguous (matching every sibling hook): a
 * malformed payload, a non-push command, a missing shim, a non-lefthook
 * shim, or a read failure all exit 0. Only a confirmed fail-open lefthook
 * `pre-push` shim blocks. Local `lefthook.yml`'s
 * `assert_lefthook_installed: true` plus `pnpm exec lefthook install` is
 * the actual fix; this hook only stops the agent from pushing through a
 * shim that predates it or was installed without it.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseGitPush } from "../../bin/lib/signed-range.mjs";
import { classifyShim, shimsDir } from "../../bin/lib/lefthook-shim.mjs";

/**
 * Pure decision function — exported for unit testing. Mirrors
 * `guard-hub-src-writes.mjs`'s `shouldBlockHubSrcWrite` shape: every
 * ambiguous or non-applicable input returns `false` (allow), and only one
 * confirmed verdict returns `true` (block).
 *
 * @param {boolean} isPush  from {@link parseGitPush}
 * @param {boolean} dryRun  from {@link parseGitPush}
 * @param {string | null} shimSource  the installed `pre-push` shim's
 *   content, or `null` when it could not be read
 * @returns {boolean} true = block, false = allow
 */
export function shouldBlockPush(isPush, dryRun, shimSource) {
  if (!isPush || dryRun) return false;
  const { isLefthook, failsOpen } = classifyShim(shimSource);
  return isLefthook && failsOpen;
}

/**
 * Read the installed `pre-push` shim's content, or `null` if it can't be
 * found or read — never throws, since a missing shim (no lefthook.yml
 * `pre-push` block, a fresh clone) is a legitimate, non-blocking state.
 *
 * @returns {string | null}
 */
function readPrePushShim() {
  try {
    const commonDir = execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return readFileSync(join(shimsDir(commonDir), "pre-push"), "utf8");
  } catch {
    return null;
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

// Only run when invoked directly, not when imported for testing.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const raw = await readStdin();
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const command = input.tool_input?.command;
  const { isPush, dryRun } = parseGitPush(
    typeof command === "string" ? command : "",
  );
  if (!isPush || dryRun) process.exit(0);

  if (!shouldBlockPush(isPush, dryRun, readPrePushShim())) process.exit(0);

  process.stderr.write(`\
[guard-lefthook-shim] Blocked: the installed lefthook \`pre-push\` shim fails
OPEN — if no lefthook binary resolves on this push, every gate (format,
lint, typecheck, tests, signed-range) silently skips and the push proceeds
anyway. Fix it first:
  pnpm exec lefthook install
lefthook.yml's assert_lefthook_installed: true makes the regenerated shim
fail closed. (Backstopped by pnpm check:lefthook-shim; see issue #1097.)
`);
  process.exit(2);
}
