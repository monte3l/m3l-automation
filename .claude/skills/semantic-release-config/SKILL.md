---
name: semantic-release-config
description: >-
  How this repo automates releases with semantic-release — the .releaserc.json
  plugin chain, the Conventional Commits → semver mapping, and how npm/GitHub/git
  publishing is wired. Use whenever you are editing .releaserc.json, changing the
  plugin order or a plugin's options, adjusting release branches, wiring npm
  provenance, or debugging why a release did/didn't happen or landed at the wrong
  version in m3l-automation. Reach for it even when the user says "why didn't this
  release", "cut a release", "the version bump is wrong", "add a release plugin",
  or "set up the changelog" — anything touching the release pipeline here. Pairs
  with the release-dry-run skill (which previews the next version). Not for generic
  semantic-release questions unrelated to this repo (use the context7-mcp skill).
---

# semantic-release config (m3l-automation)

Release config lives in [`.releaserc.json`](../../../.releaserc.json); rationale is
in ADR-0011. Releases run from CI on `main` **after** `ci.yml` passes — never bump
`version` by hand, semantic-release owns it. To preview without publishing, use the
`release-dry-run` skill.

## When to use

Editing `.releaserc.json`, reordering/retuning plugins, changing branches, or
diagnosing a wrong/missing release.

## The plugin chain (order is the lifecycle)

Plugins run in listed order across the `analyze → generateNotes → prepare →
publish → success/fail` lifecycle, so sequence matters:

1. **`@semantic-release/commit-analyzer`** (`preset: conventionalcommits`) —
   decides the release type from commits.
2. **`@semantic-release/release-notes-generator`** (`preset: conventionalcommits`)
   — builds the notes from the same commits.
3. **`@semantic-release/changelog`** — writes/updates `CHANGELOG.md`.
4. **`@semantic-release/npm`** (`pkgRoot: packages/m3l-common`) — publishes the
   library package (not the private workspace root).
5. **`@semantic-release/github`** — creates the GitHub release.
6. **`@semantic-release/git`** — commits the release assets back:
   `assets: ["CHANGELOG.md", "packages/m3l-common/package.json"]` with message
   `chore(release): ${nextRelease.version} [skip ci]`. It runs **last** so it
   captures the changelog + bumped manifest produced by the earlier plugins.

`branches: ["main"]` — only `main` releases. A plugin is either a bare string
(default options) or a `["name", { …options }]` tuple.

## Conventional Commits → semver (why a release happens or not)

- `feat:` → **minor**, `fix:` → **patch**, `feat!:` / `BREAKING CHANGE:` footer →
  **major**.
- `docs:`, `chore:`, `refactor:`, `test:`, `style:` → **no release** (this is why a
  docs/chore-only push produces nothing). This matches the repo's commitlint rules.
- The `conventionalcommits` preset (not `angular`) governs both the bump and the
  changelog sections.

## Editing guidance

- **Keep `git` last** — it must commit the CHANGELOG and version that the
  changelog/npm steps generate.
- Configure a plugin by switching its entry from a string to a
  `["@semantic-release/x", { … }]` tuple; don't duplicate the entry.
- `pkgRoot` must stay pointed at `packages/m3l-common` — the workspace root is
  `private` and must never publish.
- **npm provenance** is produced when the CI job has `id-token: write` (OIDC
  trusted publishing) and npm publish runs with provenance enabled; it's a CI/
  workflow concern, not a `.releaserc.json` field.
- A new release branch (maintenance/prerelease) is added to `branches` with the
  appropriate `channel`/`range`/`prerelease` — see the reference file.

## Verify

Use the `release-dry-run` skill (`npx semantic-release --dry-run --no-ci`) to see
the computed next version, type, and notes without publishing. If a push didn't
release, check the commit types since the last tag; if the version is "wrong",
check for an unintended `feat`/breaking footer.

## Full reference

For the current semantic-release configuration surface (branches, prerelease/
maintenance config, plugin lifecycle hooks, dryRun, provenance), see
[`references/semantic-release-config.md`](references/semantic-release-config.md).
