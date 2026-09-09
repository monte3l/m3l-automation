# Work log — dependabot-trivy-alerts (2026-09-09)

This log covers resolving all ten open security alerts requested in one
sitting — Dependabot #33–#38 and Trivy code-scanning #22–#25 — without waiting
for the next weekly Dependabot version-bump PRs. It records what shipped across
two independent PRs, a bot Should-fix round on the first, a background-job
false-completion pitfall hit twice during the session, and the durable
lessons.

## Summary

Ten alerts, three unrelated root causes, two PRs:

- **PR #1138** (`fix/nodemailer-js-yaml-advisories`, `fix(deps):` +
  `fix:` follow-up) — closed Dependabot #33/#36/#37/#38 (`nodemailer` 9.0.6,
  reached only via `mailparser`'s devDependency/optional-peer pin) by bumping
  `mailparser` to 3.9.23 (`pnpm add -D mailparser@^3.9.23` scoped to
  `m3l-common`, which pins `nodemailer` at 10.0.1), and #35 (`js-yaml` 4.3.1
  via `@commitlint/load` → `cosmiconfig@9`, no upstream fix available yet) by
  adding a range-scoped `js-yaml@>=4.0.0 <4.3.2` → `^4.3.2` override to
  `pnpm-workspace.yaml`, following the file's existing advisory-pin
  precedent. `pnpm audit --audit-level=high` went from `2 high, 4 moderate`
  to `1 moderate`. Alert #34 (`adm-zip`, moderate, no patched version exists)
  was dismissed separately as `not_used` with a reachability rationale
  against `packages/m3l-common/src/core/text/zip.ts` (uses only
  `getEntries()`/`entry.getData()` in memory; never calls the vulnerable
  `extractAllTo`/`extractEntryTo`).
- **PR #1139** (`fix/console-runtime-drop-npm`, `fix(console-server):`) —
  closed Trivy #22–#25 (`tar`, `ip-address`, `brace-expansion` — all inside
  `/usr/local/lib/node_modules/npm`) by adding
  `RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm
/usr/local/bin/npx` to the `m3l-console-server` Containerfile's runtime
  stage. The findings were in the `node:24-slim` base image's bundled npm,
  never reachable from `pnpm-workspace.yaml`'s overrides (those pin our own
  `pnpm-lock.yaml`, not the base image's bundled install) and untouched by
  `m3l-console-web`'s runtime stage (`nginx-unprivileged`, no Node). Verified
  locally with Podman 6.1.1: image builds, `node --version` still runs, npm/
  npx confirmed absent via a `node -e fs.existsSync` check, `/app` unaffected.
  Confirmed post-merge via a manual `security-audit.yml` dispatch — all four
  alerts report `fixed`.

Both PRs: `pnpm verify` (71 steps passed, 10 skipped push-only/e2e) and a
`docs-consistency-reviewer` spoke (clean, no findings) before push; both
merged squash, `CLEAN`/`MERGEABLE`. Neither touched `src/`, tests, or the
`exports` map — zero semver impact on either.

Skills used: starting-work (x2), writing-commits, creating-prs (x2),
resolving-pr-comments, syncing-docs (x3), finishing-work (x2),
writing-work-logs.

Spoke incidents: none (3 dispatches — `docs-consistency-reviewer` x2,
`code-reviewer` x1 bounded re-review — all completed cleanly on the first
turn, no truncations, no stalls, no resumes).

Compaction events: none observed.

## What went as planned

- Both PRs' `docs-consistency-reviewer` pre-push spokes came back clean —
  neither touched documentation that referenced dependency versions,
  container image contents, or CVE numbers by name.
- `pnpm sync:docs` passed all 15 steps on both branches with only the
  mechanical `docs/adr/provenance.json` re-stamp to commit (or nothing at
  all, when the changed file wasn't ADR-cited).
- `ExitWorktree({action: "remove"})` refused twice ("this session is not the
  owner") after a context gap — exactly the scenario `finishing-work`'s own
  documentation anticipates. The `keep` → `git checkout main && pull` →
  `pnpm worktree:remove` fallback worked cleanly both times with no
  investigation needed.
- The Podman-based local verification for PR #1139 (build, run, `node fs`
  existence checks) worked without any Docker-daemon workaround — Podman
  6.1.1 was available in this environment, unlike the X12 log's original
  authoring environment.
- No open error-severity CodeQL alerts existed on either branch's changed
  files, so Step 8's pre-push cross-reference was a clean no-op both times.

## What didn't go as planned, and why

### 1. A double-backgrounded shell command produced a false "completed" notification while `pnpm verify` was still running

The first `pnpm verify` dispatch used `Bash({command: "pnpm verify > log 2>&1
&\necho started", run_in_background: true})` — a trailing shell `&` _inside_
a call that was _also_ flagged `run_in_background`. The harness reported the
wrapper task "completed (exit code 0)" within seconds — that was the wrapper
shell returning immediately after backgrounding the real job, not the real
job finishing. The log file at that moment showed real, partial progress
(mid-build), which read at a glance like a truncated-but-complete run. The
actual `pnpm verify` process was still alive (confirmed via `ps -p <pid>`,
elapsed time climbing), and continued for several more minutes before
genuinely finishing.

**Why it happened:** Combining a trailing `&` with the tool's own
`run_in_background: true` double-backgrounds the command — the harness's
completion tracking attaches to the outer wrapper shell, which exits the
instant it spawns the detached child, not to the child itself.

**Fix for future:** Never combine a trailing `&` with `run_in_background:
true`. Pass the real command directly (`pnpm verify`, no `&`, no wrapper
echo) and let the tool's own backgrounding handle it — that's what let the
_second_ dispatch (a plain `git push`) report a genuine, trustworthy
completion. When a "completed" notification looks premature (a partial log
with an in-progress step, a suspiciously fast turnaround for a known
multi-minute command), verify independently with `ps -p <pid>` before
trusting it.

### 2. A `pnpm update <pkg>` (and even a filtered `pnpm --filter <pkg> update`) pulled in unrelated lockfile churn

The first two attempts to bump `mailparser` (`pnpm update mailparser`, then
`pnpm --filter @m3l-automation/m3l-common update mailparser`) both also
bumped unrelated build-tooling transitives (`postcss`, `rolldown`,
`@oxc-project/types` and several `@rolldown/binding-*` platform packages) —
packages with no relation to `mailparser`'s dependency tree. `git diff
pnpm-lock.yaml` after each attempt showed the extra churn immediately.

**Why it happened:** `pnpm update <name>` (with or without `--filter`)
triggers a full-graph re-resolution pass, not a scoped one — any other
package whose previously-locked version wasn't actually the newest one
satisfying its range gets bumped too, as a side effect of the resolver
re-running.

**Fix for future:** For a single-package security bump, use `pnpm --filter
<workspace-pkg> add -D <dep>@<range>` (an explicit add with a version)
instead of `pnpm update <dep>` — it re-resolves only that package and its
own dependency subtree, leaving unrelated packages' lockfile entries alone.
Always diff `pnpm-lock.yaml` immediately after any lockfile-touching command
and confirm the only packages that moved are the ones actually intended.

### 3. A legitimate bot Should-fix surfaced a real gap the pre-push review missed: the optional-peer floor stayed vulnerable

PR #1138's pre-push `docs-consistency-reviewer` dispatch was clean, but
`claude-pr-review.yml`'s post-push verdict (PASS) still carried one
Should-fix: `mailparser`'s `peerDependencies` range was left at `^3.9.17`
while `devDependencies` moved to `^3.9.23`. This wasn't cosmetic — a consumer
supplying their own `mailparser` at the old floor would still satisfy the
declared peer range while transitively getting the vulnerable `nodemailer`
9.0.6 the whole PR existed to fix. Resolved via `/resolving-pr-comments`:
bumped the peer range to match, re-ran a bounded `code-reviewer` re-review
(clean, confirmed non-breaking), re-ran `pnpm verify`, and pushed with an
`Acknowledged-Should-Fix:` commit footer so `should-fix-ack` passed on the
re-run.

**Why it happened:** The original plan explicitly reasoned to leave the peer
floor untouched "to avoid a semver event," without separately checking
whether that same floor undermined the security fix itself for a class of
downstream consumers (those supplying the optional peer directly). The
pre-push `docs-consistency-reviewer` dispatch was scoped to documentation
consistency, not dependency-range semantics, so it had no reason to catch
this gap.

**Fix for future:** When a security fix moves a devDependency version that
is mirrored in `peerDependencies` (or any other paired manifest range), check
whether the _lower_ paired range still permits the vulnerable transitive
before deciding to leave it alone for semver reasons — a peer-floor raise
within the same major is conventionally non-breaking, and leaving a floor
low specifically to avoid touching it can silently reopen the exact
vulnerability the PR is fixing for a subset of consumers.

### 4. `pnpm worktree:new` defaulted to a `feat/` branch prefix for bug-fix work, needing a manual rename both times

Both `pnpm worktree:new <slug>` invocations in this session created a branch
named `feat/<slug>`, even though the task was explicitly a `fix:`-type
change and the branch name requested via `starting-work` was `fix/<slug>`.
Both required a manual `git branch -m feat/<slug> fix/<slug>` immediately
after creation, before `EnterWorktree`.

**Why it happened:** `bin/worktree-new.mjs` apparently hardcodes (or
defaults to) a `feat/` prefix regardless of the task's actual `feat`/`fix`
classification, rather than accepting or inferring the prefix from the
caller.

**Fix for future:** After `pnpm worktree:new <slug>` for `fix:`-classified
work, always check the resulting branch name and rename before
`EnterWorktree` if it defaulted to `feat/`. Worth a small script fix
(`bin/worktree-new.mjs` accepting a `--kind fix` flag, or inferring from a
prefix already present in the passed slug) to remove this recurring manual
step — filed as a candidate friction item rather than fixed here, since it's
outside this task's scope.

## Lessons learned

- **Never combine a trailing shell `&` with `run_in_background: true`.**
  Double-backgrounding detaches the real job from the harness's completion
  tracking, producing a premature "completed" notification for the wrapper
  shell instead of the actual command. Verify a suspiciously fast completion
  against `ps -p <pid>` before trusting it, especially for a known
  multi-minute command like `pnpm verify` or a `git push` behind the
  pre-push hook.
- **Use `pnpm add -D <pkg>@<range>` scoped to a workspace package for a
  single-dependency security bump, not `pnpm update <pkg>`.** The latter
  re-resolves the whole graph and can silently pull in unrelated package
  bumps that inflate the PR's reviewable diff. Diff `pnpm-lock.yaml`
  immediately after any lockfile command to confirm scope.
- **A paired manifest range (dev vs. peer) that's deliberately left
  mismatched for semver reasons needs its own security check, not just a
  semver check.** Leaving a `peerDependencies` floor low to avoid a semver
  event can reopen the exact vulnerability a fix exists to close, for
  consumers who supply that optional peer themselves at the old floor.
- **A pre-push doc-consistency review and a post-push bot code review catch
  different classes of gaps — neither substitutes for the other.** The
  pre-push spoke here was clean because it was scoped to documentation, not
  dependency-range semantics; the post-push bot caught the real gap because
  it read the actual `package.json` diff. This confirms `creating-prs`'
  existing framing that the two review phases are sequential, not
  alternatives.
- **`pnpm worktree:new` currently defaults every new branch to `feat/`
  regardless of task kind — check and rename to `fix/` before `EnterWorktree`
  when the task is a bug fix.** A recurring two-command tax worth fixing in
  the script itself rather than working around indefinitely.

No lessons here were promoted into `.claude/rules/*.md` or `.claude/agents/*.md`
this round — the double-backgrounding and `pnpm update` lessons are both
tool-usage patterns for the hub session itself rather than conventions a
writer/reviewer spoke or a src/test rule would enforce, so their natural home
(if they recur) is closer to session-operating guidance than a repo rule.
Worth revisiting via `/promoting-work-log-lessons` if either recurs in a
future session.
