#!/usr/bin/env node
/**
 * PreToolUse guard (Write|Edit): blocks hub-authored writes into guarded
 * source and test paths on ANY branch.
 *
 * Problem: `guard-branch-isolation.mjs` only fires while `HEAD` is `main`.
 * On a feature branch nothing in the hook layer stopped the hub itself from
 * writing directly into a guarded path — a pattern observed three separate
 * times in session logs:
 *   - docs/logs/2026-07-24-w5-promote-destructive-gate.md
 *   - docs/logs/2026-07-26-w5-promote-checkpoint-store.md
 *   - docs/logs/2026-07-27-scripts-codepipeline-ops.md
 *
 * The seam: the PreToolUse payload carries a top-level `agent_type` field
 * when the tool call fires inside a subagent context. The field is absent (or
 * empty) for hub-level calls, and contains the subagent's name for spoke calls.
 *
 * The decision: block when BOTH conditions hold:
 *   (a) the target path is a guarded source/test path, AND
 *   (b) `agent_type` is NOT the name of an authorised writer spoke
 *       (`code-implementer` or `test-author`, per WRITER_SPOKES in
 *        bin/lib/agent-roster.mjs).
 *
 * Hub calls (absent/empty agent_type) and non-writer subagents are treated
 * identically — both are blocked from guarded paths. Writer spokes are
 * allowed through. All other paths are allowed through unconditionally.
 *
 * Fail-open: an unparseable payload or missing file_path exits 0 so a
 * malformed hook input never wedges the session.
 *
 * See: issue #446, docs/plans/IMPLEMENTATION.md row 268,
 *      docs/contributing/agent-operating-model.md.
 */
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isProtectedPath } from "../../bin/lib/protected-paths.mjs";
import { WRITER_SPOKES } from "../../bin/lib/agent-roster.mjs";

/**
 * Pure decision function — exported for unit testing.
 *
 * @param {string | undefined} filePath  The file_path from the tool_input payload.
 * @param {unknown} agentType            The top-level agent_type from the payload.
 * @returns {boolean} true = block, false = allow.
 */
export function shouldBlockHubSrcWrite(filePath, agentType) {
  // Fail-open: no path or non-string path → allow.
  if (!filePath || typeof filePath !== "string") return false;

  // Non-guarded path → always allow.
  if (!isProtectedPath(filePath)) return false;

  // Authorised writer spoke → allow.
  if (
    typeof agentType === "string" &&
    agentType.length > 0 &&
    WRITER_SPOKES.has(agentType)
  ) {
    return false;
  }

  // Hub (absent/empty agent_type) or non-writer subagent + guarded path → block.
  return true;
}

// Only run when invoked directly, not when imported for testing.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  let input;
  try {
    input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    process.exit(0); // unparseable payload → fail-open
  }
  const filePath = input.tool_input?.file_path ?? "";
  const agentType = input.agent_type;
  if (!shouldBlockHubSrcWrite(filePath, agentType)) process.exit(0);
  process.stderr.write(
    "guard-hub-src-writes: Hub-authored write to a guarded path detected.\n" +
      `  Path: ${filePath}\n` +
      "  Dispatch the write to 'code-implementer' (src/**) or 'test-author' (tests/**) instead.\n" +
      "  See: docs/contributing/agent-operating-model.md\n",
  );
  process.exit(2);
}
