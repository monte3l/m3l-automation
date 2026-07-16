# Contributing to `@m3l-automation/m3l-common`

This guide is for people working **on** the library — adding features,
fixing bugs, and changing the public API. If you are _consuming_ the
package, this is not the document you want.

`@m3l-automation/m3l-common` is a TypeScript 6.x library, **ESM-only**,
targeting **Node.js 24 LTS+**, managed with `pnpm`, built with `tsc`, and
tested with `vitest`. It is an internal package, not published to npm. The
public contract is the `exports` map; treat changes to it with care.

## Environment Setup

You need Node.js 24 LTS or newer and `pnpm`.

```bash
pnpm install        # install deps from the lockfile
pnpm build          # tsc -> dist/ (ESM .js + .d.ts)
pnpm test           # run the suite once
```

A pure library needs no services to run locally. In CI, install with a
frozen lockfile so the build fails if `pnpm-lock.yaml` is out of sync:

```bash
pnpm install --frozen-lockfile
```

The lockfile is authoritative — never edit it by hand. CI's only credential
is the auto-provided `GITHUB_TOKEN`; tokens of any kind must never appear in
source, tests, or fixtures.

## Commands

These map directly to the `package.json` scripts. Use them as your
inner loop and pre-commit gate.

| Task        | Command                           |
| ----------- | --------------------------------- |
| Tests       | `pnpm test`                       |
| Watch tests | `pnpm test:watch`                 |
| Single test | `pnpm vitest run tests/x.test.ts` |
| Lint        | `pnpm lint`                       |
| Format      | `pnpm format`                     |
| Type check  | `pnpm typecheck`                  |
| Build       | `pnpm build`                      |

`test` runs `vitest run`, `typecheck` runs `tsc --noEmit`, and `build`
runs `tsc`. If you add or rename a script, keep this table in sync.

For **which check runs at which stage** (pre-commit / pre-push / CI), see the
cadence table under "## Commands" in `CLAUDE.md` — it is the single source of
truth, machine-verified against `lefthook.yml` by `pnpm check:cadence`. This
file deliberately does not repeat the per-stage mapping, to avoid the drift that
an unguarded second copy would invite.

## Repository Layout

```text
src/
  index.ts        # main entry / public barrel (re-exports Core + AWS)
  core/index.ts   # Core namespace barrel — new core submodules re-export here
  aws/index.ts    # AWS namespace barrel — new aws submodules re-export here
  <ns>/<module>/
    index.ts      # a submodule, surfaced through its namespace barrel
  internal/       # NOT exported; no "exports" entry; may change freely
dist/             # tsc output (ESM .js + .d.ts) — generated, never edit
tests/            # *.test.ts (Vitest)
```

The `exports` map exposes exactly three entries — `.`, `./core`, and
`./aws`. A new Core/AWS submodule is surfaced by re-exporting it from the
namespace barrel (`src/core/index.ts` or `src/aws/index.ts`), **not** by
adding a new `exports` entry. Adding, removing, or retyping one of the
three entries is a semver event (see ADR-0004).

## ESM and the `.js` Extension Rule

This package is ESM-only (`"type": "module"`) and there is no bundler.

- Relative imports MUST carry the `.js` extension, even though the
  source file is `.ts`. `tsc` does not add it and Node will not resolve
  the import without it.

```typescript
import { paginate } from "./util.js"; // correct
import { paginate } from "./util"; // type-checks, but fails at runtime
```

This is the most common contributor mistake: a missing extension passes
`pnpm typecheck` but throws `ERR_MODULE_NOT_FOUND` at runtime.

## Forbidden Patterns

- Never use `any` — use `unknown` and narrow.
- Never omit the `.js` extension on a relative ESM import.
- Never use a CommonJS construct (`require`, `module.exports`,
  `__dirname`); this package is ESM only.
- Never hand-edit anything in `dist/` — it is tsc-generated output. (`version`
  in `package.json` is hand-managed; change it deliberately, see ADR-0020.)
- Never add a dependency without updating the `pnpm` lockfile, and keep
  runtime dependencies minimal so the package tree-shakes cleanly.

## The `exports` Map Is the Public Contract

The `exports` map **is** the public API contract. Any of the following
is a semver event:

- Adding a subpath (new public surface) → minor (`feat:`).
- Removing or renaming a subpath → major (`feat!:`).
- Retyping an existing exported signature in a breaking way → major.

Plan these changes deliberately; they ripple out to every consumer.

### `internal/` Is Private

Everything under `src/internal/` is private. It has no `exports` entry
and may change without a major bump. Never re-export anything from
`internal/` through a public barrel — doing so silently promotes it to
the public contract.

## Testing Strategy

Tests use Vitest — pure unit tests (no network, no filesystem; mock
collaborators), a happy path plus at least one failure path per exported
function, and `expectTypeOf` where the type is the contract. The full rules,
mocking conventions, coverage gate, and refactoring discipline live in the
canonical **[Style Guide § Writing new tests](./style-guide.md#part-2--writing-new-tests)**.

## Git Workflow

### Conventional Commits

Use [Conventional Commits](https://www.conventionalcommits.org/) for readable,
consistent history (enforced by the `commit-msg` hook). The type describes the
change:

| Commit                                  | Meaning           |
| --------------------------------------- | ----------------- |
| `feat:`                                 | a new feature     |
| `fix:`                                  | a bug fix         |
| `feat!:` or a `BREAKING CHANGE:` footer | a breaking change |

Use `docs:`, `refactor:`, `test:`, and `chore:` for everything else.

```text
feat(config): add YAML config provider

fix(http): retry on transient 503 responses

feat!(errors): rename M3LError.code to M3LError.errorCode

BREAKING CHANGE: M3LError.code is now M3LError.errorCode.
```

### AI co-authorship trailer

When Claude authored or substantially assisted a commit, credit the **exact
model that ran** with a trailer:

```text
Co-Authored-By: <model name> <noreply@anthropic.com>
```

The sanctioned model names live in `bin/lib/claude-models.mjs`
(`CANONICAL_CLAUDE_MODELS`); the `commit-msg` hook rejects a Claude trailer
whose name isn't on that list. The trailer is optional (it records provenance,
not legal authorship) — but when present it must be canonical, so the per-model
commit counts in the README stay queryable from history.

### Branches and versioning

- Branch from `main`: `feat/<slug>` or `fix/<slug>`.
- The package is internal and not published to npm; `version` in
  `package.json` is hand-managed (see ADR-0020).
- Never `git push --force` to a shared branch.

### Worktrees for parallel work

Use a git worktree to work on more than one branch at once without stashing or
re-cloning. The standard flow keeps the `feat/<slug>` branch convention and puts
the worktree in a sibling directory (not nested in this checkout):

```bash
git worktree add ../m3l-automation-<slug> -b feat/<slug>
cd ../m3l-automation-<slug>
pnpm worktree:setup        # install deps + copy gitignored files (.env, …)
```

Run `worktree:setup` from inside the new worktree — it refuses to run from the
main checkout. `pnpm worktree:new <slug>` (or `--fix` for a `fix/<slug>`
branch) does both steps in one command; it branches from `origin/main`,
falling back to the local `main` if `origin/main` is absent, and validates
`<slug>` as kebab-case (lowercase letters, digits, single hyphens). Tear down
the symmetric way with `pnpm worktree:remove <slug>` (add `--force` to discard
uncommitted/untracked changes first).

A fresh worktree is a clean checkout: it has no `node_modules` and none of your
gitignored local files, which is why `pnpm worktree:setup` exists. The `.git`
directory (and therefore the lefthook hooks) is shared, so hooks work without a
re-install; `node_modules`, `dist/`, and `coverage/` are per-worktree.

When you're done, clean up merged or stale worktrees:

```bash
pnpm worktree:prune --dry-run   # preview
pnpm worktree:prune             # remove
```

Do not run repo-wide commands (`pnpm format`, `pnpm lint`, `pnpm test`) against a
worktree nested under `.claude/worktrees/`; those paths are deliberately excluded
from the tooling so a main-tree command can never rewrite another branch's files.
See ADR-0013.

`.worktreeinclude` lists the gitignored local files (`.env`, `.env.local`) that
`pnpm worktree:setup` copies. It takes **literal paths only** (no globs or
negation), relative to the repo root; entries must be gitignored. Neither
`worktree:setup` nor `pnpm check:worktree` validates the path: a `..` entry can
escape the checkout via path traversal, so avoid it; an absolute-looking entry
doesn't escape (it's joined as a relative path, landing somewhere nonsensical
inside the checkout) but is still meaningless — keep entries as plain relative
paths. It's fine to list a file that doesn't exist yet in your checkout:
`worktree:setup` silently skips it (without counting it in the "skipped"
total) and `pnpm check:worktree` warns rather than errors. Run
`pnpm check:worktree` after editing it to catch tracked-file or glob mistakes.
The native `claude --worktree` flow copies these files automatically but still
needs `pnpm install` (or `pnpm worktree:setup`) for dependencies.

Troubleshooting:

- A stale worktree that won't remove (uncommitted changes): `pnpm worktree:prune
--force`.
- A worktree whose directory you deleted by hand but `git worktree list` still
  shows: `git worktree prune`.
- `pnpm format` touched another branch's files: run the command from inside that
  worktree instead of the main tree.
- `pnpm worktree:prune` errors with "no local `main` branch found": it needs a
  local `main` to compute the merged set; check out or fetch `main` and re-run.

## Definition of Done

Before you report a change as done:

- [ ] `pnpm typecheck` passes.
- [ ] `pnpm lint` passes.
- [ ] `pnpm test` passes.
- [ ] `pnpm build` passes.
- [ ] New or changed exports have TSDoc and tests (happy path plus a
      failure path; `expectTypeOf` where the type is the contract).
- [ ] The change carries a Conventional Commit reflecting the correct
      semver impact.

## See also

- [Coding Standards](./coding-standards.md)
- [Architecture](../m3l-common-architecture.md)
