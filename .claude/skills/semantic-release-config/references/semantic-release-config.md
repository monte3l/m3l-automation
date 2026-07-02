# semantic-release — configuration reference snapshot

> **Provenance** — Source: Context7 `/websites/semantic-release_gitbook_io` (repo
> uses `semantic-release@25.0.5`, `@semantic-release/changelog@6.0.3`,
> `@semantic-release/git@10.0.1`). Snapshot: 2026-07-02. The GitBook docs are a
> living reference, not version-pinned; verify against v25 release notes for any
> behavioral edge case. Refresh: re-run `/skill-creator` / `ctx7 skills generate`
> on a major bump.

Distilled current facts for editing this repo's `.releaserc.json`.

## Configuration file

- `.releaserc` / `.releaserc.json` / `.releaserc.js` / `release.config.js`, or a
  `"release"` key in `package.json`. This repo uses `.releaserc.json`.
- Top-level keys: `branches`, `plugins`, `tagFormat`, `dryRun`, `ci`, plus
  global options (e.g. `preset`) that individual plugins may read.

## Plugins

- Each entry is a **string** (default options) or a **tuple**
  `["@semantic-release/name", { options }]`.
- Order defines execution across lifecycle steps:
  `verifyConditions → analyzeCommits → verifyRelease → generateNotes →
prepare → publish → addChannel → success → fail`.
- The default/typical chain: `commit-analyzer` → `release-notes-generator` →
  `changelog` → `npm` → `github` → `git`. Keep `git` last so it commits assets
  produced upstream.
- `@semantic-release/npm` — publishes to npm; honors `pkgRoot` (subdir to publish)
  and `package.json` `publishConfig.access`.
- `@semantic-release/changelog` — creates/updates a changelog file (`CHANGELOG.md`
  by default; `file` option to override).
- `@semantic-release/git` — commits release assets back to the repo; `assets` and a
  `message` template (`${nextRelease.version}`, `${nextRelease.notes}`).
- `@semantic-release/github` — GitHub release + optional `assets` to attach.

## Branches

- `branches` accepts strings or objects. Defaults include `main`/`master`.
- Branch object fields:
  - `name` (required) — git branch.
  - `channel` — dist channel/tag.
  - `range` — maintenance branches, e.g. `"1.x"`.
  - `prerelease` — `true` uses the branch name (`beta` → `1.0.0-beta.1`); a string
    sets a custom prerelease identifier.

## Commit analysis (Conventional Commits)

- `preset: "conventionalcommits"` (this repo) or `"angular"`. The preset maps
  commit types to bumps: `feat` → minor, `fix` → patch, breaking (`!` or
  `BREAKING CHANGE:` footer) → major; other types → no release.
- Scopes (`feat(auth): …`) appear in notes but do not change the bump.

## dryRun & CI

- `dryRun: true` (or `--dry-run`) computes the next version and notes **without**
  publishing, tagging, or pushing — the safe preview. `--no-ci` lets it run
  outside a CI environment.
- **npm provenance** comes from the CI workflow: grant `id-token: write` (OIDC)
  and publish with provenance enabled; it is not a `.releaserc.json` option.

## Version notes

- Config surface above is stable for semantic-release 25.x; plugin option names
  (`pkgRoot`, `assets`, `message`, `preset`) are unchanged from recent majors.
