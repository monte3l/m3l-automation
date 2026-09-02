> **Provenance** — Synthesized via `/researching-anthropic-guidance` from 15
> official Anthropic sources across 5 facets (session identity mechanics;
> configuration and command surfaces; hooks and session metadata; CLI/SDK and
> telemetry; the CHANGELOG and release history). Synthesized: 2026-09-02.
> Sources: [Manage sessions](https://code.claude.com/docs/en/sessions),
> [CLI reference](https://code.claude.com/docs/en/cli-reference),
> [Slash commands](https://code.claude.com/docs/en/commands),
> [Settings reference](https://code.claude.com/docs/en/settings-reference),
> [Claude Code settings](https://code.claude.com/docs/en/settings),
> [Terminal config](https://code.claude.com/docs/en/terminal-config),
> [Environment variables](https://code.claude.com/docs/en/env-vars),
> [Hooks reference](https://code.claude.com/docs/en/hooks),
> [Automate actions with hooks](https://code.claude.com/docs/en/hooks-guide),
> [Agent SDK hooks](https://code.claude.com/docs/en/agent-sdk/hooks),
> [Agent SDK sessions](https://platform.claude.com/docs/en/agent-sdk/sessions),
> [Headless mode](https://code.claude.com/docs/en/headless),
> [Agent SDK TypeScript](https://code.claude.com/docs/en/agent-sdk/typescript),
> [Agent SDK Python](https://code.claude.com/docs/en/agent-sdk/python),
> [Monitoring usage](https://code.claude.com/docs/en/monitoring-usage),
> [Status line](https://code.claude.com/docs/en/statusline),
> [Claude Code usage report](https://platform.claude.com/docs/en/api/admin/usage_report/retrieve_claude_code),
> [CHANGELOG.md](https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md),
> [Redesigning Claude Code on desktop for parallel agents](https://claude.com/blog/claude-code-desktop-redesign),
> [Building a C compiler with a team of parallel Claudes](https://www.anthropic.com/engineering/building-c-compiler)

## Consensus / best practices

- **A session name is now a first-class, user-settable identity**, not just a
  cosmetic label. It is set via `claude -n <name>` / `--name` at startup,
  `/rename <name>` mid-session (also shown on the prompt bar/border),
  `Ctrl+R` in the `/resume` picker, automatically on plan-accept (unless
  already named), or from Remote Control / the desktop app (propagates back
  to the CLI, v2.1.221+). `claude --resume <name>` and `/resume <name>`
  resolve it as a first-class handle.
- **Three-tier label model, only two of which resolve by name.** (1) a
  user-set name — the strongest tier; (2) an AI-generated title — a short
  summary of the first prompt written by a background Haiku-class request,
  shown in the `/resume` picker and **is** resolvable by `--resume`; (3) a
  default display name (e.g. `my-app-3f`, cwd name + a 2-char suffix,
  v2.1.196+) shown in agent view and `claude agents --json` but **not**
  resolvable by `--resume`. Accepting a plan overwrites tier 2 with a
  plan-derived title unless the session is already named.
- **Names are addressable identifiers as of Claude Code 2.1.232**, not
  decoration: `SendMessage`, `@`-mentions in the prompt, and `ListAgents`
  route by name, and duplicate live names on one machine are
  auto-disambiguated into a `name-word-word` variant rather than colliding.
  `ListAgents` (v2.1.247+) tells a session its own name — the one peers use
  to message it.
- **`statusLine`'s stdin payload is the only documented programmatic read of
  the human-readable name**, via the `session_name` field. It carries the
  user-set name when present, otherwise the AI-generated title — it does
  **not** populate for a default-display-name-only session.
- **No hook, and no `settings.json` key at any scope, can set or rename a
  session.** Hooks receive `session_id` read-only; command hooks communicate
  only via stdout/stderr/exit code and cannot trigger slash commands, so a
  hook cannot invoke `/rename`. `SessionStart` is additionally unblockable
  (exit 2 warns and continues). The `settings-reference` "Interface and
  terminal" section names only `statusLine`, `subagentStatusLine`,
  `footerLinksRegexes`, `defaultShell`, and `terminalProgressBarEnabled` — no
  naming key exists.
- **`/clear` preserves naming asymmetrically**: with no argument it keeps a
  `--name`/`/rename` name but drops an AI-generated title; `/clear <name>`
  instead labels the _outgoing_ conversation and starts the new one unnamed.
  `/branch [name]` names a fork after the first prompt when the name is
  omitted.
- **Both Agent SDKs (TypeScript and Python) accept only a session UUID at
  construction** (`sessionId`/`session_id`, `resume`, `forkSession`/
  `fork_session`) — naming is a post-creation call (`renameSession()`/
  `rename_session()`), with `tagSession()`/`tag_session()` for tags.
  `--output-format json` and the `system/init` stream event return
  `session_id` and metadata; no name field is documented in either payload.
- **Telemetry carries no human-readable name.** OpenTelemetry exports
  `session.id`, `user.id`, `organization.id`, `terminal.type`, and
  `start_type` (`fresh|resume|continue|agents_view`); the only labeling lever
  is the process-wide `OTEL_RESOURCE_ATTRIBUTES`. The Admin analytics API
  exposes `num_sessions` only — a count, not an identity.
- **A hook can retitle the terminal tab, but that is a different mechanism
  from naming the session.** `terminalSequence` in a hook's JSON output is
  honored on all events and supports OSC 0/2/9 escape sequences for
  window/tab titles — the docs' placement of this field is themselves
  inconsistent (see Contradictions below).
- **The Claude Code CHANGELOG confirms this repo is fully current** (top entry
  2.1.258 as of 2026-09-02) — every naming feature cited above is already
  available, none is gated above the installed version. Session naming
  landed as a real subsystem in the 2.1.231–2.1.232 window alongside a
  machine-local session registry backing name lookups.

## Contradictions / drift

- **`terminalSequence` field placement.** The hooks reference's "Full JSON
  output schema" block lists `terminalSequence` as a top-level universal
  field, while its own "Emit terminal notifications" example nests it inside
  `hookSpecificOutput`. The same document explicitly warns that misplacing
  `additionalContext` at the top level causes it to be silently ignored —
  this is an unresolved internal inconsistency in the current docs; verify
  placement empirically before depending on it, rather than trusting either
  location on the page's word alone.
- **CHANGELOG version-number drift across fetches of the same file.** A
  second pass over the raw CHANGELOG attributed several identical entries to
  different version numbers than the first pass (e.g. the same `/resume`
  title-loss fix cited as both 2.1.239 and 2.1.242). This reads as
  summarization drift over a long file rather than a real source
  disagreement — the foundational 2.1.231/2.1.232 entries were verbatim-quoted
  and are trustworthy; anything cited above 2.1.235 should be treated as
  version-approximate (±5) and re-verified before being cited with a precise
  number. Moot for this repo either way, since 2.1.258 is the newest release
  and every relevant feature sits well below it.

## Coverage gaps

- **Anthropic recommends no naming convention at all.** The mechanism (names,
  titles, registry, addressing) is documented thoroughly; the vocabulary is
  left entirely to the user. Anthropic's own parallel-Claude engineering
  prototype (`building-c-compiler`) does not use session names to keep runs
  straight at all — it disambiguates via a filesystem lock, one container per
  agent, and commit-keyed log files, and predates the naming subsystem
  described above. The scheme in ADR-0087 is this repo's own design, not an
  Anthropic recommendation.
- **No official source documents an "artifact/session gallery"** as a
  distinct concept; the closest coverage is the desktop app's session
  sidebar (filterable by status/project/environment, sessions auto-archived
  on PR merge/close), whose naming behavior for individual sessions is
  undocumented.
- **`--session-id`/`--fork-session` interaction with naming** is documented
  for what each flag does individually but not for how a forked session's
  name is derived, beyond "sessions created with `/branch` or
  `--fork-session` get their own session IDs and appear as separate rows."
- **Whether `SessionStart`'s `systemMessage` is displayed or discarded** is
  not settled from the pages fetched here — the hooks guide states
  `systemMessage` is user-facing "on Claude Code v2.1.227+" as a general
  claim, but the per-event detail for `SessionStart` specifically was not
  independently confirmed.

## Sources

See the provenance blockquote above for the full source list with URLs. Note
on domain drift discovered during this research: every
`platform.claude.com/docs/en/docs/claude-code/*` URL now 404s. Claude Code
docs live at `code.claude.com/docs/en/<page>` (`docs.claude.com` 301-redirects
there); the Agent SDK pages live under `code.claude.com/docs/en/agent-sdk/*`
(`platform.claude.com/docs/en/agent-sdk/*` 307-redirects there). This
repo's `.claude/skills/researching-anthropic-guidance/references/official-sources.md`
is corrected in the same change that adds this snapshot.
