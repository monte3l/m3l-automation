# Script documentation structure

The canonical structure for the two documents every script ships:

- `scripts/<name>/README.md` — **how to run** the script (the reader's first stop)
- `docs/reference/scripts/<name>.md` — **the contract** (config schema, steps,
  error codes, inputs/outputs)

This document is the single source of truth for section ordering, mandatory vs
optional sections, and style decisions. It is enforced by `pnpm check:script-docs`
(see §Enforcement below) and referenced from `.claude/rules/scripts.md`.

---

## README — `scripts/<name>/README.md`

**Goal:** enable any reader, regardless of technical background, to run the
script fully and correctly from this file alone, without needing to read the
contract page first.

### Section order (must appear in this sequence)

1. **`# <name>`** — H1 title matching the package name exactly.
2. **One-line purpose** — a single sentence immediately below the H1 describing
   what the script does.
3. **Contract blockquote** — verbatim:

   ```text
   > **This README covers how to run the script.** The contract — configuration
   > schema, steps, inputs/outputs — lives in the reference page:
   > [`docs/reference/scripts/<name>.md`](../../docs/reference/scripts/<name>.md).
   > Keep the two disjoint: run instructions here, contract there.
   ```

4. **`## Run`** — the two build+start commands, plus the `.env` autoload note.
5. **`### Examples`** — labelled, runnable `bash` fence (required, see §Examples).
6. **`### Operations at a glance`** — a table mapping each operation to the
   example it is demonstrated by. **Required for multi-operation scripts.**
   Omitted only for single-purpose scripts (athena-query, cloudwatch-logs-insights).
   The `Command` column header is **`Operation`** — never `Command` or `Mode`.
7. **`### Operational flags`** — the shared `--dry-run` / `--log-level` / exit-code
   block. **Required for all scripts** — copy from the fleet standard (see §Flags).
8. **`## Environment (.env)`** — the dotenv block with per-script data-isolation
   overrides. AWS scripts must include an `AWS_PROFILE` note (see §AWS_PROFILE).
   Non-AWS scripts omit all AWS text.
9. **`## Data directories`** — the standard three-row table (`config/`, `input/`,
   `output/`).

### Examples

The `### Examples` section must contain at least **three** labelled, runnable
`bash` examples in a single fenced block. Scale the number of examples to the
script's operation count and complexity — a 6-operation script typically warrants
6 examples; a 4-operation script, 4. The canonical tier labels are:

```text
# Minimal — <description of what this shows>
# Common — <description>
# Production — <description>
# Edge case — <description>
```

Additional tiers beyond four are fine when a script's complexity genuinely
warrants them; the ceiling is reviewer judgment. Examples must span the
read-only → mutating → destructive/interactive axis so the reader sees every
safety boundary the script enforces. No example may be a trivial stub — each
must show a real, runnable command a user would actually reach for.

All examples invoke `node dist/main.js` (not `pnpm start`), so the reader can
run them directly in the built `dist/` directory.

Do **not** embed full input/output data payloads in examples — those belong in
the contract page's `## Inputs and outputs` section or in fixture files.

### AWS_PROFILE guidance

For AWS scripts, include a brief prose note before the dotenv block:

```text
This script touches AWS. Set `AWS_PROFILE` (config parameter `aws.profile`)
to the local profile to use; declaring that parameter is what triggers the
library's `script.aws` provisioning seam.
```

Then include `AWS_PROFILE=my-sso-profile` as the first key in the dotenv block.

Non-AWS scripts omit this note and the `AWS_PROFILE` key entirely.

### Operational flags (standard block)

Use this standard block verbatim for the `### Operational flags` section,
adjusted for any script-specific notes:

```markdown
Every script composes through `Core.runScript` (ADR-0035), so these work uniformly:

- `--dry-run` — validate environment and configuration without running the
  script: `node dist/main.js --dry-run`.
- `--log-level=<level>` / `--debug`, or `M3L_LOG_LEVEL=<level>` / `M3L_DEBUG=1` —
  set the log severity floor (`debug`/`info`/`success`/`warning`/`error`/`fatal`).
  CLI wins over env; an unknown value fails loud.
- **Exit codes** map the failure origin: `0` success, `2` config/validation, `3`
  script-local error, `4` unhandled/unexpected. A non-zero exit always accompanies
  a logged error.
```

AWS scripts may mention "AWS credentials" in the `--dry-run` bullet; non-AWS
scripts must not (it would mislead the reader).

---

## Reference page — `docs/reference/scripts/<name>.md`

**Goal:** the exhaustive technical spec — config parameter table, step
internals, error codes, I/O contract — that the README defers to. Readers use
it as a reference lookup, not a narrative to read top-to-bottom.

### Section order (must appear in this sequence)

1. **`# <name>`** — H1 title matching the package name exactly.
2. **Tagline** — one-line description immediately below the H1.
3. **Contract blockquote** — verbatim (required for all pages):

   ```text
   > **This page is the script's contract** — configuration schema, steps, and
   > inputs/outputs. How to *run* it lives in the colocated
   > [`scripts/<name>/README.md`](../../../scripts/<name>/README.md).
   ```

4. **`## Purpose and scope`** — what the script does, for whom, and what is
   explicitly out of scope. Fold "Out of scope" content directly into this
   section's prose — do **not** create a standalone `## Out of scope` H2.
5. **`## Configuration schema`** — the `M3LConfigParameter` table (see §Config table).
6. **`## Steps`** — one row per `src/steps/` module; each step's responsibility.
   Wrapper-script pages may include a `### Step signatures` subsection
   documenting the deps-object and return type (optional; reserved for the
   four typed-operations-wrapper scripts: cloudformation-stacks, codepipeline-ops,
   ecs-ops, eks-ops).
7. **`## Error codes`** — a consolidated list of script-local error codes and
   their `M3LErrorCode` values. Required when the script defines its own code
   family; omitted only when the script relies entirely on Core codes
   (e.g. `ERR_CHECKPOINT_*`, `ERR_IMPORT_*`), in which case a prose note
   referencing `core/errors` is sufficient.
8. **`## Inputs and outputs`** — what the script reads from `M3L_INPUT_DIR` /
   config, and what it writes to `M3L_OUTPUT_DIR`.
9. **`## Command module`** — present **only** for a script that has adopted the
   optional `src/command.ts` seam (ADR-0054): the `command.ts` / `main.ts`
   split, which `context` ports are accepted but not forwarded, and the
   outcome-to-exit-code mapping. Omitted entirely for a script that has not
   adopted it.
10. **`## See also`** — cross-links; the `core/script` and ADR-0022 links must
    appear last.

### Configuration schema table

Column order and header labels are fixed:

```text
| Parameter | Type | Default | Validation | Required for | Description |
```

- **`Validation`** — always this label (never `Declarative \`validate:\``or
variations). Describes the`validate:`callback and any`configValidators`
  cross-parameter constraint.
- **`Required for`** — which operations require this parameter. Present on all
  pages where any parameter's requiredness varies by operation. When all
  parameters are unconditionally required or optional, the column may be omitted —
  but if it appears, every row must populate it or use `—` explicitly.

Do **not** encode per-operation requiredness in a separate table (e.g. an
"Operation | Requires" block). The `Required for` column is the one encoding.

---

## Separation of concerns

The split is intentional and must be maintained:

| Lives in README                                | Lives in reference page  |
| ---------------------------------------------- | ------------------------ |
| How to build and run                           | Config-parameter table   |
| Labelled runnable examples                     | Step internals           |
| Operational flags (`--dry-run`, `--log-level`) | Error codes              |
| `.env` setup                                   | I/O contract             |
| Data-directory table                           | Resume/failure semantics |

Do not duplicate content across both documents. In particular:

- Example commands are README-only.
- Config-key names and their types belong in the reference page; the README
  may name a few key parameters in prose but must defer to the contract page
  for the full table.
- Preset _schema_ (field names, inheritance) belongs in the reference page;
  how to pass a preset on the command line belongs in the README.

---

## Sanctioned deviations

### json-etl

`json-etl` is a non-AWS, pure-transform script with a significantly richer
operation surface than the typical fleet member. Its README carries a longer
shape (currently ~286 lines vs the ~80-110 fleet average) and uses numbered
example subsections rather than the single-fence four-tier shape. This deviation
is intentional and approved:

- The numbered-subsection layout is retained because each transformation mode
  (field extraction, filtering, sorting, presets, ETL combinations) warrants
  its own full example to be genuinely enabling.
- The reference page's `## Presets` section documents the preset schema; the
  README's `### Presets` section explains how to invoke a preset — these are
  complementary, not duplicated.
- `bin/lib/script-docs.mjs` exports `SCRIPT_DOCS_EXCEPTIONS` as a named set
  for future callers; the current gate runner does not consult it because
  json-etl passes all structural checks as-is — the allowlist is
  future-proofing infrastructure, not an active escape hatch today.

What is **not** a sanctioned deviation for json-etl:

- The `### Operational flags` `--dry-run` bullet must not mention "AWS credentials"
  (json-etl is non-AWS).

---

## Enforcement

`pnpm check:script-docs` (`bin/check-script-docs.mjs`) enforces this spec
machine-checkably. It is run in pre-push and CI. The gate checks:

**Per README:**

- These headings are present: `## Run`, `### Examples`, `### Operational flags`,
  `## Environment`, `## Data directories` (heading-based; ordering, H1, and
  `### Operations at a glance` are not enforced by the gate).
- Contract blockquote present.
- `### Examples` heading has ≥3 runnable `node dist/main.js` examples.
- No leftover scaffold placeholder.
- `### Operations at a glance` column header is `Operation` (not `Command`), when present.

**Per reference page:**

- These headings are present: `## Purpose and scope`, `## Configuration schema`,
  `## Steps`, `## Inputs and outputs`, `## See also` (heading-based; ordering and
  `## Error codes` are not enforced by the gate).
- Contract blockquote present.
- Config table header contains `Validation` (not `Declarative \`validate:\``).

Scaffold templates (`templates/script/README.md.tmpl` and
`templates/script/docs-page.md.tmpl`) are the canonical starting points for new
scripts; `pnpm scaffold:script <name>` generates conformant docs from them.
