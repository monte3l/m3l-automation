# Contributing to `@m3l-automation/m3l-common`

This guide is for people working **on** the library — adding features,
fixing bugs, and changing the public API. If you are _consuming_ the
package, this is not the document you want.

`@m3l-automation/m3l-common` is a TypeScript 6.x library, **ESM-only**,
targeting **Node.js 24 LTS+**, managed with `pnpm`, built with `tsc`,
tested with `vitest`, and released with `semantic-release`. The public
contract is the `exports` map; treat changes to it with care.

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

The lockfile is authoritative — never edit it by hand. The only secrets
in this project are CI-only release tokens (`NPM_TOKEN`,
`GITHUB_TOKEN`); they load from the CI vault and must never appear in
source, tests, or fixtures.

## Commands

These map directly to the `package.json` scripts. Use them as your
inner loop and pre-commit gate.

| Task        | Command                           | When        |
| ----------- | --------------------------------- | ----------- |
| Tests       | `pnpm test`                       | pre-commit  |
| Watch tests | `pnpm test:watch`                 | iterating   |
| Single test | `pnpm vitest run tests/x.test.ts` | iterating   |
| Lint        | `pnpm lint`                       | pre-commit  |
| Format      | `pnpm format`                     | pre-commit  |
| Type check  | `pnpm typecheck`                  | pre-commit  |
| Build       | `pnpm build`                      | pre-publish |

`test` runs `vitest run`, `typecheck` runs `tsc --noEmit`, and `build`
runs `tsc`. If you add or rename a script, keep this table in sync.

## Repository Layout

```text
src/
  index.ts        # main entry / public barrel
  <subpath>/
    index.ts      # subpath entry, mapped in package.json "exports"
  internal/       # NOT exported; no "exports" entry; may change freely
dist/             # tsc output (ESM .js + .d.ts) — generated, never edit
tests/            # *.test.ts (Vitest)
```

Each public subpath needs its own `src/<path>/index.ts` **and** a
matching entry in the `package.json` `exports` map, or consumers cannot
import it.

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
- Never hand-edit the `version` field in `package.json` or anything in
  `dist/` — both are tool-owned.
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

Tests use Vitest. Test files are named `*.test.ts` and import from
`src/` using the `.js` extension (the same ESM rule applies).

- Unit tests are pure: no network, no filesystem. Mock collaborators.
- Every exported function needs a happy-path test **and** at least one
  failure-path test.
- Where the type **is** the contract, add a type-level test with
  `expectTypeOf`.

```typescript
import { expect, test } from "vitest";
import { paginate } from "../src/index.js";

test("paginate respects the limit", () => {
  expect(paginate([1, 2, 3, 4, 5], 2).items).toHaveLength(2);
});
```

## Git Workflow

### Conventional Commits drive the release

`semantic-release` reads your commit messages to compute the next
version. The commit type determines the semver bump:

| Commit                                  | Bump  |
| --------------------------------------- | ----- |
| `feat:`                                 | minor |
| `fix:`                                  | patch |
| `feat!:` or a `BREAKING CHANGE:` footer | major |

Types like `docs:`, `refactor:`, `test:`, and `chore:` do **not**
trigger a release.

```text
feat(config): add YAML config provider

fix(http): retry on transient 503 responses

feat!(errors): rename M3LError.code to M3LError.errorCode

BREAKING CHANGE: M3LError.code is now M3LError.errorCode.
```

### Branches and releases

- Branch from `main`: `feat/<slug>` or `fix/<slug>`.
- Releases are automated from `main`. **Never** bump the `version`
  field in `package.json` by hand — `semantic-release` owns it.
- Never `git push --force` to a shared branch.

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
