---
name: implement-submodule
description: >-
  Implement a documented-but-empty Core or AWS submodule of @m3l-automation/m3l-common
  end-to-end, from its docs/reference spec, under a strict TDD + hub-and-spoke workflow.
  Use this whenever the user asks to "implement", "build", "fill in", "flesh out", or
  "write the code for" a submodule, capability, or feature that already has a
  docs/reference/{core,aws}/<name>.md page (e.g. errors, config, polling, logging,
  importers, storage, text, aws credentials, script). Use it even when the user names
  the module casually ("let's do the retry stuff", "wire up the HTTP client") rather
  than saying "submodule". For a brand-new module that has NO spec page yet, use
  new-subpath first to scaffold, then this skill to implement.
---

# implement-submodule

This skill is the **hub playbook** for turning a `docs/reference` page into real,
reviewed, tested library code. The library is a fully-documented but empty
scaffold; each `docs/reference/{core,aws}/<module>.md` is the authoritative
contract for what its submodule must export and how it must behave.

## Operating model: you are the hub, not a worker

You (the main agent) **coordinate only**. You do **not** write `src/` code or
test code yourself, and you do **not** review code. Every substantive step runs
in an **isolated spoke subagent** with the right tool grants. This makes
"the writer is never the reviewer" a structural guarantee, not a polite request,
and keeps your context lean across what is often a long loop.

Spokes don't share memory with each other or persist between sessions, so two
things matter: pass each spoke **explicit context** (target module, the contract,
concrete file paths), and record progress in the durable state file
`docs/implementation-status.md` after every phase.

| Phase           | Spoke (subagent)                                                      | Writes      | Hand it                          |
| --------------- | --------------------------------------------------------------------- | ----------- | -------------------------------- |
| 1. Contract     | `spec-conformance-reviewer`                                           | nothing     | the doc path                     |
| 2. RED (tests)  | `test-author`                                                         | tests only  | the contract + target paths      |
| 3. GREEN (impl) | `submodule-implementer`                                               | `src/` only | the contract + the failing tests |
| 4. Review       | `code-reviewer` + `spec-conformance-reviewer` (+ `security-reviewer`) | nothing     | the diff + the doc path          |

## Steps

1. **Resolve the target.** Read `docs/implementation-status.md`, confirm the
   module and its `docs/reference/<ns>/<module>.md` spec page exist. If there is
   no spec page, stop and point the user at `new-subpath` (greenfield modules
   must be scaffolded and specced first). If the module is already ✅, ask before
   redoing it. When unsure which to pick, prefer the _Suggested implementation
   order_ in the state file (foundational, dep-free modules first).

2. **Dependency gate — pause before adding any runtime dependency.** Several
   submodules imply a runtime dep (e.g. `config` → a YAML parser, `network` →
   `undici`, `importers` → `csv-parse`, `storage` → `better-sqlite3`, `text` →
   `unpdf`/`mammoth`/…, aws → `@aws-sdk/*`). CLAUDE.md makes minimal runtime deps
   a non-negotiable constraint and the pnpm lockfile authoritative. So **stop,
   list each dependency with a one-line rationale, and wait for explicit user
   approval** before anyone runs `pnpm add`. Never hand-edit `pnpm-lock.yaml`.
   Dep-free modules skip this gate.

3. **Phase 1 — Contract.** Dispatch `spec-conformance-reviewer` in _contract
   mode_: have it read the spec page (and the relevant contracts in
   `docs/m3l-common-architecture.md`) and return the exact list of promised
   exports (names + shapes) plus the behavioral contracts (e.g. handler-error
   isolation, per-call backoff, `toJSON()` on errors, MONOREPO path anchoring).
   Keep this contract text — you'll hand it to the next two spokes.

4. **Phase 2 — RED.** Dispatch `test-author` with the contract and the target
   test path (`packages/m3l-common/tests/<module>.test.ts`). It writes happy +
   failure + `expectTypeOf` tests against the contract and confirms they **fail
   for the right reason** (the symbols don't exist yet). Update the state file:
   that module → 🧪 tests-written.

5. **Phase 3 — GREEN.** Dispatch `submodule-implementer` with the contract and
   the failing tests. It writes the minimal `src/<ns>/<module>/index.ts`
   (private helpers under `src/internal/`), re-exports from the namespace barrel
   `src/<ns>/index.ts`, and drives `pnpm test` + `pnpm typecheck` to green
   **without** touching the `exports` map. Update the state file: → 🟢 implemented.

6. **Phase 4 — Review (fan out in parallel).** In one message, dispatch
   `code-reviewer` and `spec-conformance-reviewer` (now in _conformance mode_),
   plus `security-reviewer` if the surface is security-sensitive (anything under
   `aws`, or touching secrets, credentials, deserialization, or logging). Collect
   their findings, send **Must-fix** items back to `submodule-implementer`, and
   re-run tests/review until clean. Update the state file: → ✅ reviewed/done.

7. **Final verify and report.** Run
   `pnpm -C packages/m3l-common build && pnpm test && pnpm lint && pnpm typecheck`.
   Report the new exports, the review verdict, any deps added (with approval),
   and the state-file transitions. Remind the user the commit should be a `feat:`
   (a new submodule surfaced through the barrel is a minor, not a breaking change,
   because the three-entry `exports` map is unchanged).

## What "good" looks like (hand these standards to the spokes)

These few-shot pairs encode the project's hard rules so the spokes produce code
that survives review the first time. Pass them along when the contrast matters.

**1 — ESM relative imports carry `.js` (tsc won't add it; Node won't resolve without it):**

```ts
// bad — type-checks, then fails at runtime in Node
import { M3LError } from "../errors/index";
// good
import { M3LError } from "../errors/index.js";
```

**2 — Typed errors with a cause, never bare strings (one hierarchy, chainable):**

```ts
// bad — loses the type and the underlying failure
throw `config ${name} not found`;
// good
throw new M3LConfigNotFoundError(`config ${name} not found`, { cause });
```

**3 — Named exports only (tree-shakeable, refactor-safe, matches the barrels):**

```ts
// bad
export default class M3LPoller {
  /* … */
}
// good
export class M3LPoller {
  /* … */
}
```

**4 — Test-first, not test-after (the failing test defines the contract):**

```
bad:  write src/<module>/index.ts, then backfill a test that mirrors it
good: test-author writes tests from the doc contract → they fail → implementer makes them pass
```

## Boundaries

- You never edit `src/**` or `tests/**` directly — that is what the spokes are
  for. Editing `docs/implementation-status.md` is the one bookkeeping write the
  hub owns.
- Do not add an `exports`-map entry; new submodules surface through the namespace
  barrel (adding a subpath is a semver event — see `.claude/rules/library-src.md`).
- See also `.claude/skills/new-subpath/SKILL.md` (scaffolding) and
  `docs/contributing/coding-standards.md`.
