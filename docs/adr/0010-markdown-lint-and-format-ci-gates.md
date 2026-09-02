# 0010. Enforce formatting and Markdown linting in CI, with rumdl as the Markdown linter

- **Status:** Accepted
- **Date:** 2026-06-28
- **Deciders:** Enrico Lionello

## Context and problem statement

An audit of the toolchain against the documented desired state surfaced two
quality-gate gaps in CI (`.github/workflows/ci.yml`):

1. **`format:check` was never run in CI.** The script existed
   (`prettier --check .`) and Prettier runs `--write` in the `pre-commit` hook,
   but nothing verified formatting on the server. A commit that bypassed the hook
   (`git commit --no-verify`, a web edit, a rebase) could land unformatted code
   and never be caught.
2. **Markdown was never linted at all.** A `.markdownlint.json` config existed in
   the repo, but no tool consumed it — an orphan config asserting an intent that
   nothing enforced, across ~50 documentation files (`docs/`, ADRs, `rules/`,
   `README.md`, `CLAUDE.md`).

Closing gap 2 requires choosing a Markdown linter. The obvious default,
`markdownlint-cli2`, pulls two transitive dependencies with open advisories:

| Advisory | Package       | Path                              | Patched in |
| -------- | ------------- | --------------------------------- | ---------- |
| moderate | `js-yaml`     | `markdownlint-cli2 > js-yaml`     | >=4.1.2    |
| moderate | `markdown-it` | `markdownlint-cli2 > markdown-it` | >=14.1.2   |

Both are quadratic-complexity DoS advisories. They are dev-only (the linter is
never shipped in `@m3l-automation/m3l-common`) and sit below the CI
`pnpm audit --audit-level=high` gate, so they would not block the build — but they
would be reported by `pnpm audit` and tracked by Dependabot, adding ongoing noise.
ADR-0007 establishes a policy of keeping the dependency tree clear of
advisory-bearing transitive deps; ADR-0008 applied it to `@commitlint/cli`. This
ADR applies the same reasoning to the Markdown linter.

## Decision drivers

- Close the two documented CI quality-gate gaps (`format:check`, Markdown lint).
- Keep the dependency tree free of advisory-bearing transitive deps (ADR-0007).
- Reuse the existing `.markdownlint.json` — no config rewrite, no new rule dialect
  for contributors to learn.
- Actively maintained, recently updated tooling.
- Minimal CI friction; fast execution.

## Considered options

For the **format gate**: simply add `pnpm format:check` as a CI step. (No
alternative — Prettier is already the formatter of record.)

For the **Markdown linter**:

1. **rumdl** — Rust single-binary linter, distributed as an npm dev dependency.
2. **markdownlint-cli2** — the JavaScript de-facto standard.
3. **markdownlint-cli** — the original JavaScript CLI (same `markdownlint` engine).
4. **mado / mdlint (markdownlint-rs)** — other Rust linters.
5. **Remove `.markdownlint.json`** — drop the intent, do not lint Markdown.

## Decision

We **added `pnpm format:check` as a CI step**, and **adopted `rumdl` as the
Markdown linter** behind a new `pnpm lint:md` CI step.

### Dependency changes

| Action | Package                |
| ------ | ---------------------- |
| Add    | `rumdl` (pinned exact) |

`rumdl` has an **empty dependency tree**: its `dependencies` are empty and its
platform binary ships as first-party `@rumdl/cli-<platform>` optional-dependency
leaves (the esbuild / Biome distribution pattern). After the swap,
`pnpm audit` reports **"No known vulnerabilities found."**

### Why rumdl over markdownlint-cli2 / markdownlint-cli (options 2, 3)

Both pull the `js-yaml` and `markdown-it` advisories above. `rumdl` carries
neither, **auto-discovers the existing `.markdownlint.json`** (no config rewrite),
is actively maintained with a rapid release cadence, and runs in ~10ms over the
doc set.

### Why rumdl over the other Rust linters (option 4)

`mado` is not published to npm under a usable name (the `mado` npm package is an
unrelated, abandoned 2022 project; there is no official npm distribution), so it
cannot be a clean pnpm dev dependency. `mdlint` / `markdownlint-rs` enforces its
own canonical rule set rather than reading `.markdownlint.json`, which would
discard our existing configuration. Only `rumdl` is both npm-installable and
config-compatible.

### Why not drop Markdown linting (option 5)

That would leave the documented intent (`.markdownlint.json`) unenforced and the
~50-file doc surface unchecked. The audit's purpose was to close gaps, not delete
them.

### Configuration and scoping

The `lint:md` script is:

```console
rumdl check . --no-cache --deny-config-warnings --exclude "node_modules/**,.claude/**,**/dist/**,tmp/**,CHANGELOG.md,.github/pull_request_template.md,docs/adr/template.md,docs/plans/archive/**"
```

(Corrected 2026-08-31: this block had drifted from `package.json`, which had
since added the `tmp/**` and `docs/plans/archive/**` exclusions. No gate joins
the two, so it silently went stale.)

- **`--no-cache`** prevents `rumdl` from writing a `.rumdl_cache/` directory into
  the working tree (also added to `.gitignore` as a safety net for manual runs).
- **`--deny-config-warnings`** (added 2026-08-31) makes an unknown rule option
  exit non-zero instead of printing a warning and passing. Without it, a
  renamed or mistyped key in `.markdownlint.json` is silently ignored — the
  exact way a rule this repo believes it has configured could quietly revert to
  its default.
- **Exclusions** mirror the surfaces other tools already ignore plus two scaffolds:
  - `.claude/**` — tooling files (agents/skills carry YAML front matter that trips
    `MD041`); already ignored by ESLint and knip.
  - `.github/pull_request_template.md` — a GitHub template, intentionally headed by
    `## Summary` rather than an H1.
  - `docs/adr/template.md` — the ADR scaffold whose `<option N>` placeholders trip
    `rumdl`'s `MD033` (inline-HTML) implementation.
- **Pinning:** `rumdl` is pinned exactly (matching every other dev dependency).
  pnpm's `minimumReleaseAge` supply-chain policy holds back releases younger than
  the threshold, so the installed version may trail the latest by a day.

Wiring `format:check` green required formatting five pre-existing files that had
escaped the `pre-commit` hook.

## Consequences

- **Positive:**
  - Both documented CI gaps are closed: formatting and Markdown are now enforced
    server-side, independent of local hooks.
  - The dependency tree gains zero advisory-bearing nodes; `pnpm audit` stays clean
    (ADR-0007 policy upheld).
  - The existing `.markdownlint.json` is reused verbatim — no new rule dialect.
- **Negative / trade-offs:**
  - `rumdl` reimplements the `markdownlint` rules in Rust, so results are not
    byte-identical to the canonical engine (e.g. its `MD033` flags the ADR
    template's `<option N>` placeholders). Rule parity must be re-checked on
    `rumdl` upgrades; divergences are handled via config or scoped exclusions.
  - A native binary dependency (platform-specific optional deps) replaces a pure-JS
    tool; CI runners must have a supported `@rumdl/cli-<platform>` target (Linux
    x64 is covered).
- **Semver impact:** none — tooling change only; no change to the public API.

## Amendment (2026-08-31) — prettier wins over rumdl, and MD076 is configured

The Consequences section above predicted this and prescribed the remedy: "Rule
parity must be re-checked on `rumdl` upgrades; divergences are handled via
config or scoped exclusions." This is the first time that played out, so it is
recorded here as the worked example — and it exposed a rule the original
decision left unstated.

### What happened

`chore(deps-dev): bump rumdl from 0.2.43 to 0.2.62 (#784)` tightened `MD076`
(`list-item-spacing`), which began flagging
`docs/contributing/branch-protection.md:121`. The two gates this ADR
introduced had become **mutually unsatisfiable** on that file:

- `MD076` at its default `style = "consistent"` rejects a blank line between
  list items when sibling items are tight.
- prettier **requires** that blank line, because the list's first item carries
  continuation paragraphs.

Deleting the line was not a fix — prettier restores it. `rumdl fmt` followed by
`prettier --write`, iterated five times, reaches a fixed point that still fails
`lint:md` with the file byte-identical to `HEAD`. Neither a prettier bump
(3.9.6 behaves identically to 3.9.4) nor a rumdl bump (0.2.62 is the newest
published version) resolves it.

**The breakage was latent, not visible on `main`.** `ci.yml`'s `Lint Markdown`
step is path-gated on `md == 'true'`, and #784's own diff touched only `ts` and
`deps` paths — so the step was **skipped** on both that PR and the subsequent
`main` push, and `main`'s CI stayed green (run on `2759a9b0`: job
`Format & Markdown` = success, step `Lint Markdown` = skipped). The cost landed
instead on the next PRs to touch a Markdown file: #785 went `FAILURE` on
`Format & Markdown` for adding `REVIEW.md`, and it blocked this repo's
Node-version work too. Worth noting as a gate-design lesson — a path-gated
check can let a toolchain bump land a repo-wide breakage while reporting green.

### The precedence rule this ADR was missing

This ADR added `format:check` and `lint:md` as independent gates and never said
which wins when they disagree — which is why the conflict had no obvious home.
Stated now:

> **prettier owns Markdown formatting. Where a rumdl rule contradicts
> prettier's output, prettier wins and the rumdl rule is configured to agree.**

prettier is the earlier and broader authority: it runs in `pre-commit` on every
staged file, gates every commit through `format:check`, and formats far more
than Markdown. A rumdl rule that fights it can only ever produce an
unsatisfiable tree.

### The fix: configure MD076, do not disable it

`.markdownlint.json` gains:

```json
"MD076": { "allow_loose_continuation": true }
```

This lands in the config surface this ADR already chose — rumdl was picked
partly because it "auto-discovers the existing `.markdownlint.json` (no config
rewrite)" — so no new config file is introduced.

**It does, however, cross a line this ADR drew.** The Decision drivers and
Consequences both justify `.markdownlint.json` as "reused verbatim — no new
rule dialect". `MD076` is **rumdl-native**: markdownlint 0.41.1 defines rules
only up to `MD060` and has no `MD076` at all. So the file now carries its first
rumdl-only key and is no longer portable back to markdownlint. That is accepted
deliberately — the alternative is a `.rumdl.toml`, which would change config
resolution precedence for a larger blast radius than this fix warrants — but it
means the "no new rule dialect" property is **spent**, and a future reader
should not assume `.markdownlint.json` is engine-agnostic. Migrating to
`.rumdl.toml` (which supports comments and `[per-file-ignores]`, the surgical
alternative to a repo-wide setting) is the deferred follow-up if more
rumdl-native config accumulates.

`allow_loose_continuation` was preferred over `"MD076": false` because it keeps
the rule live: `MD076.style` remains `"consistent"`, and the rule still flags a
genuinely inconsistent list. Verified by mutation test — a list with a stray
blank line between two single-paragraph items is still reported, while the
continuation-paragraph case prettier mandates is not. Disabling the rule
outright would have silently accepted both. `style = "loose"` was rejected: it
inverts the requirement and produced 11 violations in that one file alone.

Also note **where the fix had to live**. `.claude/hooks/post-edit-md-verify.mjs`
runs `pnpm exec rumdl check <file>` with no flags, so a `--disable MD076` added
to the `lint:md` script would have left that hook failing on every Markdown
edit. Config-level changes cover both call sites; script-level flags do not.
Any future rumdl divergence should be resolved in `.markdownlint.json` for the
same reason.

### Standing consequence

`.markdownlint.json` is JSON and cannot carry comments, so it has no room for
the `eslint.config.js`-style "why" block that this repo uses for a deliberately
disabled rule. **This ADR is therefore the rationale record for every entry in
that file.** The pre-existing `MD013` (line length — prettier owns wrapping)
and `MD041` (first-line heading — false-positives on docs opening with
front-matter or a badge block) disables predate this amendment and had no
recorded justification anywhere; they are noted here so the file is fully
accounted for.

## Links

- Supersedes: nothing
- Related: ADR-0007 (automated dependency monitoring and security gating),
  ADR-0008 (replacing `@commitlint/cli` to drop an archived transitive dep),
  `.github/workflows/ci.yml`, `.markdownlint.json`, `package.json`
- Amended 2026-08-31 (see above): `.markdownlint.json` (`MD076`),
  `.claude/hooks/post-edit-md-verify.mjs`, PR #784 (the rumdl bump that
  surfaced the conflict)
