# Contributing

The full contribution guide lives in
[`docs/contributing/contributing.md`](../docs/contributing/contributing.md).
This file is a brief orientation; the reference docs are the authoritative source.

## Short version

**Commits** — [Conventional Commits](https://www.conventionalcommits.org/) are
required and enforced by the `commit-msg` git hook, for readable and consistent
history:

- `feat:` — a new feature
- `fix:` — a bug fix
- `feat!:` or a `BREAKING CHANGE:` footer — a breaking change
- `docs:`, `refactor:`, `test:`, `chore:` — everything else

**Before you push** — the `pre-commit` hook runs ESLint and Prettier on staged
files; the `pre-push` hook runs `pnpm typecheck` and `pnpm test`. Hooks install
automatically via `pnpm install` (lefthook).

**CI gate** — the `claude-pr-review` workflow runs on every PR and is a
mandatory blocking gate. PRs require a PASS verdict to merge.

**Branch names** — `feat/<slug>` or `fix/<slug>`, branched from `main`.

**Versioning** — the package is internal and not published to npm; `version`
in `package.json` is hand-managed (see
[`ADR-0020`](../docs/adr/0020-drop-release-automation.md)).

See the [`Style Guide`](../docs/contributing/style-guide.md) for how to write and
refactor code and tests (code, tests, and refactoring, each rule tagged
`[enforced]` vs `[advisory]`), and [`docs/adr/README.md`](../docs/adr/README.md)
for the architecture decision log.
