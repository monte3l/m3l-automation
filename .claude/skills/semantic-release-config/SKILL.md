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
  with the previewing-releases skill (which previews the next version). Not for generic
  semantic-release questions unrelated to this repo (use the context7-mcp skill).
---

# semantic-release config (m3l-automation)

Release config lives in [`.releaserc.json`](../../../.releaserc.json); rationale is
in ADR-0011. Releases run from CI on `main` **after** `ci.yml` passes — never bump
`version` by hand, semantic-release owns it. To preview without publishing, use the
`previewing-releases` skill.

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
3. **`@semantic-release/changelog`** (`changelogTitle: "# Changelog"`) —
   writes/updates `CHANGELOG.md`, keeping the title line at the top.
4. **`@semantic-release/npm`** (`pkgRoot: packages/m3l-common`) — publishes the
   library package (not the private workspace root).
5. **`@semantic-release/github`** — creates the GitHub release.
6. **`@semantic-release-extras/verified-git-commit`** — commits the changelog
   back: `assets: ["CHANGELOG.md"]`. It replaces `@semantic-release/git` so the
   commit is created over the GitHub API and is therefore **auto-signed
   (Verified)** — required because `main` enforces "Require signed commits"
   (ADR-0016). It runs under the Monte3L Release Bot App token minted in
   `release.yml`. Caveats: it commits **one file per commit** (so we commit only
   `CHANGELOG.md`; the manifest `version` stays the `0.0.0-development` sentinel
   and is tag-derived) and can only **update a tracked file**, so `CHANGELOG.md`
   is seeded in the repo.

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

Use the `previewing-releases` skill (`npx semantic-release --dry-run --no-ci`) to see
the computed next version, type, and notes without publishing. If a push didn't
release, check the commit types since the last tag; if the version is "wrong",
check for an unintended `feat`/breaking footer.

## Full reference

For the current semantic-release configuration surface (branches, prerelease/
maintenance config, plugin lifecycle hooks, dryRun, provenance), see
[`references/semantic-release-config.md`](references/semantic-release-config.md).
