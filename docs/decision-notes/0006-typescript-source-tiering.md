# 0006. TypeScript guidance source tiering, facets, and sweep cadence

- **Date:** 2026-09-08
- **Decider:** repo maintainer

Adding `researching-typescript-guidance`/`refreshing-typescript-guidance`
(the TypeScript-guidance analogue of the existing
`researching-anthropic-guidance`/`refreshing-anthropic-guidance` pair)
instantiates ADR-0082's cadence pattern (a tracker plus a non-blocking
`check:*` gate, sweep-and-plan behind `EnterPlanMode`) for a second subject —
not a new mechanism, so it doesn't need its own ADR; the reversibility test
ADR-0082 itself would apply says a four-file revert with nothing else
depending on its exact shape doesn't warrant one. What does need recording is
the two judgment calls a future maintainer would otherwise have to
relitigate from scratch, since neither has an Anthropic-guidance-pair
precedent to copy:

**Source tiering is two-owner, not one.** The Anthropic pair's allowlist has
a single vendor and one authority level. TypeScript's does not: the language
and compiler are Microsoft's, but the Node↔TypeScript runtime boundary
(`erasableSyntaxOnly`, type stripping) is Node's — Microsoft does not define
what happens when Node executes a `.ts` file directly, and this repo is
Node-24+-floor, ESM-only, exactly the intersection that boundary lives in.
The decision: **T1 (owner-normative) = typescriptlang.org, devblogs.microsoft.com/typescript,
github.com/microsoft/TypeScript, and nodejs.org/api/typescript.html as
co-normative T1** — a Microsoft/Node disagreement on that boundary is a
genuine two-owner conflict to surface, not a subordination to resolve
silently. **T2 (owner-adjacent/executable spec) = microsoft/TypeScript-Website,
typescript-eslint.io, arethetypeswrong, publint** — admitted because this
repo's own `check:exports` runs attw/publint and its own `eslint.config.js`
composes a typescript-eslint preset, so their rules are behavior this repo
is already bound by, not independent commentary. tsconfig/bases,
DefinitelyTyped's guidelines, and individual authors (Matt Pocock, Dan
Vanderkam, TypeScript Deep Dive) are explicitly out of scope (T3/T4) — named
in `references/typescript-sources.md` precisely so an agent that finds one
drops it and says so, rather than quietly substituting it for missing T1/T2
coverage. One further wrinkle worth recording: `github.com/microsoft/TypeScript/wiki/Breaking-Changes`
is a legitimate T1 URL but stopped being maintained at TypeScript 4.9 — a
citation of it for TS 5+ behavior is an error, not a finding of drift, and
the devblog release posts are the current source for breaking changes
instead.

**The periodic sweep uses five fixed facets, chosen so sweeps stay
comparable and the tracker stays diffable over time** — the same rationale
the Anthropic sibling's five facets rest on. `compiler-config-flags`,
`modules-esm-node-interop`, `packaging-declaration-emit`, `lint-typing-rules`,
`language-features-deprecations`: each maps to concrete repo files (the
`refreshing-typescript-guidance` Step 3 table), and each was chosen to cover
a hardcoded assumption already found un-owned by any existing gate — the
strict-family flag membership claim in `typescript-configuration/SKILL.md`,
the `.js`-extension-required rule `guard-js-extension.mjs` enforces, the
"annotate, never `satisfies`" `isolatedDeclarations` limitation in
`.claude/rules/scripts.md`, and the never-revisited `recommendedTypeChecked`
lint-preset choice in `eslint.config.js`. A shared Step-2 release delta
(fetched from `devblogs.microsoft.com/typescript`) feeds all five facets —
it is not a sixth facet, mirroring exactly how the Anthropic sibling passes
the Claude Code CHANGELOG delta into its own five briefs.

**The freshness threshold is 120 days, not the Anthropic sibling's 90** —
TypeScript ships roughly every 4–6 months versus Claude Code's near-daily
release cadence, so 90 days would routinely warn with no upstream delta to
find, training the maintainer to ignore the warning (exactly the failure
mode ADR-0082 exists to avoid). Not derived from an external signal, same
honesty ADR-0082 uses for its own 90-day figure.

One deliberate non-duplication: this sweep never re-stamps the three
Context7-sourced `reference-freshness` snapshots
(`typescript-configuration`, `eslint-flat-config`, `vitest-testing`) it
finds stale — it records the drift and routes the re-pull-and-re-stamp
through ADR-0093's existing context7 mechanism from the plan it produces.
The stamp answers "what did a Context7 pull return"; this tracker answers
"does the snapshot still match upstream" — different questions, and folding
one into the other would have this skill asserting a Context7 provenance it
never actually pulled.

## Links

- Related: ADR-0082 (the cadence mechanism this instantiates), ADR-0093 (the
  context7 refresh mechanism this skill defers to rather than duplicates),
  `docs/research/typescript/refresh.md`,
  `.claude/skills/researching-typescript-guidance/SKILL.md`,
  `.claude/skills/refreshing-typescript-guidance/SKILL.md`,
  `.claude/skills/researching-typescript-guidance/references/typescript-sources.md`
