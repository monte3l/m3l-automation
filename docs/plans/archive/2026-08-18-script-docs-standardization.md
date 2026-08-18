# Script docs standardization — READMEs and reference pages

**Status: shipped** — PR #464 (`feat/script-docs-standardization`)

## Context

An audit of the 14 consumer-script documentation pairs revealed substantial
drift across README and reference pages: section sets varied between scripts,
config-table column headers were inconsistent (`Declarative \`validate:\``vs`Validation`), some scripts had standalone `## Out of scope`H2s, one was
missing its reference-page contract blockquote, one was missing two whole
sections (Operational flags, Operations at a glance), and the only machine
check verified that a`### Examples` heading existed with at least one
invocation — nothing enforced section presence/order, column header names, or
README↔reference separation. The separation of concerns was mostly clean but
unenforced, so it kept eroding.

## Approach / Decisions

**Guardrail first, then remediation** — the audited gaps were large enough that
fixing the docs without a permanent enforcement mechanism would just recreate
the same situation in the next cycle.

**Written spec** (`docs/contributing/script-docs-structure.md`): a single
source of truth for both doc shapes — 9-section README order, 9-section
reference order, ≥3-example floor that scales to each script's operation count
and complexity, standard `AWS_PROFILE` prose, `Operational flags` standard
block, `Validation`/`Required for` column rules, and the separation-of-concerns
table. json-etl is named as a sanctioned deviation (non-AWS script, richer
operation surface, retained numbered-subsection examples) and its specific
out-of-spec items are enumerated.

**New gate** (`check:script-docs`, `bin/lib/script-docs.mjs` +
`bin/check-script-docs.mjs`): enforces the spec machine-checkably — required
sections, contract blockquotes, ≥3 labelled runnable `node dist/main.js`
examples, `Operation` column header, `Validation` config-table column. Wired
into pre-push, CI, `verify-steps.mjs`, `command-catalog.mjs`, and the CLAUDE.md
cadence table so no drift layer goes unguarded.

**Template updates** (`templates/script/README.md.tmpl` and
`templates/script/docs-page.md.tmpl`): `### Operational flags` standard block,
`### Operations at a glance` (with delete-for-single-purpose note), `## Error
codes`, `Required for` column, `Validation` header — so new scripts are born
conformant.

**14-pair remediation** (hub-editable paths, not guarded):

- rds-data-sql README: missing Operational flags + Operations at a glance +
  AWS_PROFILE guidance added
- sqs-etl README: `Command` → `Operation` column header
- json-etl README: removed "and AWS credentials" from --dry-run bullet
- s3-objects README: added `delete-batch` to tagline op-list
- cloudformation-stacks README: defanged over-specific implementation detail
- 4 reference pages: `Declarative \`validate:\``→`Validation`
- 3 reference pages: standalone `## Out of scope for this iteration` H2 folded
  into `## Purpose and scope` prose
- s3-objects reference: major restructure — removed `## Origin`, added
  `Required for` column (retired separate "Operation | Requires" table), moved
  error codes to `## Error codes`, reorganized behavioral notes

## Outcome

- `pnpm check:script-docs` passes for all 14 pairs; gate wired into every
  enforcement layer
- `pnpm scaffold:script <name>` produces conformant docs immediately
- All 14 README/reference pairs now follow the canonical structure spec
- See `docs/contributing/script-docs-structure.md` for the spec and
  `docs/contributing/style-guide.md` for the broader style context
