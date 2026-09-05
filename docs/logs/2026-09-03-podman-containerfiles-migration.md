# Work log — podman-containerfiles migration (2026-09-03)

This log covers PR2 (`feat/podman-containerfiles`, #983) of the three-PR
Docker-ban follow-up to X12/issue #560: the actual migration of the console's
containers from Docker artifacts to Podman/Containerfile/`console-pod.yaml`,
plus the full end-to-end acceptance test the plan required — the first time
any of X12's container artifacts had ever actually been run against a live
system rather than a spike copy. It records what shipped, two self-caught
mistakes (one of them a real near-miss for the whole pnpm pipeline), the SSE
test-harness bug that briefly looked like a real defect, and the lessons for
the next migration-style PR.

Plan of record: `~/.claude/plans/on-issue-560-parsed-raccoon.md` (session-local plan file, not checked into the repo)

## Summary

- `git mv`'d both `Dockerfile`s to `Containerfile` (`packages/m3l-console-server/`,
  `packages/m3l-console-web/`), `.dockerignore`→`.containerignore`,
  `compose.yaml`→`console-pod.yaml` (rewritten from Compose into a
  Kubernetes-style `Pod` manifest for `podman kube play`), and
  `packages/m3l-console-web/docker/default.conf`→`.../container/default.conf`.
- Fully qualified both base images (`docker.io/library/node:24-slim@sha256:…`,
  `docker.io/nginxinc/nginx-unprivileged:1-alpine@sha256:…`) — Podman refuses
  to guess a registry for a short image name.
- Fixed a real, previously-uncaught defect in the server Containerfile: the
  `pnpm --prod deploy` line needed `--legacy --ignore-scripts`, or the deploy
  step fails outright on pnpm 11.9.0 (`ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE`,
  then a `better-sqlite3` `node-gyp rebuild` failure with no Python in the
  image). This bug predates Podman entirely — `docker build` would have hit
  it identically — but nobody had ever run the build to find it, because
  `compose.yaml` was never once executed since X12 shipped.
- Dropped both `HEALTHCHECK` instructions: confirmed silently ignored under
  Podman's default OCI build format, with the pod manifest's `livenessProbe`
  (`exec`, not `httpGet` — `podman kube play` translates `httpGet` into an
  in-container `curl` that `node:24-slim` doesn't ship) as the real,
  documented mechanism instead.
- New `bin/console-up.mjs` / `bin/console-down.mjs` scripts (`pnpm console:up`
  / `pnpm console:down`) wrapping `podman build` (both images) and
  `podman kube play --replace --network pasta --userns keep-id` /
  `podman kube down`. Both flags are load-bearing on this rootless host
  (PR1's spike): `--network pasta` because the default netavark backend needs
  an absent `nft` binary, `--userns keep-id` because rootless Podman does not
  map container uid 1000 to the host uid by default, which otherwise leaves
  the `./data` hostPath owned wrong and the server fails to boot.
- `.github/workflows/security-audit.yml`'s `container-scan` job: `docker
build` → `podman build`, plus a new `podman save -o <image>.tar` step, with
  `trivy-action` switched from `image:` to `input: <image>.tar` (Trivy can
  only reach a Podman-built image via a saved tarball or `podman.sock`).
- `knip.json`'s `ignoreBinaries` gained `"podman"` (a real new system-binary
  dependency, same precedent as the existing `"mkfifo"` entry).
- Ran the full acceptance test from the plan against the actual committed
  files (not the PR1 spike's scratch copies): `/health`/`/ready` both 200
  through nginx, port 8787 unreachable from the host, both containers
  non-root (uid 1000 / uid 101), a real `SIGTERM` drain showing `/ready`
  returning `503 {"status":"draining"}` for the full grace window then exit
  code 0, SQLite persistence across `console:down`/`console:up` with correct
  ownership via `--userns keep-id`, and — the one gap PR1's spike explicitly
  left open — a live SSE run-stream test (see divergence #3).
- `pnpm verify` and `pnpm knip` both passed clean before push.
  `docs-consistency-reviewer` (not `code-reviewer` — no `packages/*/src` or
  `scripts/*/src` files changed) returned one Should-fix, addressed before
  merge (see divergence #4).
- Post-merge, `git fetch --prune` during the PR2 close-out (this session)
  showed two live Dependabot PRs already open —
  `dependabot/docker/packages/m3l-console-server/library/node-26-slim` and
  the `m3l-console-web` counterpart — empirically confirming the plan's one
  item that could only be verified after the PR was open: Dependabot's
  `docker` ecosystem block does resolve `Containerfile`, not just `Dockerfile`.
- Skills used: `starting-work`, `finishing-work` (once for PR1's close-out,
  once for this PR2's close-out), `creating-prs`, `writing-work-logs`. No
  plan-mode entry occurred in this segment — plan mode was used earlier, in a
  prior session, to produce the plan itself.
- Spoke incidents: none (`tmp/session-incidents.jsonl` absent this session;
  no writer truncation, review stall, or `SendMessage` resume observed).
- Compaction events: 1 compaction (mid-session, after PR2 was already open
  and confirmed mergeable) / recovered via handoff — the
  `PreCompact`/`SessionStart(compact)` summary correctly carried forward the
  PR #983 state, the pending PR3 scope, and the plan reference; nothing
  identifiable was lost.

## What went as planned

- **PR1's spike findings all transferred cleanly.** Every flag and fix PR1's
  throwaway spike had already confirmed (`--legacy --ignore-scripts`,
  `docker.io/` qualification, `--network pasta`, `--userns keep-id`, `exec`
  over `httpGet` probes) worked identically against the real committed files
  with zero re-discovery needed — the spike-before-migrate structure paid off
  exactly as intended.
- **`pnpm verify` and `pnpm knip` were clean on the first full run** after the
  `better-sqlite3` fix (divergence #2) — no re-dispatch needed once that was
  corrected.
- **The health/ready/non-root/drain/persistence acceptance items all matched
  PR1's spike results exactly** — no new surprises in the parts already
  spiked once.
- **`docs-consistency-reviewer` correctly routed** (no `src/**` changes in
  this diff) and its one finding was addressed using the repo's existing
  ADR-annotation convention (a `> **Superseded (date).**` pointer) rather
  than rewriting historical prose — matching prior ADR-update practice.

## What didn't go as planned, and why

### 1. Unrequested `CMD` line added to the web Containerfile, self-caught

While rewriting `packages/m3l-console-web/Containerfile`, I added
`CMD ["nginx", "-g", "daemon off;"]` — not present in the original file,
which relies on the base image's own default entrypoint/CMD. I caught it on
review before it was committed and removed it via a follow-up edit.

**Why it happened:** Habit from writing plain Dockerfiles from scratch, where
an explicit `CMD` is often added defensively even when redundant.

**Fix for future:** When rewriting (not authoring from scratch) a
Containerfile during a rename/migration task, diff the new file against the
original line-by-line before considering it done, specifically checking for
additions that weren't in the source — not just checking that nothing needed
was removed.

### 2. `pnpm-workspace.yaml`'s `allowBuilds.better-sqlite3` removed on an unverified plan claim, then restored

The plan carried a claim from PR1's spike that
`allowBuilds: { better-sqlite3: true }` was "vestigial" (the package ships a
prebuilt binary, `gypfile: false`, so pnpm supposedly never needs to run its
install script). Acting on that claim, I removed the entry. A subsequent
`pnpm verify` run showed the file had changed unexpectedly on disk — pnpm
itself had auto-inserted a placeholder `better-sqlite3: set this to true or
false` — and the verify log showed the real cause:
`[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: better-sqlite3@13.0.3` on
pnpm 11.9.0. This is not cosmetic: it would have broken every plain `pnpm
install` in the repo, including CI's own `pnpm install --frozen-lockfile`
step, which carries no `--ignore-scripts`. I restored the entry, confirmed
with a clean `pnpm install --frozen-lockfile`, and documented the correction
honestly in the commit message.

**Why it happened:** pnpm 11.9.0 gates on script-run _approval_ for any
dependency with a registered install/postinstall script, independent of
whether that script would actually perform a native compile. The plan's
claim was based on the _compile_ question (`gypfile: false`) and never
re-verified the _approval-gate_ question against this exact pnpm version —
an authored claim that had rotted (or was never fully correct) between the
plan being written and this PR executing it.

**Fix for future:** Treat every claim in a plan about a specific tool's
current behavior (a pnpm flag, a CLI's exit code, a config key's necessity)
as something to re-verify against the live toolchain before acting on it in
implementation — CLAUDE.md's "re-derive any authored claim you're about to
act on" principle applies just as much to a plan's own findings as to an
older ADR's census.

### 3. SSE test showed zero events; root-caused as a test-harness bug, not a real defect

The one acceptance-test item PR1's spike had explicitly left open — a live
SSE run-stream test — initially appeared to fail: the client showed zero
`run.line` events despite nginx's access log proving real response bytes had
been delivered. Rather than reporting this as a proxy/server defect, I
compared byte counts and read the actual route-handler source
(`run-stream.ts`'s `openActiveStream`) to understand the expected framing,
then found the bug was in my own throwaway test script: a
`Promise.race([reader.read(), timeoutPromise])` polling loop leaves a prior
`reader.read()` call pending when the timeout branch wins an iteration, then
issues a _new_ `read()` next iteration — real chunks were being consumed by
these abandoned, never-logged promises. Rewriting the test as a plain
sequential `while (true) { const {value, done} = await reader.read(); ... }`
loop immediately showed correct live events, working abort-on-disconnect,
and working `last-event-id` resume.

**Why it happened:** A `Promise.race` against a timeout is a natural-looking
way to add a bounded wait to a streaming read loop, but it silently
orphans whichever promise loses the race — for a `ReadableStreamDefaultReader`,
that orphaned promise still eventually resolves and consumes a chunk that the
loop's next iteration never sees.

**Fix for future:** For any ad hoc SSE/stream test harness, use a plain
sequential `while (true) { await reader.read() }` loop with `AbortSignal`
for cancellation, never `Promise.race` against a timeout on the same reader
— and check `value` before checking `done`, since a final chunk can arrive
bundled with `done: true`.

### 4. `docs-consistency-reviewer` flagged ADR-0071's dated Update section as inaccurate post-rename

ADR-0071's "Update (2026-09-03) — X12's networking and image choices" section
still named `Dockerfile`, `compose.yaml`, and `docker/default.conf` — accurate
when written, stale after this PR's renames. Rather than rewriting that
section's prose (which would erase the historical record of what X12 actually
shipped), I added a `> **Superseded (2026-09-03).**` blockquote pointing to
ADR-0091 and the newer "Docker banned; Podman is the engine" Update, following
this repo's established convention that dated ADR sections are never rewritten
in place.

**Why it happened:** A rename touching paths named in an earlier ADR update
is easy to miss unless the doc-consistency review pass specifically checks
cross-references, since the rename itself lives entirely outside `docs/adr/`.

**Fix for future:** When a PR renames files that an earlier dated ADR Update
names explicitly, grep `docs/adr/` for the old names as part of the PR's own
diff review, not just as something a downstream reviewer might catch.

### 5. Accidental `rm -rf data` deleted tracked root-level fixtures, caught immediately

Intending to clean up only the console's own runtime scratch directory
(`data/console/`, created by the live container test), I ran `rm -rf data`
from the repo root, which deleted the entire `data/` directory — including
pre-existing tracked fixtures (`data/config/flows/sqs-roundtrip.yaml`,
`data/input/agent-policy.json`, etc.) unrelated to the test. The next
`git status --short` immediately showed these as deletions; `git checkout --
data/` restored them fully before anything was committed.

**Why it happened:** `data/` at the workspace root is the MONOREPO-mode
anchor (per CLAUDE.md) shared by the whole repo, not a test-local scratch
directory — a container test writing under it needs its own subdirectory
cleaned up specifically, never the parent wiped wholesale.

**Fix for future:** Never `rm -rf` a shared, tracked top-level directory to
clean up a test artifact living inside it — target the specific subdirectory
the test created (`rm -rf data/console`), or check `git status --porcelain
data/` first to confirm nothing tracked would be caught by the deletion.
_(promoted → CLAUDE.md § Forbidden Patterns)_

## Lessons learned

- **Re-verify a plan's own tool-behavior claims before acting on them.** A
  plan's spike findings are not exempt from CLAUDE.md's "re-derive any
  authored claim" rule — the `better-sqlite3` `allowBuilds` claim (divergence
  #2) came from the plan itself, not an old ADR, and was still stale/wrong
  against the exact pnpm version in use.
- **Diff a rewritten Containerfile against its original before calling it
  done**, not just against a mental checklist of required changes — an
  unrequested addition (divergence #1) is as easy to introduce as a missed
  requirement.
- **For ad hoc stream test harnesses, use a plain sequential read loop, never
  `Promise.race` against a timeout on the same reader** — the orphaned-promise
  failure mode (divergence #3) looks exactly like a real server/proxy defect
  until the test code itself is read closely.
- **A rename that touches paths named in an earlier dated ADR Update needs a
  grep of `docs/adr/` as part of the PR's own review**, not just reliance on
  a downstream consistency reviewer to catch it (divergence #4).
- **Never `rm -rf` a shared top-level directory to clean up one test's
  scratch output** — target the specific subdirectory, or check
  `git status --porcelain <dir>` first (divergence #5).
- **Spike-before-migrate continues to pay off.** Every flag and fix PR1's
  throwaway spike had already confirmed transferred to the real migration
  with zero re-discovery — worth repeating as the default shape for any
  future infrastructure-migration PR in this repo.
