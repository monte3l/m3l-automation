# Coding Standards

> **Moved.** The code-style rules that used to live here are now part of the
> single canonical **[Style Guide](./style-guide.md)**, which covers writing new
> code, writing new tests, and refactoring existing code/tests — with every rule
> tagged `[enforced]` (a linter/type-checker/hook blocks it) vs `[advisory]`
> (needs conscious care).

Jump straight to the section you need:

- [Writing new code](./style-guide.md#part-1--writing-new-code) — strictness,
  ESM imports, exports, naming (incl. the function type-alias table), immutability,
  `interface` vs `type`, control flow, public-API typing, the `M3LError` hierarchy,
  TSDoc, the `exports` contract, complexity limits.
- [Writing new tests](./style-guide.md#part-2--writing-new-tests) — Vitest,
  the unit-only policy, Arrange–Act–Assert, `expectTypeOf`, mocking, fixtures,
  parameterization, determinism, the 80% coverage gate.
- [Refactoring existing code & tests](./style-guide.md#part-3--refactoring-existing-code--tests)
  — the test safety net, small isolated steps, opportunistic/Boy-Scout refactoring,
  scope boundaries, and the semver hazard of touching the public surface.

The deeper rationale (quality hierarchy, anti-patterns, review checklist) remains
in [`rules/01-code-quality-and-standards.md`](../../rules/01-code-quality-and-standards.md).
