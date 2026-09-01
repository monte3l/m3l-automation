# Contributing to `@m3l-automation/m3l-common`

This guide is for people working **on** the library — adding features,
fixing bugs, and changing the public API. If you are _consuming_ the
package, this is not the document you want.

`@m3l-automation/m3l-common` is a TypeScript 6.x library, **ESM-only**,
targeting **Node.js 24 LTS+** (developed and CI-tested on exactly the
`.node-version` major), managed with `pnpm`, built with `tsc`, and
tested with `vitest`. It is an internal package, not published to npm. The
public contract is the `exports` map; treat changes to it with care.

## Environment Setup

You need **exactly the Node major pinned in `.node-version`** (24) and
`pnpm`. `.node-version` is the single authority for the development and CI
runtime — CI provisions from it (`node-version-file: .node-version`), and
`pnpm check:node-version` fails if any `engines.node` floor or workflow has
drifted from it. Note the deliberate asymmetry: `engines.node` stays `">=24"`
because that is the _consumer_ contract, so a green `typecheck` on a newer
Node does not prove the code runs on the floor. Develop on the pin.

`fnm` is the version manager this repo assumes, because Homebrew's `node`
formula tracks the newest major (other CLIs depend on it) and cannot be pinned
to 24 without breaking them. `fnm` switches per-directory instead:

```bash
brew install fnm
fnm install 24                                  # the .node-version major
eval "$(fnm env --use-on-cd --shell zsh)"       # add to your shell rc
```

`--use-on-cd` is what makes `.node-version` take effect on entering the repo,
leaving Homebrew's `node` free to stay on the newest major. `nvm` and `mise`
read the same file if you already use one. Rationale: ADR-0003's 2026-08-31
amendment.

```bash
pnpm install        # install deps from the lockfile (+ lefthook hooks)
pnpm build          # tsc -> dist/ (ESM .js + .d.ts)
pnpm test           # run the suite once
```

There is no `corepack enable` step: pnpm self-manages from the
`packageManager` field, and Corepack is not used in CI either (see ADR-0001's
2026-08-31 update).

**Hardware:** 16 GB RAM is the recommended floor for one Claude Code session
doing normal TDD work in this repo — `git push` alone fans `lefthook`'s
`pre-push` out to 13 parallel lanes (`test:coverage`, a 19-package `turbo
run typecheck`/`build`, and 8 further `check:*` gates), plausibly 30+ Node
processes at once with no default heap cap. Running 2+ concurrent sessions
needs the mitigations in `docs/contributing/host-resources.md`
(ADR-0080) in place first — without them, a memory-constrained host can
livelock rather than fail cleanly. Run `pnpm check:host-resources` to see
what's missing on your machine; this is repo-measured guidance, not an
Anthropic-documented requirement (the only official floor is "4 GB+ RAM").

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

Plan these changes deliberately; they ripple out to every consumer. In
practice, a _new subpath_ is rarely the right shape: ADR-0004 keeps the map
at three namespace entries (`.`, `./core`, `./aws`) plus, as of its dated
Update, one narrow exception — `./core/errors`, a leaf whose transitive
import graph is machine-proven free of `node:`/third-party imports
(`pnpm check:browser-safe-subpath`), admitted because a browser-target
package (`m3l-console-web`) needed a real value import it could not reach
any other way. A new submodule still surfaces through the namespace barrel,
not a new subpath, unless it clears both of that exception's conditions.

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
- When branch B is stacked on unmerged branch A and A lands via **squash
  merge**, a plain `git rebase main` replays A's already-merged commits and
  conflicts; use `git rebase --onto origin/main <A> <B>` to transplant only
  B's own commits. Used three times without conflict in the ADR-0030 tooling
  program (`docs/logs/2026-07-17-adr-0030-workflow-tooling-mcp.md`).

### PR size (ADR-0072)

Prefer several small, independently reviewable PRs over a few large ones — a
large PR is harder to review well and harder to recover from when review does
not converge (`core/procedure`/B2, #523: five review rounds, ~$12.75 of gate
spend, abandoned). `MAX_REVIEWABLE_BYTES` (300,000 chars,
`claude-pr-review.yml`) is a hard rejection ceiling, not an authoring target;
75,000 reviewable chars is the soft target `pnpm check:review-size` checks
locally before a PR is opened (`creating-prs` runs it). Preferred split axes,
in order: **docs vs. code** first — a markdown-only slice measures ~0
reviewable chars and reviews for free — then **path cluster**, then **commit
boundary**, then (library work) a **public-surface subset**. When a PR
sequence spans several units, `starting-work` recommends the order and each
slice's branch up front; the stacked-branch pattern above is how consecutive
slices land as separate PRs before the previous one merges.

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

To investigate or audit an existing branch — an abandoned or in-review branch
you don't intend to develop on — without a raw manual `git worktree add
--detach`, use `--from <ref>` instead of branching from main:

```bash
pnpm worktree:new <slug> --from origin/feat/some-existing-branch
```

This checks out `<ref>` as a detached-HEAD worktree at
`../m3l-automation-<slug>` and provisions it the same way. `--from` is
mutually exclusive with `--fix` (there's no new branch to prefix). Tear down
the same way, with `pnpm worktree:remove <slug>` — it already handles a
detached worktree correctly (there's no branch to delete).

A fresh worktree is a clean checkout: it has no `node_modules` and none of your
gitignored local files, which is why `pnpm worktree:setup` exists. The `.git`
directory (and therefore the lefthook hooks) is shared, so hooks work without a
re-install; `node_modules`, `dist/`, and `coverage/` are per-worktree.

When you're done, clean up merged or stale worktrees:

```bash
pnpm worktree:prune --dry-run   # preview
pnpm worktree:prune             # remove
```

A worktree is a removal candidate when its branch is merged into `main` by
ancestry, its upstream reports `[gone]` (the marker left after a PR is
squash-, rebase-, or merge-commit merged and GitHub auto-deletes the remote
branch — the common case here, since ancestry alone misses squash and rebase
merges), a `--from <ref>` detached worktree whose HEAD is itself merged, or
git reports it `prunable` (its directory is gone). Each candidate's listing
names which of these matched. `worktree:prune` refreshes remote-tracking refs
first (`git fetch --prune`) so the `[gone]` signal is current; pass
`--no-fetch` to skip that for offline use (a failed fetch degrades to a
warning, not a hard failure). See ADR-0014's 2026-08-25 amendment.

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
- [ ] The branch is **pushed**. An unpushed commit is unreviewed work — no
      gate has run on it, however confident its message. Landing an orphaned
      branch is an implementation task with a full gate loop, not a merge
      formality.
- [ ] A new exported symbol has an **importer**. No gate asserts that an
      exported port is imported anywhere, so a whole layer can pass every
      check in the repo with zero production consumers. "The slices merged"
      and "the tracker row is done" are different claims, and only the first
      is machine-checked.

## See also

- [Filing work](./filing-work.md) — where an idea starts and how it becomes a
  tracked issue, before you get here
- [Coding Standards](./coding-standards.md)
- [Architecture](../m3l-common-architecture.md)
