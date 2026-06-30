# Work log — `core/environment` submodule (2026-06-30)

This log covers the end-to-end TDD implementation of the `core/environment`
submodule in `@m3l-automation/m3l-common`, which ran through the full
`implement-submodule` hub-and-spoke pipeline: count-drift fix → contract
extraction → RED (test-author) → GREEN (submodule-implementer) → parallel
four-spoke review → must-fix round → final verify + provenance. It records what
shipped, what matched the plan, what diverged, and durable lessons for future
submodule work.

Plan of record: [`docs/plans/environment-submodule-implementation.md`](../plans/environment-submodule-implementation.md)

## Summary

**New exports (8 total):**

| Symbol                           | Kind                                                                           |
| -------------------------------- | ------------------------------------------------------------------------------ |
| `M3LExecutionEnvironment`        | static-only class: `detect()`, `detectFresh()`, `isInteractive()`              |
| `M3LEnv`                         | `const` alias for `M3LExecutionEnvironment`                                    |
| `M3LExecutionEnvironmentType`    | const-object enum + union type (7 values)                                      |
| `M3LDeploymentMode`              | const-object enum + union type (2 values)                                      |
| `M3LCredentialSource`            | const-object enum + union type (7 values)                                      |
| `M3LExecutionEnvironmentInfo`    | discriminated union type (10 readonly fields)                                  |
| `M3LEnvironmentDetectionDetails` | interface (7 readonly raw-signal fields)                                       |
| `M3LEnvironmentDetectionError`   | exported error class extending `M3LError`, `code: "ERR_ENVIRONMENT_DETECTION"` |

**Quality gates:** 98 tests (environment module) / 264 total suite — 100%
statements, branches, functions, lines. `pnpm typecheck`, `pnpm lint`,
`pnpm build`, `pnpm check:api` (snapshot unchanged), `pnpm check:provenance`,
`pnpm check:scaffold`, `pnpm knip`, `pnpm lint:md` — all clean.

**Review spoke verdicts:**

| Spoke                       | Verdict          | Must-fix items                                                                                                       |
| --------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------- |
| `code-reviewer`             | Pass after fixes | 3 must-fix: knip CI-blocker, unexported options interface, redundant null in `detectFresh()`, + missing AWS_EC2 test |
| `spec-conformance-reviewer` | Conformant       | 0 (2 doc gaps fixed in spec page by hub)                                                                             |
| `type-design-analyzer`      | Pass after fixes | 2 must-fix: `code` literal widening, `deploymentMode`/`monorepoRoot` discriminated union                             |
| `silent-failure-hunter`     | Pass after fixes | 2 must-fix: `packageJsonHasWorkspaces` swallowed EACCES/EPERM, `assertDirReadable` over-broad catch                  |

**Also completed:** implementation-status count drift fixed (2→3 of 22 for
`security`); environment row marked ✅ and prose count bumped to 4 of 22;
`docs/reference/core/environment.md` updated with `M3LEnvironmentDetectionError`
and a new "Error handling" section; provenance sidecar created and HEAD-stamped.

## What went as planned

- **Count-drift fix was quick and independent.** Both `docs/implementation-status.md` and `CLAUDE.md` were updated in a single commit before any implementation work started; `pnpm check:doc-counts` and `pnpm lint:md` passed immediately.
- **Contract extraction was thorough.** `spec-conformance-reviewer` in contract mode resolved all 10 open points (enum style, `monorepoRoot` property name, `credentialSource` property name, `M3LEnvironmentDetectionError` name and code, `canOpenBrowser`/`requiresAwsProfile` derivation rules, etc.) — these were handed verbatim to the test-author and implementer, preventing re-work.
- **RED failed for the right reason.** After fixing two infrastructure issues (see divergences), the test suite failed with `Cannot find module` — not syntax errors or wrong assertion values.
- **GREEN was clean on first pass.** The implementer delivered lint-clean, typecheck-clean code with `pnpm lint` passing (src/) and all 93 original tests green, without a re-dispatch.
- **Parallel review fan-out worked well.** All four review spokes ran concurrently and returned distinct, non-overlapping findings, confirming the hub-and-spoke separation of concerns.
- **All must-fix items applied in a single implementer dispatch.** The second implementer pass applied all 8 must-fix items (MF-1 through MF-8) and brought the suite from 93 to 98 tests with 100% coverage on the first try.
- **Provenance sidecar validated on first write.** `pnpm check:doc-provenance.mjs` returned 0 errors immediately after creation.

## What didn't go as planned, and why

### 1. `isTTY` spy failures in non-TTY environments required a test infrastructure `beforeAll`

The test-author used `vi.spyOn(process.stdout, "isTTY", "get").mockReturnValue(...)` to control TTY detection in CI/non-TTY environments. This caused 18 test failures because `process.stdout.isTTY` (and `stdin`/`stderr`) are absent as own-properties when the process is not connected to a TTY — `vi.spyOn` requires the property to exist before creating a getter spy.

The fix was a `beforeAll` block that calls `Object.defineProperty` with `{ value: false, configurable: true, writable: true }` on each stream when the property is not present. This is a one-time setup that does not affect real TTY environments.

**Why it happened:** The test-author wrote the tests in an environment where `isTTY` was present, so the spy call worked locally. The property's conditional presence is a Node.js quirk not visible from the TypeScript types (`WriteStream.isTTY: boolean` hides the absent-in-non-TTY reality).

**Fix for future:** Include the `beforeAll` isTTY setup block in the test-author prompt for any submodule that mocks TTY state. Template: `for (const stream of [process.stdout, process.stderr]) { if (!Object.prototype.hasOwnProperty.call(stream, "isTTY")) { Object.defineProperty(stream, "isTTY", { value: false, configurable: true, writable: true }); } }`.

### 2. ESM `fs` namespace non-configurable — `vi.spyOn(fs, "readdirSync")` failed

The test-author imported `* as fs from "fs"` and then used `vi.spyOn(fs, "readdirSync")` to simulate an EACCES error. In ESM, module namespace objects are non-configurable, so Vitest cannot redefine their properties — the spy call threw at runtime.

The fix was adding `vi.mock("fs", async () => { const actual = await vi.importActual<typeof fs>("fs"); return { ...actual }; })` at the top of the test file. Vitest hoists `vi.mock` above imports, making the module's exports configurable and spyable.

**Why it happened:** ESM module namespace non-configurability is a runtime property, not surfaced at test-writing time. The pattern `vi.spyOn(fs, "fn")` works in CommonJS but not in strict ESM.

**Fix for future:** Include `vi.mock("fs", ...)` factory boilerplate in the test-author prompt for any submodule that needs to spy on Node.js built-in modules. Always use `typeof <imported-namespace>` (not `typeof import("fs")`) in the generic to avoid the `@typescript-eslint/consistent-type-imports` rule.

### 3. `mockReturnValue(undefined)` caused TypeScript errors for `isTTY` getter

The test-author used `vi.spyOn(process.stdout, "isTTY", "get").mockReturnValue(undefined)` to simulate a non-TTY. This caused TypeScript error `Argument of type 'undefined' is not assignable to parameter of type 'boolean'` because `WriteStream.isTTY` is typed as `boolean` (not `boolean | undefined`), so Vitest infers the mock return type as `boolean`.

The fix was changing all `mockReturnValue(undefined)` calls to `mockReturnValue(false)` — semantically equivalent (both mean "not a TTY") and correctly typed.

**Why it happened:** The test-author modeled the non-TTY case as "the property returns `undefined`" (how Node.js works at runtime) rather than "the property returns `false`" (how the TypeScript type describes it). The TypeScript type wins for mock inference.

**Fix for future:** When mocking `isTTY`, use `mockReturnValue(false)` for non-TTY and `mockReturnValue(true)` for TTY. Never pass `undefined` — the TypeScript type is `boolean`, not `boolean | undefined`.

### 4. `packageJsonHasWorkspaces` silently swallowed EACCES/EPERM from `readFileSync`

The implementer wrote a bare `catch {}` in `packageJsonHasWorkspaces` citing OP-7 ("malformed JSON: silent skip"). This was correct for parse failures but inadvertently swallowed permission-denied errors from `readFileSync` as well. The `silent-failure-hunter` flagged this as a HIGH finding: when `package.json` exists (confirmed by `existsSync`) but is unreadable, detection silently concludes `STANDALONE` — a plausible but incorrect result with no caller-visible signal.

The fix: split the catch to distinguish permission errors (EACCES/EPERM → re-throw as `M3LEnvironmentDetectionError`) from parse/ENOENT errors (silent skip per OP-7).

**Why it happened:** OP-7 was scoped to parse failures in the contract, but the implementer applied it to the entire catch block. The contract text should have been more explicit: "catch parse errors silently; permission errors are NOT covered by OP-7."

**Fix for future:** When a contract says "swallow X silently," explicitly state "do NOT swallow Y" in the implementer prompt if Y is a different error category that could also arrive at the same catch site. Disambiguate the catch semantics at prompt time, not review time.

### 5. `assertDirReadable` over-broad catch silenced non-EACCES OS failures

The implementer wrote `assertDirReadable` to only re-throw EACCES/EPERM, silently consuming everything else (EIO, EMFILE, ENOTDIR, ELOOP). The `silent-failure-hunter` flagged this as HIGH: hardware failures and resource exhaustion errors should not be silently swallowed.

The fix: flip the logic from allowlist (re-throw EACCES/EPERM only) to denylist (swallow only ENOENT, re-throw everything else).

**Why it happened:** The implementer pattern-matched on the most common permission codes rather than reasoning about which errors are genuinely safe to ignore. "Any other error" in a catch comment often signals an over-broad assumption.

**Fix for future:** In implementer prompts for walk-up or filesystem I/O: explicitly specify the "only swallow ENOENT" rule. Provide the `IGNORABLE_DIR_ERRORS = new Set(["ENOENT"])` pattern in the prompt so the implementer uses the denylist form, not the allowlist form.

### 6. `M3LEnvironmentDetectionErrorOptions` leaked into the public API

The implementer exported `M3LEnvironmentDetectionErrorOptions` as a public interface. It was used only as the constructor parameter type and callers never construct `M3LEnvironmentDetectionError` directly — they only catch it. The code-reviewer flagged it as a must-fix: an undocumented export that enlarges the semver-bound surface.

The fix: remove the `export` keyword. The type remains visible within the module for the constructor parameter.

**Why it happened:** The implementer exported it by default since it appeared in a constructor signature. The rule "export types that consumers need" was applied without checking "do consumers construct this class?"

**Fix for future:** In implementer prompts, explicitly state: "Do not export the constructor options interface for error classes — callers catch errors, they do not construct them. The options type is module-private."

## Lessons learned

- **Include `beforeAll` isTTY setup in the test-author prompt.** `process.stdout/stderr/stdin.isTTY` are absent as own-properties in non-TTY (CI) environments. Provide the `Object.defineProperty` setup template verbatim so the test-author doesn't need to discover this.

- **ESM built-in module spying requires `vi.mock()` factory.** Add `vi.mock("fs", async () => { const actual = await vi.importActual<typeof fs>("fs"); return { ...actual }; })` boilerplate to the test-author prompt when the submodule uses Node.js built-ins and tests need to intercept specific calls. Use `typeof <imported-namespace>` in the generic, not `typeof import("fs")`.

- **`mockReturnValue(false)` not `mockReturnValue(undefined)` for boolean spies.** When mocking a property typed as `boolean`, pass `false` for the "not set" case — `undefined` is a TypeScript type error even when it is the Node.js runtime reality.

- **OP-7 "silent skip" must be scoped to parse failures, not entire catch blocks.** When the contract names a swallow rule, also name the errors that are NOT covered by it. Permission errors (EACCES/EPERM) from `readFileSync` arriving at the same catch as `JSON.parse` failures should be re-thrown consistently with `assertDirReadable`.

- **Use the denylist pattern for `assertDirReadable`, not the allowlist.** `IGNORABLE_DIR_ERRORS = new Set(["ENOENT"])` is safer than re-throwing only EACCES/EPERM. Any error not in the set propagates, so new OS codes are surfaced by default rather than silently swallowed.

- **Never export error constructor options interfaces.** Callers catch errors; they don't construct them. The options type should be module-private. State this explicitly in the implementer prompt.

- **Discriminated unions at the hub contract-phase, not the review phase.** The `deploymentMode`/`monorepoRoot` coupling was a type-design must-fix discovered in review. It should be pre-specified in the contract as "use a discriminated union on `deploymentMode`" so the implementer gets it right the first time.

- **`M3LEnvironmentDetectionError` must appear in the spec page.** Error classes exported by a module are part of its public API contract and must be listed in the `## Public API` section of the corresponding `docs/reference` page. Contract-phase open-point resolutions that add exported symbols should trigger a spec-page update (hub-owned) before or alongside GREEN.

- **`knip` duplicate-export detection fires on `const Alias = OriginalClass`.** Intentional aliases must be suppressed via `ignoreIssues` in `knip.json` with a comment. This is a CI-blocker; add the knip config entry in the implementer prompt for any module that exports a convenience alias.
