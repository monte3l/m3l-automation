# 0008. Replace @commitlint/cli with a thin wrapper around @commitlint/lint

- **Status:** Accepted
- **Date:** 2026-06-28
- **Deciders:** Enrico Lionello

## Context and problem statement

`@commitlint/cli@21.1.0` carries `git-raw-commits@5.0.1` as a transitive
dependency (via `@commitlint/read`). The `git-raw-commits` package is archived at
`conventional-changelog-archived-repos/git-raw-commits` and explicitly deprecated
in favour of the `conventional-changelog` monorepo — placing it in a grey zone:
still receiving patch updates but no new development, with no clear maintenance
horizon.

ADR-0007 establishes a policy of avoiding archived/deprecated transitive
dependencies. This ADR records how that policy is applied to `@commitlint/cli`.

The repo uses `@commitlint/cli` for two jobs:

1. **Local `commit-msg` hook** (`lefthook.yml`): `pnpm exec commitlint --edit {1}`
2. **CI PR validation** (`.github/workflows/ci.yml`):
   `pnpm exec commitlint --from $BASE --to $HEAD --verbose`

## Decision drivers

- Remove the `git-raw-commits` transitive dep (per ADR-0007 policy).
- Keep the exact same validation rules (`@commitlint/config-conventional`).
- Prefer an npm-based solution over raw shell scripts for richer error output and
  easier future extensibility.
- Minimise the diff: no new config files, no new tool ecosystems.

## Considered options

1. **Thin wrapper using `@commitlint/lint` + `@commitlint/load`** (recommended)
2. **`git-conventional-commits` npm package**
3. **Shell regex hooks**

## Decision

We chose **option 1** — a small ESM script (`bin/lint-commit.mjs`) that calls
`@commitlint/lint` and `@commitlint/load` directly, replacing only `@commitlint/cli`.

### Dependency changes

| Action | Package                                                                    |
| ------ | -------------------------------------------------------------------------- |
| Remove | `@commitlint/cli@21.1.0` (pulls in `@commitlint/read` → `git-raw-commits`) |
| Add    | `@commitlint/lint@21.1.0`                                                  |
| Add    | `@commitlint/load@21.1.0`                                                  |
| Keep   | `@commitlint/config-conventional@21.1.0`                                   |
| Keep   | `@commitlint/types@21.1.0`                                                 |

Both added packages and all kept packages install with zero `git-raw-commits`
nodes (verified with `npm install @commitlint/lint @commitlint/load @commitlint/config-conventional`).

### Why option 1 over option 2 (`git-conventional-commits`)

`git-conventional-commits@2.9.0` (`yaml` + `yargs` deps, no `git-raw-commits`) is
actively maintained and provides a `commit-msg-hook <file>` command. However:

- It **requires** a `git-conventional-commits.yaml` config file in the repo — it
  throws `ENOENT` if absent. No zero-config mode exists.
- Its default commit-type list (`ops`, `merge`, etc.) diverges from
  `@commitlint/config-conventional`; replicating the exact set needs a bespoke YAML.
- It has **no range-validation command**: no equivalent of `--from / --to` for CI.
  A workaround (shell loop writing each commit message to a temp file and calling
  `commit-msg-hook`) would be more code than the wrapper script, and harder to
  reason about.
- It is fundamentally a release utility (version bump + changelog); commit
  validation is a secondary feature.

### Why option 1 over option 3 (shell regex)

A shell `grep -qE` regex can replicate the structural check, but loses the
user-friendly per-rule error messages from `@commitlint/lint`, and requires
maintaining the regex alongside the `commitlint.config.js` rather than having a
single source of truth.

### New file: `bin/lint-commit.mjs`

A ~30-line ESM script with two modes:

```console
node bin/lint-commit.mjs --edit <file>              # local commit-msg hook
node bin/lint-commit.mjs --from <sha> --to <sha>    # CI PR range check
```

It loads config via `@commitlint/load` (reads `commitlint.config.js` through
cosmiconfig — no new config file), calls `@commitlint/lint` per message, and
exits 1 on any violation. `commitlint.config.js` is kept unchanged.

## Consequences

- **Positive:**
  - `git-raw-commits` (archived dep) is removed from the tree.
  - Validation rules and error messages are identical to before (`@commitlint/lint`
    is the same engine; `@commitlint/cli` was just a thin wrapper around it).
  - `commitlint.config.js` is unchanged — developer muscle memory is preserved.
- **Negative / trade-offs:**
  - A 30-line `bin/lint-commit.mjs` script is added to the repo and must be kept
    in sync if `@commitlint/lint`'s programmatic API changes across major versions.
    (Its API has been stable across many major versions.)
- **Semver impact:** none — tooling change only; no change to the public API.

## Links

- Supersedes: nothing
- Related: ADR-0007 (dependency monitoring strategy), `lefthook.yml`,
  `.github/workflows/ci.yml`, `commitlint.config.js`
