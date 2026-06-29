# Contributing

The full contribution guide lives in
[`docs/contributing/contributing.md`](../docs/contributing/contributing.md).
This file is a brief orientation; the reference docs are the authoritative source.

## Short version

**Commits** — [Conventional Commits](https://www.conventionalcommits.org/) are
required and enforced by the `commit-msg` git hook:

- `feat:` → minor release
- `fix:` → patch release
- `feat!:` or `BREAKING CHANGE:` footer → major release
- `docs:`, `refactor:`, `test:`, `chore:` → no release

**Before you push** — the `pre-commit` hook runs ESLint and Prettier on staged
files; the `pre-push` hook runs `pnpm typecheck` and `pnpm test`. Hooks install
automatically via `pnpm install` (lefthook).

**CI gate** — the `claude-pr-review` workflow runs on every PR and is a
mandatory blocking gate. PRs require a PASS verdict to merge.

**Branch names** — `feat/<slug>` or `fix/<slug>`, branched from `main`.

**No hand-bumping versions** — `semantic-release` owns `version` in
`package.json`; never edit it manually.

See [`docs/contributing/coding-standards.md`](../docs/contributing/coding-standards.md)
for style rules, and [`docs/adr/README.md`](../docs/adr/README.md) for the
architecture decision log.
