#!/usr/bin/env node
/**
 * PreToolUse guard (Bash): restrict read-only spokes to non-mutating shell
 * commands.
 *
 * Every reviewer/research spoke in `.claude/agents/*.md` (Explore plus the six
 * review agents) declares itself read-only in its system prompt and holds the
 * `Bash` tool for legitimate reads (`git diff`, `pnpm lint`, coverage files,
 * `grep`), but nothing structurally stopped one from running a mutating shell
 * command — `bin/check-agents.mjs` only asserts the tools allowlist excludes
 * `Write`/`Edit`, not that `Bash` stays read-only in practice. This hook closes
 * that gap at the point a subagent's Bash call actually runs.
 *
 * The read-only roster is NOT hardcoded here — it's derived from
 * bin/lib/agent-roster.mjs's `readOnlyAgentNames()` (every defined agent not in
 * `WRITER_SPOKES`), the same source `bin/check-agents.mjs` uses for its
 * least-privilege check, so the two enforcement points can't drift apart.
 *
 * Scope: only tool calls made from inside one of those read-only subagents are
 * checked — identified via the hook payload's `agent_type` field (present when
 * `PreToolUse` fires inside a subagent context; absent for the hub's own Bash
 * calls, which this hook does not restrict).
 *
 * Design tradeoff, matching every sibling hook's fail-open philosophy
 * (guard-git-push-signed.mjs, guard-secret-writes.mjs): this is a DENYLIST of
 * known-mutating patterns, not a strict allowlist. A stricter allowlist would
 * be more airtight but would also block legitimate read commands this hook's
 * author didn't anticipate (a false positive wedges a reviewer's diagnostic
 * work; a false negative merely defers to code review / the PR gate, which
 * remain the authoritative backstop). Extend MUTATING_PATTERNS as new gaps are
 * found rather than flipping to an allowlist.
 */
import process from "node:process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readOnlyAgentNames } from "../../bin/lib/agent-roster.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Segment a shell command on `&&`/`||`/single `|`/`;`/newline chain operators.
 * A `|` immediately preceded by `>` is the clobber-redirect operator (`>|`),
 * not a pipe, so it must not split — otherwise `echo x >| file` gets chopped
 * into "echo x >" and "file", hiding the redirect from the write-detection
 * regex in classifyBashCommand.
 */
function segments(command) {
  return command.split(/&&|\|\||(?<!>)\||;|\n/).map((s) => s.trim());
}

/** Strip a leading path (e.g. `/usr/bin/rm` → `rm`) for verb comparison. */
function baseName(token) {
  const parts = token.split(/[/\\]/);
  return parts[parts.length - 1];
}

// Global/wrapper flags — per verb — that consume the FOLLOWING token as their
// value, so the walk to find the subcommand must skip both. Without this,
// `git -C /tmp commit` or `pnpm --dir ./foo add lodash` resolve `sub` to the
// flag's *value* ("/tmp", "./foo") instead of the real subcommand, defeating
// MUTATING_SUBCOMMANDS entirely (a `--flag=value` inline form needs no entry
// here — the value stays on the same token, which parseSegment already skips
// as "starts with -"). Mirrors GLOBAL_OPTS_WITH_ARG in bin/lib/signed-range.mjs.
const FLAGS_WITH_VALUE = {
  git: new Set([
    "-c",
    "-C",
    "--git-dir",
    "--work-tree",
    "--namespace",
    "--exec-path",
  ]),
  pnpm: new Set(["-C", "--dir", "--filter", "--filter-prod"]),
  npm: new Set(["-C", "--prefix"]),
};

/**
 * The command verb and (for multi-word CLIs) subcommand of one shell segment,
 * skipping leading `VAR=value` environment assignments and any global flags
 * (per FLAGS_WITH_VALUE) that appear before the subcommand.
 *
 * @param {string} segment
 * @returns {{ verb: string, sub: string | undefined, tokens: string[] }}
 */
function parseSegment(segment) {
  const tokens = segment.split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
  if (tokens[i] === undefined) return { verb: "", sub: undefined, tokens: [] };

  const verb = baseName(tokens[i]);
  const valueFlags = FLAGS_WITH_VALUE[verb] ?? new Set();
  let sub;
  let j = i + 1;
  while (j < tokens.length) {
    const t = tokens[j];
    if (valueFlags.has(t)) {
      j += 2; // skip the flag AND its value token
      continue;
    }
    if (t.startsWith("-")) {
      j += 1; // a flag that doesn't consume a following value
      continue;
    }
    sub = t;
    break;
  }
  return { verb, sub, tokens: tokens.slice(i) };
}

// Mutating subcommands per top-level verb (e.g. "git" → "commit"). A verb
// that's always mutating regardless of subcommand belongs in MUTATING_VERBS
// below instead.
const MUTATING_SUBCOMMANDS = {
  git: new Set([
    "add",
    "commit",
    "push",
    "merge",
    "rebase",
    "cherry-pick",
    "reset",
    "checkout",
    "switch",
    "branch",
    "tag",
    "clean",
    "apply",
    "am",
    "revert",
    "restore",
    "gc",
    "worktree", // add/remove mutate the tree layout
    "config",
    "stash", // push/pop/drop/apply mutate the working tree; `stash list` is
    // read-only but the false positive here is cheap — use `git stash list`
    // sparingly from a read-only spoke, or defer to the hub.
  ]),
  pnpm: new Set([
    "add",
    "remove",
    "rm",
    "publish",
    "version",
    "link",
    "unlink",
  ]),
  npm: new Set([
    "install",
    "i",
    "add",
    "remove",
    "rm",
    "uninstall",
    "publish",
    "version",
    "link",
    "unlink",
  ]),
};

// Verbs that mutate the filesystem regardless of subcommand.
const MUTATING_VERBS = new Set([
  "rm",
  "mv",
  "cp",
  "mkdir",
  "rmdir",
  "touch",
  "chmod",
  "chown",
  "truncate",
  "dd",
  "tee",
]);

/**
 * Classify a shell command as blocked (mutating) or allowed for a read-only
 * spoke. Denylist-based — see the module header for the design tradeoff.
 *
 * @param {string} command
 * @returns {{ blocked: boolean, reason?: string }}
 */
export function classifyBashCommand(command) {
  if (typeof command !== "string" || command.trim().length === 0) {
    return { blocked: false };
  }

  for (const segment of segments(command)) {
    if (segment.length === 0) continue;

    // Write-redirection to a real file (not a discard target). No digit
    // lookbehind: `1>file`/`2>file` are ordinary fd-prefixed writes, not fd
    // duplication — `2>&1` is excluded below because its target starts with
    // `&`, which the target class already rejects, so it never matches here
    // at all. `\|?` also catches the clobber operator (`>|file`). Global flag:
    // a segment can carry more than one redirect (`cmd > /dev/null > real`),
    // and a decoy discard target must not short-circuit the scan past a real
    // one that follows it.
    for (const redirect of segment.matchAll(/(>{1,2}\|?)\s*([^\s&|;]+)/g)) {
      if (
        !/^(\/dev\/null|nul)$/i.test(redirect[2].replace(/^["']|["']$/g, ""))
      ) {
        return {
          blocked: true,
          reason: `writes to "${redirect[2]}" via shell redirection ("${redirect[0]}")`,
        };
      }
    }

    const { verb, sub, tokens } = parseSegment(segment);
    if (verb.length === 0) continue;

    if (MUTATING_VERBS.has(verb)) {
      return { blocked: true, reason: `runs "${verb}", a mutating command` };
    }

    if (
      verb === "sed" &&
      tokens.some((t) => t === "-i" || t.startsWith("-i"))
    ) {
      return { blocked: true, reason: `runs "sed -i" (in-place edit)` };
    }

    const mutatingSubs = MUTATING_SUBCOMMANDS[verb];
    if (
      mutatingSubs !== undefined &&
      sub !== undefined &&
      mutatingSubs.has(sub)
    ) {
      return {
        blocked: true,
        reason: `runs "${verb} ${sub}", a mutating subcommand`,
      };
    }
  }

  return { blocked: false };
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

  const agentType = input.agent_type;
  if (typeof agentType !== "string" || agentType.length === 0) process.exit(0);

  let readOnly;
  try {
    readOnly = readOnlyAgentNames(join(root, ".claude/agents"));
  } catch {
    process.exit(0); // can't determine the roster → defer, don't wedge
  }
  if (!readOnly.has(agentType)) process.exit(0);

  const command = input.tool_input?.command;
  const verdict = classifyBashCommand(
    typeof command === "string" ? command : "",
  );
  if (!verdict.blocked) process.exit(0);

  process.stderr.write(`\
[guard-readonly-bash] Blocked: the "${agentType}" spoke is read-only, but this
command ${verdict.reason}.

Read-only spokes (Explore + the review agents) may inspect the repo but never
mutate it — that separation is structural (CLAUDE.md § Agent Operating Model).
If this command is genuinely needed, hand the mutation back to the hub or to a
writer spoke (code-implementer / test-author) instead of running it here.
`);
  process.exit(2);
}
