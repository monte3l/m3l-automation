/**
 * Conventional Commits, enforced on `commit-msg` via lefthook.
 *
 * `feat:` -> minor, `fix:` -> patch, `feat!:` / `BREAKING CHANGE:` -> major.
 * Other types (`docs`, `refactor`, `test`, `chore`, ...) do not release.
 * See docs/contributing/contributing.md and CLAUDE.md "Git Workflow".
 *
 * Knip's commitlint plugin only activates when `@commitlint/cli` is a
 * dependency (ADR 0008 dropped it for a custom loader), so knip cannot tie
 * this file to the preset and types it consumes — both are listed under
 * `ignoreDependencies` in knip.json. The file itself needs no `ignore` entry;
 * knip 6.33.0 reports one as having no effect.
 *
 * @type {import("@commitlint/types").UserConfig}
 */
export default {
  extends: ["@commitlint/config-conventional"],
};
