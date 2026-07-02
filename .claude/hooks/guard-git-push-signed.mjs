#!/usr/bin/env node
/**
 * PreToolUse guard (Bash): block a `git push` issued through the agent's Bash
 * tool when any outgoing commit is unsigned or has an invalid signature.
 *
 * This is the FIRST Bash-matcher hook in the repo — every other PreToolUse hook
 * inspects `tool_input.file_path`; this one inspects `tool_input.command`. It is
 * the agent-side early catch in a three-layer scheme:
 *   1. this hook            — stops the agent before the push even runs;
 *   2. lefthook `pre-push`  — bin/verify-signed-range.mjs, covers every local
 *                             push (agent or human), bypassable with --no-verify;
 *   3. branch protection    — "Require signed commits" on `main`, authoritative
 *                             and unbypassable (docs/contributing/branch-protection.md).
 *
 * Fail-open by design (matching every sibling hook): a malformed payload, a
 * non-push command, or a git failure exits 0. The literal-signature verdict is
 * the only thing that blocks (exit 2). The authoritative gate is layer 3, so a
 * conservative hook here never wedges a legitimate push it merely can't classify.
 */
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  parseGitPush,
  outgoingCommits,
  unsignedCommits,
} from "../../bin/lib/signed-range.mjs";

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

  let bad;
  try {
    bad = unsignedCommits(outgoingCommits());
  } catch {
    process.exit(0); // cannot determine range → defer to the pre-push/branch-protection layers
  }
  if (bad.length === 0) process.exit(0);

  process.stderr.write(`\
[guard-git-push-signed] Blocked: refusing to push unsigned/unverified commits.
${bad.map(({ sha, code }) => `  - ${sha.slice(0, 12)} (%G? = ${code})`).join("\n")}

Every commit pushed to the remote must carry a valid signature (CLAUDE.md
§ Security). Enable signing and re-sign the range, e.g.:
  git config commit.gpgsign true
  git rebase --exec 'git commit --amend --no-edit -S' origin/main
Then retry the push. (Backstopped by lefthook pre-push and branch protection.)
`);
  process.exit(2);
}
