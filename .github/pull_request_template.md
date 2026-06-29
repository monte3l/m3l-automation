## Summary

<!-- What does this PR do and why? Reference the relevant spec page or ADR if applicable. -->

## Changes

<!-- Bulleted list: name the actual symbols, files, or behaviours that changed. -->

## Test plan

- [ ] `pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm build` pass locally
- [ ] `pnpm check:api` confirms the exports map is unchanged (or semver impact is documented below)
- [ ] New or changed exports have TSDoc and tests (happy-path + failure-path)
- [ ] No `any`, no missing `.js` extensions on relative imports, no CommonJS
- [ ] PR title follows Conventional Commits (`feat:` minor · `fix:` patch · `feat!:` major · others no release)

## Notes

<!-- Migration instructions for breaking changes. ADR references. -->
