#!/usr/bin/env node
/**
 * PreToolUse advisory (Agent): warns when the hub dispatches a **writer**
 * spoke (`test-author` / `code-implementer`) without handing it an explicit
 * journal path in the prompt.
 *
 * Why: subagent mid-turn truncation (a spoke hitting `maxTurns: 40` or an
 * output-token cap mid-thought) is this repo's most-recurring build
 * divergence — see `docs/contributing/subagent-context-management.md`. Both
 * writer spokes already carry a "Journal as you go" fallback that derives a
 * scratchpad path on its own (`<scratchpad>/<agent-name>-<module>.md`) when
 * the hub doesn't name one, so this is a belt-and-suspenders check, not the
 * only line of defense: the exact gap it catches is
 * `docs/logs/2026-07-11-core-script-preset-seam.md` §1, where the hub forgot
 * to hand `test-author` a path and a truncated run left no durable,
 * hub-discoverable trace. Naming the path explicitly also means the hub
 * knows exactly which file to read on resume without guessing at the
 * fallback's naming convention.
 *
 * The writer-spoke roster is NOT hardcoded here — it's `WRITER_SPOKES` from
 * bin/lib/agent-roster.mjs, the same source `bin/check-agents.mjs` and
 * `guard-readonly-bash.mjs` use, so "which spokes are writers" can't drift
 * between enforcement points.
 *
 * Non-blocking (always exits 0): this is advisory, not a hard gate. A false
 * positive (the hub deliberately relied on the spoke's own fallback path, or
 * phrased the instruction in a way this heuristic doesn't recognize) is cheap
 * — it just prints a reminder — whereas a false negative merely defers to the
 * existing reactive playbook (verify-on-disk + resume-via-SendMessage), which
 * remains the authoritative backstop. Detection is a simple case-insensitive
 * "journal" substring check on the prompt text, matching the fail-open
 * denylist philosophy of every sibling hook (guard-readonly-bash.mjs,
 * guard-git-push-signed.mjs) rather than attempting to parse a real path out
 * of free-form prose.
 *
 * Tool-name caveat: the exact `tool_name` Claude Code assigns to a subagent
 * dispatch is not pinned down in the public hooks reference at the time this
 * was written; "Agent" matches this environment's tool name. If a future
 * harness version renames it, this hook simply stops matching (fails open,
 * silently inert) rather than erroring — update the PreToolUse matcher in
 * .claude/settings.json if `pnpm check:hooks` or a dry run shows it never
 * fires.
 */
import process from "node:process";
import { fileURLToPath } from "node:url";
import { WRITER_SPOKES } from "../../bin/lib/agent-roster.mjs";

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * @param {string} prompt
 * @returns {boolean} true if the dispatch prompt appears to name a journal
 *   path for the spoke to maintain.
 */
export function mentionsJournal(prompt) {
  return typeof prompt === "string" && /journal/i.test(prompt);
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

  const subagentType = input.tool_input?.subagent_type;
  if (typeof subagentType !== "string" || !WRITER_SPOKES.has(subagentType)) {
    process.exit(0);
  }

  const prompt = input.tool_input?.prompt;
  if (mentionsJournal(prompt)) process.exit(0);

  process.stderr.write(
    `⚡ journal-path reminder: dispatching "${subagentType}" without an ` +
      `explicit journal path in the prompt.\n` +
      `   Writer spokes hit their turn limit mid-thought often enough that ` +
      `this is\n   this repo's most-recurring build divergence (see ` +
      `docs/contributing/subagent-context-management.md). Hand it a scratchpad\n` +
      `   path explicitly (e.g. "<scratchpad>/${subagentType}-<module>.md") so ` +
      `a truncated\n   run leaves a trace you already know how to find.\n`,
  );
  process.exit(0);
}
