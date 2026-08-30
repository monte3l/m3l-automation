# Official Anthropic sources — the allowlist

The single source list consulted by `researching-anthropic-guidance` (one topic,
on demand) and `refreshing-anthropic-guidance` (the whole harness, periodically).
Editing this file is the one edit site when Anthropic moves, renames, or adds a
domain — both skills read it rather than carrying their own copy, so they cannot
drift apart the way the rest of the harness's Anthropic-facing surface has.

## Domain allowlist

Pass verbatim as `WebSearch`'s `allowed_domains`:

```
anthropic.com, www.anthropic.com, claude.com, www.claude.com,
platform.claude.com, code.claude.com, docs.claude.com, docs.anthropic.com
```

Anthropic's engineering posts, research papers, and news all live under
`anthropic.com` (including `/engineering`, `/research`, `/news`), so this one
allowlist covers whitepapers and blog posts as well as docs — no separate domain
list is needed per source type.

`docs.claude.com` 301-redirects to `platform.claude.com` (confirmed live
2026-08-30) — the allowlist keeps both so a redirect is followed rather than
treated as a dead link, but new citations should prefer `platform.claude.com`.

## GitHub caveat

`allowed_domains` filters by domain, not path, so a bare `github.com` allowance
would let through any repo. Agents may include `github.com` and
`raw.githubusercontent.com` in their search domains, but must **only cite or
fetch URLs under the `anthropics` GitHub org** — `github.com/anthropics/...` or
`raw.githubusercontent.com/anthropics/...` (the paths differ: the former's org
segment sits right after the host, the latter's after the host with no
`github.com` prefix in the path at all) — and drop any other GitHub result, even
a highly-ranked one.

## First-class sources to enumerate directly

Search ranking is not exhaustive — a recent post absent from `WebSearch` results
is silently missed and won't even register as a coverage gap unless an agent is
told to check these directly:

- **Claude Code CHANGELOG** —
  `https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md`.
  The authoritative, version-ordered record of Claude Code feature and behavior
  changes. Confirmed live 2026-08-30 (latest entry: 2.1.251). Because it's
  version-ordered, it can be read as a **delta** from a known prior version
  rather than in full — useful for a periodic refresh rather than a one-time
  topic research pass.
- **Release notes** — `https://platform.claude.com/docs/en/release-notes/claude-code`
  (redirects from `docs.claude.com/en/release-notes/claude-code`).
- **Blog / news / engineering / research index pages** — enumerate these
  directly rather than relying on search to surface them:
  - `https://www.anthropic.com/news`
  - `https://www.anthropic.com/engineering`
  - `https://www.anthropic.com/research`
  - `https://claude.com/blog`

## Current-date anchor

Every agent brief must state today's date explicitly. A `retrieved <date>`
stamp (required in both skills' findings formats) otherwise depends on the
spoke inferring the date itself, which is unreliable.

## Coverage discipline

Reject any non-allowlisted domain outright and say so in the report, rather
than substituting a community blog, a third-party summary, or a Stack Overflow
answer for missing official coverage. If a facet turns up no official source,
that is itself a reportable finding (a coverage gap), not a reason to lower the
bar.
