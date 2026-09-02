# U10 — orchestration engine + named flow

**Date:** 2026-09-02
**Issue:** [#534](https://github.com/monte3l/m3l-automation/issues/534)
**PRs:** ten in all, listed oldest first:

- #835 — the dated design plan
- #839 — step-reference promotion to `core/orchestration`
- #856 — the `rawKeys()` config seam
- #861 — definition format, validator, loader
- #863 — exit-code classification follow-up
- #866 — execution engine, step loop, run record
- #870 — run-record numeric validation follow-up
- #872 — the `m3l flow` command, envelope, rendering
- #874 — nested-pollution screening, hash canonicalization, argv rejection
- this close-out

**Tracker:** [`../plans/IMPLEMENTATION.md`](../plans/IMPLEMENTATION.md) row U10.

## What shipped

`m3l flow list` and `m3l flow run <name> [--dry-run] [--json]`, over a new
`packages/m3l-cli/src/flow/` layer:

- **definition format** — `data/config/flows/<name>.yaml`, `name` matching the
  filename stem, unknown keys rejected at both document and step level
- **validation** — `parameters` keys must be parameters the target script
  declares; a `secret: true` parameter is rejected outright (ADR-0085)
- **execution** — spawn-first with an in-process path, branching
  (`onSuccess`/`onFailure`/`onPartial`, each `continue | stop | { goto }`), and
  a `maxStepExecutions` loop guard
- **run record** — a JSON-safe record with a canonical `definitionHash`, and a
  resume-from entry point (no `--resume` flag; that is U11)
- **surface** — the `--json` envelope composing `run/envelope.ts` once per
  step, human rendering, and `flow` as the eleventh reserved command name
- **the acceptance flow** — `data/config/flows/sqs-roundtrip.yaml`

One library seam was needed: `M3LConfigProvider.rawKeys()`, because
`getRawValue(key)` cannot answer "what did the file declare that I do not
recognise?" — the question forward-safe unknown-key rejection depends on.

## What went as planned

The reserved-name wiring, the doc gates, and the composition constraint all
behaved as the design doc predicted. `flow/envelope.ts` composes
`run/envelope.ts` rather than re-deriving a reverse exit-code map, and
`check:dup` went _down_ (3.32%) across the slice that added the most code.

## What diverged

### The row said 2 PRs; it took ten

The engine measured **395,193 reviewable chars** against `check:review-size`'s
300,000 hard ceiling — CI rejects that outright, so it could not land whole.
Split into 3a/3b/3c/3d, plus four follow-ups for review findings that arrived
after auto-merge had already landed their parent.

### The design doc's reason for keeping it whole was false

It argued an engine landed without its command wiring would trip `knip` as
unused exports. Tested: `knip` is clean, because the vitest plugin treats
`tests/**` as entries, so a module reachable only from its own tests is
reachable. The real constraint was the byte ceiling, not `knip`.

`knip` _did_ fire once — on three exported **types** in `flow/types.ts` that
only the execution slice consumed. Moving them to that slice was the right
answer anyway: they are execution-layer concepts.

### Every real defect was found by review, never by a gate

Eight defects, none detectable by any gate in this repo. All eight passed
typecheck, lint, `knip`, `check:dup`, `check:file-budget`, `check:cli-docs`,
`check:cli-scaffold` and ~1,450 tests.

| Defect                                                            | Found by                                 |
| ----------------------------------------------------------------- | ---------------------------------------- |
| machine-side I/O faults raised with a usage-class code            | PR bot                                   |
| a negative `stepExecutionCount` widened the loop guard            | PR bot                                   |
| `exitCodeName: "SUCCESS"` on a `loop-guard-exceeded` run          | local `silent-failure-hunter`            |
| the `--json` envelope shared stdout with spawned step output      | local `security-reviewer`                |
| a dangerous key nested in a parameter value was unscreened        | local `security-reviewer`                |
| `definitionHash` collided across materially different definitions | local `security-reviewer`                |
| `--dry-run=false` silently _enabled_ dry run                      | local `security-reviewer` **and** PR bot |
| surplus positionals silently dropped                              | PR bot                                   |

### Auto-merge removes the window between verdict and merge

Three PRs auto-merged the moment checks went green, twice while a spoke was
still fixing that PR's own review findings — so the fixes became follow-ups.
Drafting does not help: the review job is gated on
`github.event.pull_request.draft == false`, so a draft gets no review at all.

What worked was **front-loading**: running `code-reviewer`,
`security-reviewer` and `silent-failure-hunter` against the diff _before_
pushing the last slice. That found two Must-fix defects while they were still
cheap. The security reviewer earned its findings by executing probes against
`dist/`, not by reading — which is how it caught `stdio: "inherit"` being
passed to a spawned step under `--json`.

### A mutation test across a package boundary needs a rebuild

Deleting `__proto__` from `Core`'s `DANGEROUS_KEYS` in `src/` and running the
flow tests gave **212 passing** — which reads as "the guard is hollow". It was
not. `m3l-cli` resolves `@m3l-automation/m3l-common` through its `exports` map
to `dist/`, so the `src/` edit never reached the running tests. After
rebuilding with the mutation in place, **7 tests failed**.

A mutation test that mutates library `src/` and runs a _consumer package's_
tests proves nothing unless a build happens in between. The failure mode is
silent and it points the wrong way — it manufactures false evidence that a
working guard is vacuous.

### `validate.ts` had 164 bytes of headroom, and the fix had to grow it

The nested-key screen could not land without breaching the 25,000-byte
ceiling, and `check:file-budget` does not run until `pre-push`. Extracting was
mandatory, in the same change.

A single extraction would not have worked: pulling the branch-arm validation
into `branch.ts` leaves it importing the shared primitives back from
`validate.ts` while `validate.ts` imports `readBranch` from it — an import
cycle. Two modules were needed, with `validate-guards.ts` holding the
primitives so both depend on it one-directionally. `validate.ts` ended at
21,358 bytes.

### The reserved-name census was 10 → 11, not 9 → 10

The plan said the set grows from nine. U12's `completion` had already landed,
so it grew from ten. Grepping the member beat trusting the count — again.

### The review bot cannot run on a stale workflow file

The first review of #856 reported `failure` with **no comment on any
surface**. The cause was not the diff: #855 rewrote `claude-pr-review.yml` on
`main` after
the branch was cut, and the action requires the workflow file on the PR branch
to be byte-identical to the default branch's copy. It skipped itself, wrote no
verdict file, and the enforce step failed on `verdict: missing`. A rebase
fixed it. Any branch cut before a workflow change hits this.

## Verification beyond the unit tests

The acceptance flow was run end to end against the real entry point:

```console
$ node packages/m3l-cli/bin/m3l.mjs flow run sqs-roundtrip --dry-run
status completed  exit 0        steps 4/8
dump-queue    sqs-etl        1  0  dry-run  continue
project-body  json-etl       1  0  dry-run  continue
load-table    dynamodb-crud  1  0  dry-run  continue
replay-queue  sqs-etl        1  0  dry-run  continue
```

Four real script spawns, no AWS, 2.1s. I had reasoned from `main.ts`'s comment
("validates environment, configuration, and AWS credentials") that a dry run
would need live credentials and that the plan's CI criterion was therefore
unachievable. Executing it disproved that in one command. The reasoning was
plausible and wrong; the run was cheap.

That output also demonstrates why #872's stdout fix matters: each spawned
script printed `.env not found. Continuing without it.` — four lines that
would have landed on stdout beside a `--json` envelope before the redirect
seam existed.

Guards mutation-tested: removing `flow` from `RESERVED_CLI_NAMES` kills two
tests (including the cross-check that the three reserved-name literals stay
set-equal); reverting each of the four hardening fixes kills its own test;
renaming a parameter in the shipped acceptance flow fails its validation test.

## Known gaps carried forward

- **A secret can still reach a child's argv** via a hand-built
  `M3LCliFlowStep` literal that bypasses the validator — `buildStepArgv` has
  no descriptor knowledge, so load-time rejection is the only defence. Pinned
  by a deliberate `test.fails` that will report an XPASS the day the step
  layer learns which parameters are secret. In-repo callers only:
  `packages/m3l-cli` exports nothing.
- **[#862](https://github.com/monte3l/m3l-automation/issues/862)** — the
  no-real-filesystem-in-tests rule is marked `[enforced]`, but its
  `no-restricted-syntax` selector only matches `fs.method()` member calls, so
  a bare named-import call slips through. The `completion.test.ts` precedent
  cited in review is an artifact of that hole, not an exemption.

## Lessons

1. **A gate proves shape, not correctness.** Eight real defects passed every
   mechanical gate. The reviewers that found them were reasoning about
   behaviour — and two of the four heaviest findings came from a reviewer that
   ran probes instead of reading.
2. **Front-load review when merge is automatic.** Auto-merge means a verdict
   arrives with no window to act on it. Run the local reviewers against the
   diff before the PR exists.
3. **A cross-package mutation test needs a build between mutate and run**, or
   it fabricates evidence that a working guard is hollow.
4. **Measure a file before growing it.** A 164-byte margin turns a required
   security fix into a rebase, and the paying extraction may need to be two
   modules to stay a DAG.
5. **Run the thing before arguing about it.** One command settled a
   plausible, wrong conclusion about dry-run needing credentials.
