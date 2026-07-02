# Vitest 4 — config, coverage & mocking reference snapshot

> **Provenance** — Source: Context7 `/vitest-dev/vitest` (docs at v4.1.6; repo uses
> `vitest@4.1.9` + `@vitest/coverage-v8@4.1.9`). Snapshot: 2026-07-02. The mocking
> API moves faster than the other toolchain configs — treat this snapshot as
> shorter-lived and refresh it (re-run `/skill-creator` / `ctx7 skills generate`)
> on any minor bump that touches mocking or coverage, not only majors.

Distilled current facts for editing this repo's `vitest.config.ts` and tests.

## Config shape

- `defineConfig({ test: { … } })` from `"vitest/config"`.
- `test.include` / `test.exclude` — glob arrays relative to the project root.
- Native ESM + TypeScript: no CommonJS interop layer needed.

## Coverage (v8 provider)

- `coverage.provider: "v8"` (this repo's choice; `istanbul` is the alternative).
- `coverage.include` / `coverage.exclude` match relative to root; a pattern
  without a wildcard is treated as a directory (e.g. `include: ["src"]` ≈
  `src/**`).
- `coverage.reporter` — array; `"json"` emits `coverage-final.json`, the
  authoritative per-file record. The `"text"` table **omits files at 100% on all
  metrics**, so it can hide a real gap.
- `coverage.thresholds` — `lines`, `functions`, `branches`, `statements` (numbers
  are percent floors).
- **`thresholds.perFile: true`** gates each file individually. Note: when you set
  thresholds under a **glob key** (e.g. `"src/utils/**": { … }`), `perFile` is
  **not** inherited from the top level in v4 — re-declare it inside that glob block
  if you want per-file gating there.
- `coverage.all` defaults to **false**: only files that appear in the report
  (files with ≥1 executing test) are measured. Enable `all` to force every
  matched source file into the report (including 0%-covered ones).

## Mocking API

- **`vi.mock(path, factory?)`** is **hoisted** above imports and runs first; only
  works with `import` (not `require`). The factory cannot reference file-scope
  variables due to hoisting.
- **`vi.hoisted(() => value)`** — define values that need to exist before/inside a
  hoisted mock factory.
- **`vi.doMock(path, factory?)`** — non-hoisted, registered at call time; use for
  conditional or per-test mocking.
- **Async factory + `importOriginal`** — partial mock preserving real exports:
  ```ts
  vi.mock(import("./m.js"), async (importOriginal) => {
    const mod = await importOriginal<typeof import("./m.js")>();
    return { ...mod, fn: vi.fn() };
  });
  ```
- **`{ spy: true }`** — `vi.mock("./m.js", { spy: true })` keeps the real
  implementation but wraps exports in spies for assertions.
- **`vi.spyOn(object, "method")`** — observe/override an existing method; supports
  `mockImplementation`, `mockImplementationOnce`, `mockReturnValue`, and
  assertions like `toHaveBeenCalledWith`.

## Type-level testing

- **`expectTypeOf`** — compile-time type assertions; methods include
  `toEqualTypeOf`, `toMatchTypeOf`, `.parameter(n)`, `.returns`, `.toBeCallableWith`.
  Failures surface as type errors during the run.

## Version notes

- Config/coverage/mocking shapes above hold for Vitest 4.1.x; no breaking changes
  between 4.1.6 and the repo's 4.1.9. The v4-era `perFile`-not-inherited-per-glob
  behavior is the main gotcha vs. older major versions.
