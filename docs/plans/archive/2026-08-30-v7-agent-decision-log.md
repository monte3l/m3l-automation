# V7 — agent decision log (ADR-0061)

**Status: shipped** — PRs #745, #748, #754, #756. Closes issue #544.
Work log: [`docs/logs/2026-08-30-v7-agent-decision-log.md`](../../logs/2026-08-30-v7-agent-decision-log.md).

## Context

ADR-0060's policy layer (V6) decides whether an agent action is
`auto-approved` / `escalate` / `denied` but writes nothing anywhere, so the
programme's autonomy claim was unreviewable: the CLI history is a 100-entry
overwrite-on-cap ring buffer, and `run-report.json` is an ADR-0035 _sensitive_
crash-dump artifact that only exists when a run happened. Denied and escalated
actions — the audit trail's most important entries — left no trace at all.

Three of the issue's inherited claims were refuted against repo state before
planning, and the plan was written around the corrections:

- ADR-0061 said `data/agent-log/` was "gitignored like all `data/`". It was
  not — `.gitignore` covered only `data/output/*` and `data/console/`.
- ADR-0061 and `docs/reference/core/agent.md:1451` said the log would co-land
  in `core/agent`, while `agent.md:23` claimed "The module is pure: it performs
  no I/O". Both could not hold; the purity claim was rescoped to the evaluator.
- ADR-0061 wanted token/cost figures from ADR-0059's accounting. ADR-0009
  zone 3b bans `core/**` → `aws/**`, so `M3LBedrockTokenUsage` is unreachable.
  The entry carries plain structural numbers instead, as
  `M3LAgentRunLedger.tokensThisRun` already does.

## Approach / decisions

Four PRs, smallest reviewable slices first (ADR-0072):

| PR     | Scope                                                                                 |
| ------ | ------------------------------------------------------------------------------------- |
| `#745` | Docs-only repair of five stale `To Do` cells and one stale X4 cross-reference         |
| `#748` | Entry schema, pure projector, JSONL serializer — no I/O, so purity survived the slice |
| `#754` | Append-only segmented writer, rotation, loud write failure, step-3b escalation        |
| `#756` | Serialization hardening after a security review returned FAIL on `#754`               |

Decisions that shaped the surface:

- **The evaluator stays pure and synchronous.** Log health is caller-observed
  and handed back on `M3LAgentRunLedger`, following the budgets and
  dry-run-first idiom rather than probing the filesystem — a probe from a pure
  function is impossible, and would be a TOCTOU lie regardless.
- **The escalation is opt-in** via a strict-`true` `requireDecisionLog`.
  Ungated, the new rule would have escalated for every existing caller that
  never passes the new ledger field — a behavioural break shipped as an
  additive minor.
- **Step 3b sits above the whole `switch`**, so one site covers the read-only
  auto-approval arm at step 4 and the graded-mutation arm at step 7. It
  deliberately supersedes the escalate arms too; the verdict is `escalate`
  either way, and moving it below the grading arms would need two call sites.
- **Caller-input violations reuse `ERR_INVALID_ARGUMENT`** rather than minting
  a second error class, keeping `core/agent` at 36 barrel-surfaced symbols with
  `check:api` unmoved.

## Outcome

`core/agent` 24 → 36 symbols, `M3LAgentPolicyRuleId` 20 → 22, agent suite
640 → 866 tests across nine files, reference index 781 → 801 symbols.

The review record is the part worth keeping. A four-spoke fan-out cleared
slice 1, after which the PR bot found three defects across three consecutive
rounds — all one class, a caller-supplied field read and copied without
validation. Slice 2 repeated it at higher severity: `#754` merged green, and a
`security-reviewer` running probes against `dist/` then showed that an
**inherited** `toJSON` made a frozen, projector-built `escalate` entry persist
as `auto-approved`, and that the slice-2 remediation had itself turned a loud
throw into a silently written corrupt line. `#756` fixed both by serializing a
library-built null-prototype projection instead of the caller's object.

`.claude/rules/library-src.md` already carried the rule that would have
prevented it, written up from A4 — including the near-exact sentence about
moving `JSON.stringify` across a guard turning a loud failure silent. The rule
was filed under `core/checkpoint`'s call sites and nobody grepped for the
mechanism. That is the durable lesson, and it is now recorded in the rule
itself alongside the two facts A4 did not cover: `Object.freeze` does not stop
an inherited `toJSON`, and `JSON.stringify` is typed `string` yet returns
`undefined`.
