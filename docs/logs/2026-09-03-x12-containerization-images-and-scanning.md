# Work log — X12 console containerization, PR3 (2026-09-03)

This log covers the third and final PR of issue #560 (X12 — console
containerization, ADR-0071): the actual Dockerfiles, `compose.yaml`, a
scheduled Trivy scan job, and the two Dependabot `docker` ecosystem entries,
following the docs-first stance (#929) and loopback-predicate refactor
(#936) that already merged. It records what shipped, a `claude-pr-review`
bot Must-fix and two self-review rounds it took to actually get the images
building, and the tracker close-out that followed. Process narrative for
PRs 1–2 is in
[`docs/logs/2026-09-03-x12-container-stance-and-loopback-refactor.md`](2026-09-03-x12-container-stance-and-loopback-refactor.md).

Plan of record: [`docs/plans/archive/2026-09-03-x12-console-containerization.md`](../plans/archive/2026-09-03-x12-console-containerization.md)

## Summary

Files shipped across two PRs:

- **PR3 (#956)**: `packages/m3l-console-server/Dockerfile`,
  `packages/m3l-console-web/Dockerfile`, `packages/m3l-console-web/docker/default.conf`,
  `compose.yaml`, `.dockerignore` (all new); `.github/workflows/security-audit.yml`
  (new `container-scan` job), `.github/dependabot.yml` (two new `docker`
  entries), `docs/adr/0071-console-containerization-deployment.md` and
  `docs/contributing/ci-cd.md` (tense-flipped from PR1's planned language to
  landed), `packages/m3l-console-web/vite.config.ts` (stale comment fix),
  `docs/plans/archive/2026-09-03-x12-console-containerization.md` (new, plan
  archived), `docs/plans/README.md` (archive row).
- **PR4 (#969)**: `docs/ROADMAP.md` and `docs/plans/IMPLEMENTATION.md` X12
  rows flipped to Done; `pnpm sync:hub --apply` closed issue #560 and
  archived its board item.

`pnpm verify` (58 steps, 10 skipped as push-only/e2e) passed clean on every
run across both PRs. `pnpm check:review-size` measured 16,368 reviewable
chars for PR3 (soft target 75,000) and 424 for PR4. Base image digests
(`node:24-slim`, `nginxinc/nginx-unprivileged:1-alpine`) were resolved via
`WebFetch` against Docker Hub's public API (`hub.docker.com/v2/repositories/...`)
since no Docker daemon was available in the sandbox this PR was authored
in — a wrong digest fails the pull loudly (cryptographic verification)
rather than silently resolving elsewhere, which made this an acceptable way
to pin without a live `docker pull` to check against.

Skills used: creating-prs, resolving-pr-comments, finishing-work.

Spoke incidents: none (4 review dispatches — `docs-consistency-reviewer` x2,
`security-reviewer` x2 — all completed cleanly on the first turn, no
truncations, no stalls, no resumes).

Compaction events: 1 compaction (manual `/compact`) / 1 recovered via
handoff — occurred at the PR2→PR3 boundary, before this unit's own work
began; no state was lost (PR3's starting context — plan file, prior PR
numbers, the worktree-only preference — was all present after resume).

## What went as planned

- The plan's env-var names, health/ready route shapes, and origin-guard
  port-ignoring behavior (all read from source before writing the
  Dockerfiles/compose) matched what was actually implemented in PR2 — no
  surprises there.
- `pnpm verify` passed clean on the very first run of the main
  containerization commit, despite this being the repo's first-ever
  Dockerfile/compose/Trivy-workflow authoring.
- A rebase conflict in `docs/plans/README.md` (another PR had appended its
  own archive row to the same table in the interim) turned out to be pure
  prettier column-realignment noise, not a real content conflict — trivial
  to resolve by reconstructing both sides' actual row additions.
- The decision to skip adding a `bin/lib/changed-paths.mjs` predicate for
  Dockerfile/compose paths — deliberately deviating from the original plan
  bullet, in favor of the fail-open `forceAll` behavior PR1's own `ci-cd.md`
  text had already documented as the accepted cost tradeoff — held up under
  a dedicated `docs-consistency-reviewer` pass with no pushback.

## What didn't go as planned, and why

### 1. `.dockerignore` excluding `.git` broke `pnpm install` via the root `prepare` script

The `claude-pr-review` bot's Must-fix on PR3: excluding `.git` from the
Docker build context breaks `pnpm install --frozen-lockfile` in both
builder stages, because the root `package.json`'s `prepare` script
(`lefthook install && node bin/install-merge-drivers.mjs`) needs a real git
work tree and the `git` binary — neither is available (`.git` dockerignored,
`node:24-slim` ships no `git` at all).

**Why it happened:** I focused the `.dockerignore` design entirely on
secret hygiene (`.env`, `*.pem`, `.npmrc`) and applied `.git`/`node_modules`/
`dist` exclusion as generic, reflexive Docker build-context hygiene, without
tracing what the repo's own root lifecycle script actually needs at install
time.

**Fix for future:** Before excluding `.git` (or any path) from a Docker
build context in a repo with a root `prepare`/`postinstall` script, read
that script and confirm it doesn't need the excluded path or an unavailable
binary. Generic hygiene exclusions are not free in a monorepo with its own
tooling lifecycle.

### 2. The first fix for #1 introduced a worse regression, caught by a bounded re-review before the bot saw it

My first fix was `pnpm install --frozen-lockfile --ignore-scripts && pnpm
rebuild` — skip all lifecycle scripts (avoiding the failing `prepare`), then
explicitly rebuild native dependencies (reasoning that `better-sqlite3`,
approved via `pnpm-workspace.yaml`'s `allowBuilds`, needed its native build
restored). A bounded `security-reviewer` re-review, dispatched before
re-pushing, read pnpm 11.9's actual bundled source and found bare `pnpm
rebuild` (no args) _also_ targets the workspace root project and re-runs
the identical failing `prepare` hook — the "fix" would have failed exactly
the same way. It further found the premise was wrong: `better-sqlite3`
ships a prebuilt binary (`gypfile: false`) and never triggers a native
build in this repo regardless of `--ignore-scripts` — `pnpm-workspace.yaml`'s
`allowBuilds: { better-sqlite3: true }` entry is vestigial. `--ignore-scripts`
alone, no rebuild, was the correct and sufficient fix from the start.

**Why it happened:** I reasoned about pnpm's build-approval mechanism from
general knowledge of the feature rather than reading the actual `pnpm
rebuild` (no-args) code path, and didn't check `better-sqlite3`'s own
packaged metadata before assuming it needed a native compile step.

**Fix for future:** When a fix re-adds a step specifically to route around
a skipped lifecycle script, verify the assumed need first — check the
dependency's actual shipped artifacts (does a prebuilt binary already exist?
does `gypfile` say `false`?) before adding the workaround. The simpler fix
is often correct; the more "thorough-looking" one can hide a new bug.

### 3. An explanatory code comment I wrote about the Should-fix restated the bot's finding backwards

Fixing the bot's Should-fix on `security-audit.yml`'s missing
`limit-severities-for-sarif: "true"`, my first comment said the flag was
needed because severity "only applies to the exit-code decision" without
it — implying severity filtering DID apply to the exit code by default. The
same bounded re-review found the opposite, verified against
`trivy-action`'s actual `entrypoint.sh`: without the flag, `TRIVY_SEVERITY`
is unset entirely for the `sarif` format, so `severity: HIGH,CRITICAL`
bound _neither_ the SARIF output _nor_ the exit-code decision — my fix also
narrowed which severities could fail the job, not just which landed in the
SARIF file.

**Why it happened:** I paraphrased the bot's finding's conclusion without
verifying its underlying mechanism against the actual tool source before
writing it into a comment as settled fact.

**Fix for future:** A code comment explaining _why_ a review finding's fix
is needed is a claim like any other — verify the mechanism, not just the
conclusion, before committing it to a comment that will outlive the review
thread.

## Lessons learned

- **Trace root lifecycle-script dependencies before writing a
  `.dockerignore`.** Excluding `.git`, or any path a repo's own `prepare`/
  `postinstall` script touches, needs the same scrutiny as excluding a
  secret file — not just reflexive "hygiene."
- **A "restore what `--ignore-scripts` skipped" fix needs its own
  no-args-semantics check.** `pnpm rebuild` with no arguments is not scoped
  to "just dependencies" the way its name suggests — verify against the
  actual tool behavior, not the intuitive reading of the command name.
- **A bounded re-review after a Must-fix fix is not redundant — it caught a
  real regression in the fix itself, twice, before either reached the
  bot.** This confirms `creating-prs`' Step 7 guidance that the re-review
  dispatch cost is worth paying even for an infra-only, no-`src/`-touched
  PR.
- **WebFetch against a package registry's public API is a workable way to
  resolve and pin a base-image digest without a local Docker daemon** —
  cross-check the hex length locally, and trust that a wrong digest fails
  the build loudly rather than silently substituting the wrong image.
- **Verify a review finding's mechanism, not just its conclusion, before
  writing an explanatory comment based on it** — a paraphrased conclusion
  can flip the actual causality, as it did for the `limit-severities-for-sarif`
  comment above.

No lessons here were promoted into `.claude/rules/*.md` or `.claude/agents/*.md`
this round — this is the repo's first Dockerfile/compose-authoring task, so
it's not yet clear which of the above generalizes versus being specific to
this one dockerignore/pnpm-lifecycle interaction. Worth revisiting if a
second containerization task in this repo hits a similar class of issue.
