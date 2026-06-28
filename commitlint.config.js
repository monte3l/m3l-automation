/**
 * Conventional Commits, enforced on `commit-msg` via lefthook.
 *
 * `feat:` -> minor, `fix:` -> patch, `feat!:` / `BREAKING CHANGE:` -> major.
 * Other types (`docs`, `refactor`, `test`, `chore`, ...) do not release.
 * See docs/contributing/contributing.md and CLAUDE.md "Git Workflow".
 *
 * Knip's commitlint plugin only activates when `@commitlint/cli` is a
 * dependency (ADR 0008 dropped it for a custom loader), so this file and its
 * preset/types are listed under `ignore` / `ignoreDependencies` in knip.json.
 *
 * @type {import("@commitlint/types").UserConfig}
 */
export default {
  extends: ["@commitlint/config-conventional"],
};
