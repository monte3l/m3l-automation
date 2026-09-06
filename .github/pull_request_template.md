## Summary

<!-- What does this PR do and why? Reference the relevant spec page or ADR if applicable. -->

## Changes

<!-- Bulleted list: name the actual symbols, files, or behaviours that changed. -->

## Test plan

- [ ] `pnpm lint && pnpm typecheck && pnpm turbo run build --filter=@m3l-automation/m3l-cli && pnpm test:coverage && pnpm build` pass locally
- [ ] `pnpm check:api` confirms the exports map is unchanged (or semver impact is documented below)
- [ ] New or changed exports have TSDoc and tests (happy-path + failure-path)
- [ ] No `any`, no missing `.js` extensions on relative imports, no CommonJS
- [ ] PR title follows Conventional Commits (`feat:` minor · `fix:` patch · `feat!:` major · others no release)

## ADR review checklist (skip if this PR adds no `docs/adr/*.md` file)

- [ ] Meets a `docs/adr/README.md` "When to write an ADR" criterion — if the
      honest answer is "we'd just change it and move on," a
      [decision note](/docs/decision-notes/README.md) fits better (ADR-0095)
- [ ] `pnpm check:adr-worthiness` reviewed — a flag isn't a block, but read it
- [ ] `Status:`/`Relations:` follow ADR-0094's schema; every `Relations:`
      entry is reciprocated on the other ADR (`pnpm check:adr-index`)
- [ ] A `partially-supersedes`/`partially-superseded-by` entry names its
      clauses on both sides
- [ ] Any file citation the ADR makes resolves on disk
      (`pnpm gen:adr-provenance && pnpm check:adr-provenance`)

## Notes

<!-- Migration instructions for breaking changes. ADR references. -->
