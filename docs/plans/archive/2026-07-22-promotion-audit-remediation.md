# Promotion audit — unpromoted/unlearned lesson sweep and remediation

**Status: shipped** — single docs PR from `docs/promotion-audit-remediation`
(commit `a022a26`); durable record in
[`docs/logs/2026-07-22-promotion-audit.md`](../../logs/2026-07-22-promotion-audit.md).

## Context

The repo's feedback loop (work logs → `/promoting-work-log-lessons` → rules)
had never been audited end-to-end: were all recorded lessons actually promoted,
and did the promoted remediations actually resolve their failures? This audit
read all 64 archived plans and all 41 work logs via fan-out Explore spokes,
inventoried every durable home (rules, agents, skills, contributing docs, ADRs,
hooks/check scripts), and classified each lesson as promoted, **unpromoted**
(never landed anywhere), or **unlearned** (remediation shipped but the failure
recurred).

## Approach / Decisions

- Three exploration lanes (archived plans, work logs with recurrence tagging,
  durable-home inventory), then a 15-point targeted verification pass
  (grep/git-log evidence per candidate finding) before any classification was
  accepted; a Plan spoke then read every target file in full before drafting
  edits — which refuted three draft findings (docs-consistency-reviewer is
  read-only; knip was already a gate, only the fix-round re-run was missing;
  a sweep cadence half-existed).
- User decisions: sweep cadence hardened to **every 5 logs** (checked in
  `/writing-work-logs` Step 5); a mandatory **`Spoke incidents:`** work-log
  field; ADR-0032 rows restored in **both** trackers.
- Deliverables deliberately docs-only — no `src/`, tests, hooks code, or
  check scripts.

## Outcome

- **6 unpromoted lessons promoted**: end-to-end mechanism verify before
  documenting (both implementing SKILLs), bounded confirmation re-review after
  fix rounds (SKILLs + `subagent-dispatch.md`), knip re-run after fix rounds
  (`implementing-scripts` + `scripts.md`), `rebase --onto` for stacked branches
  (`contributing.md`), Bash-write-bypass tracking restored
  (`IMPLEMENTATION.md` + `hooks-reference.md`), sweep cadence concretized.
- **2 unlearned findings remediated**: RED-phase typecheck gate added to
  `test-author.md`/`tests.md` (previously promoted only to the GREEN spoke);
  an honest "Efficacy watch" in `subagent-context-management.md` recording
  that truncation **prevention is unproven while recovery works**, backed by
  the new per-log incident counts.
- **Lost tracking restored**: the Bash-write-bypass row promised by the
  2026-07-12 hook hardening, ADR-0032's implementation backlog, and 10 missing
  `docs/logs/README.md` index rows.
- 10 lesson bullets across 6 logs stamped `_(promoted → …)_`; verified-learned
  items recorded in the work log so the next audit doesn't re-derive them.
