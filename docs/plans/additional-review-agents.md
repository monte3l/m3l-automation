# Plan: Adopt two high-value PR-review-toolkit subagents (adapted)

## Context

The task was to audit the project's review machinery, research the
`pr-review-toolkit` Claude Code plugin (`anthropics/claude-code/plugins/pr-review-toolkit`),
and estimate the value of importing its subagents.

**Plugin roster (6 agents):** `code-reviewer`, `silent-failure-hunter`,
`type-design-analyzer`, `pr-test-analyzer`, `comment-analyzer`, `code-simplifier`.
They trigger by natural-language intent, emit confidence/severity-scored findings,
and are _generic_ — they know nothing of this repo's `M3LError` hierarchy, exports-map
semver contract, ESM `.js`-extension rule, or branded types.

**Project today** already runs a mature hub-and-spoke review pipeline: read-only
spokes `code-reviewer`, `security-reviewer`, `spec-conformance-reviewer`,
`docs-consistency-reviewer` (+ writer spokes `test-author`, `submodule-implementer`),
8 Write/Edit hooks, a blocking `claude-pr-review.yml` PASS/FAIL gate, and a 12-step CI
pipeline. So most plugin agents overlap existing capability.

**Value estimate (the deliverable):**

| Plugin agent              | Project equivalent                                    | Added value                                                                                                                                                          |
| ------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **type-design-analyzer**  | none                                                  | **HIGH** — purpose-built for a strict-TS library (no `any`, branded types, "the type IS the contract", exports-map as contract). No project agent rates type design. |
| **silent-failure-hunter** | partial (`security-reviewer`, `code-reviewer` item 3) | **HIGH** — dedicated auditor for a core CLAUDE.md rule ("never swallow errors silently", chain `cause`, `M3LError`). Today only a checklist line, no focused spoke.  |
| pr-test-analyzer          | `test-author` + 80% V8 gate                           | MODERATE — judges behavioral coverage vs %; overlaps.                                                                                                                |
| comment-analyzer          | `docs-consistency-reviewer`                           | MODERATE — TSDoc-vs-code accuracy; different altitude, partial overlap.                                                                                              |
| code-reviewer             | `code-reviewer` (richer)                              | LOW — duplicate + **name collision**; only the ≥80 confidence mechanic is worth borrowing.                                                                           |
| code-simplifier           | `code-reviewer` + `knip`                              | LOW — subjective nice-to-have.                                                                                                                                       |

**Decision (user-selected):** adopt only the two HIGH-value agents, **adapted** to
this repo's conventions and slotted into the hub-and-spoke review phase — not raw-copied.

## Approach

Author two new read-only review spokes that follow the exact house style of the
existing agents (`.claude/agents/code-reviewer.md`, `security-reviewer.md`):

- Frontmatter: `name`, `description`, `tools: Read, Grep, Glob, Bash`, `model: sonnet`.
- Open as a read-only spoke; state the writer≠reviewer separation; "start by reading
  the diff (`git diff` / `git diff --staged`) and changed files."
- Ground every finding in `CLAUDE.md` + `.claude/rules/`.
- Keep the plugin's distinctive scoring, but conform the tail to the house format:
  group findings **Must-fix / Should-fix / Nits**, cite `file:line`, end with a
  one-line verdict. Include a "What findings look like" section with `// flag` / `// good`
  TypeScript pairs drawn from this repo (M3LError, branded types).
- Draw explicit **boundaries** against existing spokes to prevent duplicate findings.

### Files to create

**1. `.claude/agents/type-design-analyzer.md`**

- Scope: type design of changed exports. Five-step method (identify invariants →
  encapsulation → invariant expression → usefulness → enforcement), preserving the
  plugin's **1–10 ratings on four dimensions** (encapsulation, invariant expression,
  invariant usefulness, invariant enforcement), each with a justification.
- Project grounding: no `any`/non-null `!` in public API; **branded types** for
  identifiers (the `UserId` pattern in CLAUDE.md §Code Style); make-illegal-states-
  unrepresentable; compile-time enforcement; `readonly`/`Page<T>` shapes; the
  `exports` map (`.`, `./core`, `./aws`) as the typed public contract.
- Boundary: rates **type design only** — defers general structure/SOLID to
  `code-reviewer`, and documented-symbol drift to `spec-conformance-reviewer`.

**2. `.claude/agents/silent-failure-hunter.md`**

- Scope: error-handling paths in the diff — empty/over-broad catch blocks, silent
  `return undefined` on error, optional chaining that masks failure, retry/poll logic
  that exhausts attempts without surfacing, unlogged swallowed errors.
- Preserve the plugin's per-issue **CRITICAL / HIGH / MEDIUM severity** + user-impact +
  corrected-code shape, then roll up into the house Must-fix/Should-fix/Nits + verdict.
- Project grounding: throws must subclass `M3LError` and chain `{ cause }`; "never throw
  bare strings; never swallow errors silently" (CLAUDE.md §Error Handling); inputs
  validated at the public boundary.
- Boundary: stays on error-handling depth — defers general quality to `code-reviewer`
  and secret-in-log/redaction concerns to `security-reviewer` (mirrors how
  `security-reviewer.md` already disclaims code-quality findings).

### Files to edit (integration — so the spokes actually run)

**3. `CLAUDE.md` — §Agent Operating Model.** Add the two new agents to the spokes
bullet list (review spokes), so the hub knows they exist. The existing writer≠reviewer
sentence already covers them.

**4. `.claude/skills/implement-submodule/SKILL.md` — Phase 4 (Review).** Extend the
review fan-out (currently `code-reviewer` + `spec-conformance-reviewer` (+
`security-reviewer`), at the table row line ~40 and checklist lines ~52–53, ~104–105):

- add `type-design-analyzer` whenever the submodule introduces public types
  (effectively every Core/AWS module), and
- add `silent-failure-hunter` whenever the submodule has error-handling/async paths.
  Keep them parallel with the other review spokes; iterate until clean.

> Out of scope: the `claude-pr-review.yml` CI gate is a single inline prompt, not a
> subagent host, so it is left unchanged. No new hooks. The plugin is not installed via
> the marketplace — we copy-and-adapt so the agents carry project context and stay
> versioned in-repo.

## Verification

1. **Lint the new docs:** `pnpm lint:md` passes for the two new agent files (they live
   under `.claude/`, which `lint:md` excludes — so also eyeball them against the style
   of `code-reviewer.md`).
2. **Frontmatter sanity:** both files have `name`/`description`/`tools`/`model` and the
   `name` matches the filename; no collision with existing agent names.
3. **Dry-run dispatch:** on a sample diff (e.g. `git show` of the `core/errors` commit),
   manually invoke each new agent via the Agent tool and confirm it (a) reads the diff,
   (b) produces ratings/severities, (c) ends with a Must-fix/Should-fix/Nits + verdict,
   and (d) does **not** restate findings owned by `code-reviewer`/`security-reviewer`.
4. **Skill wiring:** re-read `implement-submodule/SKILL.md` Phase 4 and confirm the two
   agents appear in both the table and the checklist, parallel to the others.
5. No source/test/CI behavior changes, so `pnpm typecheck`/`test`/`build` are unaffected;
   run none beyond markdown review.
