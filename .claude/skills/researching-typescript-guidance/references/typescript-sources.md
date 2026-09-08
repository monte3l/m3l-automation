# Upstream TypeScript sources — the two-tier allowlist

The single source list consulted by `researching-typescript-guidance` (one
topic, on demand) and `refreshing-typescript-guidance` (the whole repo's
TypeScript-facing surface, periodically). Editing this file is the one edit
site when the tiering changes — both skills read it rather than carrying
their own copy, mirroring the Anthropic-guidance pair's
`references/official-sources.md` convention exactly, so they cannot drift
apart the way the rest of this repo's TypeScript-facing surface has.

Unlike the Anthropic pair — a single vendor, one authority level — this
corpus has **two owners and two tiers**. TypeScript the language and compiler
belongs to Microsoft. The Node↔TypeScript runtime boundary (type stripping,
`erasableSyntaxOnly`) belongs to Node.js — Microsoft does not define what
happens when Node executes a `.ts` file directly. Both are Tier 1. See
`docs/decision-notes/0006-typescript-source-tiering.md` for the full
rationale behind this split and the facets it drives.

## Domain allowlist

Pass verbatim as `WebSearch`'s `allowed_domains`:

```
typescriptlang.org, www.typescriptlang.org, devblogs.microsoft.com,
nodejs.org, typescript-eslint.io, arethetypeswrong.github.io, publint.dev
```

Two of these are **path-scoped within an otherwise broader domain** —
`allowed_domains` filters by domain only, so an agent must additionally
respect the scope prose below when deciding what to cite, the same
discipline the GitHub caveat below applies to `github.com`:

- `devblogs.microsoft.com` hosts every Microsoft product's blog. Only
  `/typescript/` paths are in scope here.
- `nodejs.org` hosts the whole Node.js documentation site. Only `/api/`
  paths — principally `/api/typescript.html` — are in scope here.

## The two tiers, and why T2 exists at all

**T1 — owner-normative.** A claim from here can be cited as-is.

- `typescriptlang.org` — the Handbook, the tsconfig reference, the Modules
  reference. The language's own reference material.
- `devblogs.microsoft.com/typescript` — release announcements. **The
  authoritative record of breaking changes** — see the stale-wiki warning
  below.
- `github.com/microsoft/TypeScript` — releases, milestones, wiki Design
  Notes (the "why a feature is/isn't done" record).
- `nodejs.org/api/typescript.html` — **co-normative T1** for the
  Node↔TypeScript runtime boundary. Node owns type stripping and
  `erasableSyntaxOnly`'s runtime meaning; Microsoft owns the flag. A
  disagreement across that seam is a genuine two-owner conflict to surface,
  not a T1-vs-T2 subordination to resolve silently.

**T2 — owner-adjacent / executable spec.** Citable, but state the scope
limit — these describe behavior this repo is directly bound by (its own
`check:exports` runs attw and publint; its own `eslint.config.js` composes a
typescript-eslint preset), not independent commentary on the language.

- `github.com/microsoft/TypeScript-Website` — the Handbook's own source
  repo. Useful for confirming whether a doc page is current, or for a
  pending change not yet live on typescriptlang.org.
- `typescript-eslint.io` — rule semantics, and the exact composition of the
  `recommendedTypeChecked`/`strictTypeChecked`/`stylisticTypeChecked`
  presets.
- `arethetypeswrong.github.io` (and
  `github.com/arethetypeswrong/arethetypeswrong.github.io`) — packaging
  correctness rules (dual-format resolution, `exports`-map type resolution
  failure modes).
- `publint.dev` — package-publishing correctness rules.

**Explicitly out of scope (T3/T4).** Named here so an agent that finds one
of these drops it and says so in its report, rather than quietly
substituting it for missing T1/T2 coverage — the same coverage discipline
the Anthropic pair's allowlist applies:

- `github.com/tsconfig/bases` (the `@tsconfig/*` packages) — actively
  maintained ecosystem consensus, but consensus, not the owner's word.
- DefinitelyTyped's own contribution guidelines — authoritative only for
  `@types/*` authoring, a narrower question than this repo asks.
- Individual authors and their published material (Matt Pocock/Total
  TypeScript, Dan Vanderkam/Effective TypeScript, the TypeScript Deep Dive
  book) — no normative standing, and varying staleness (Deep Dive
  particularly).

## GitHub caveat

`allowed_domains` filters by domain, not path, so a bare `github.com`
allowance would let through any repo. Agents may include `github.com` and
`raw.githubusercontent.com` in their search domains, but must **only cite or
fetch URLs under `microsoft/TypeScript`, `microsoft/TypeScript-Website`, or
`arethetypeswrong/arethetypeswrong.github.io`** — and drop any other GitHub
result, however highly ranked. The two hosts' paths differ:
`github.com/microsoft/TypeScript/...` puts the org segment right after the
host; `raw.githubusercontent.com/microsoft/TypeScript/...` has no
`github.com` segment in the path at all.

**`microsoft/typescript-go` is archived** (2026-09-01) and redirects to
`microsoft/TypeScript` — the Go-native compiler it housed is now mainline
`typescript` as of the 7.0 release. Citing `typescript-go` as a live,
separate source is stale on its face; follow the redirect and cite the
destination instead.

## First-class sources to enumerate directly

Search ranking is not exhaustive — a recent devblog post or an individual
tsconfig option page can rank poorly and simply not surface. Enumerate these
directly rather than relying on search alone:

- `https://devblogs.microsoft.com/typescript/` — the release-announcement
  index. Version-ordered, so it can be read as a **delta** from a known
  prior version — this is `refreshing-typescript-guidance` Step 2's primary
  input, the structural analogue of how the Anthropic sibling reads the
  Claude Code CHANGELOG as a delta.
- `https://github.com/microsoft/TypeScript/releases` — the machine-readable
  version list; cross-check the devblog against it.
- `https://www.typescriptlang.org/tsconfig/` — the per-option compiler-flag
  reference. Enumerate directly; individual option pages rank poorly.
- `https://www.typescriptlang.org/docs/handbook/modules/reference.html` —
  the Modules reference (`nodenext`/`bundler` resolution modes, ESM/CJS
  interop).
- `https://nodejs.org/api/typescript.html` — Node's type-stripping page:
  stability status, `erasableSyntaxOnly` constraints, what is and isn't
  supported (no enums, no runtime namespaces, no parameter properties as of
  this writing — re-verify, this is exactly the kind of claim that moves).
- `https://typescript-eslint.io/users/configs/` — preset composition: what
  is actually _in_ `recommendedTypeChecked` versus the stricter presets.

**Stale-source warning:**
`https://github.com/microsoft/TypeScript/wiki/Breaking-Changes` stops at
**TypeScript 4.9** — it has not been maintained for the 5.x/6.x/7.x line.
It remains a legitimate T1 source for _historical_ breaking changes, but
citing it for TS 5+ behavior is an error, not a finding of drift. The
devblog release posts (above) are the current source for breaking changes.

## Current-date anchor

Every agent brief must state today's date explicitly — a `retrieved <date>`
stamp (required in both skills' findings formats) otherwise depends on the
spoke inferring the date itself, which is unreliable.

## Coverage discipline

Reject any non-allowlisted domain outright and say so in the report, rather
than substituting a community blog, an individual author's material, or a
Stack Overflow answer for missing T1/T2 coverage. If a facet turns up no
qualifying source, that is itself a reportable finding (a coverage gap), not
a reason to lower the bar.

## Dated state of the world

**As of 2026-09-08:**

- **TypeScript 7.0 is GA** (shipped 2026-07-08; latest ~7.0.2). The
  Go-native compiler is now the mainline `typescript` npm package.
- **7.0 breaking changes:** `strict` now defaults **true**; `types` defaults
  **`[]`** (was `["*"]`); `rootDir` defaults **`./`**; `target: es5`,
  `downlevelIteration`, and amd/umd/system module resolution **removed**;
  `baseUrl` **removed** in favor of relative `paths`.
- **No stable programmatic compiler API yet** — expected in 7.1. Anything
  depending on the TS API is on 6.x semantics for now.
- **`microsoft/typescript-go` archived 2026-09-01**, redirecting to
  `microsoft/TypeScript`.
- **This repo pins `typescript@6.0.3`** (`package.json` devDependencies) — a
  full major behind upstream.

This block is a dated fact, not a standing claim, and it is not this file's
job to keep it current — `refreshing-typescript-guidance` Step 5 updates
`docs/research/typescript/refresh.md` on its own cadence. Refresh this block
only when a sweep finds it materially wrong, and re-date it when you do.
