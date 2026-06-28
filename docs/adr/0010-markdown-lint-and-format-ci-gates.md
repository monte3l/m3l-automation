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
rumdl check . --no-cache --exclude "node_modules/**,.claude/**,**/dist/**,CHANGELOG.md,.github/pull_request_template.md,docs/adr/template.md"
```

- **`--no-cache`** prevents `rumdl` from writing a `.rumdl_cache/` directory into
  the working tree (also added to `.gitignore` as a safety net for manual runs).
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

## Links

- Supersedes: nothing
- Related: ADR-0007 (automated dependency monitoring and security gating),
  ADR-0008 (replacing `@commitlint/cli` to drop an archived transitive dep),
  `.github/workflows/ci.yml`, `.markdownlint.json`, `package.json`
