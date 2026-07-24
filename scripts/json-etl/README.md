# json-etl

JSON and NDJSON file ETL: extract fields, filter records, export to json, jsonl, csv, or html

> **This README covers how to run the script.** The contract — configuration
> schema, steps, inputs/outputs — lives in the reference page:
> [`docs/reference/scripts/json-etl.md`](../../docs/reference/scripts/json-etl.md).
> Keep the two disjoint: run instructions here, contract there.

## Run

```bash
pnpm build                                        # library first (turbo orders it)
pnpm --filter @m3l-automation/json-etl start
```

`start` runs `node --env-file-if-exists=.env dist/main.js`, so a local
`scripts/json-etl/.env` is loaded automatically when present. Pass the
per-run configuration on the command line (or via a preset — see below):

```bash
# Extract three fields, drop archived records, sort by id, write ordered CSV.
# (STRING_ARRAY params like --fields / --filters are comma-separated.)
node dist/main.js \
  --input records.ndjson \
  --fields "id=id,name=metadata.name,status=status" \
  --filters "status ne archived" \
  --sort id:asc --limit 1000 \
  --format csv --output report.csv
```

Reads `records.ndjson` from `M3L_INPUT_DIR`, writes `report.csv` to
`M3L_OUTPUT_DIR`. Malformed JSONL lines are skipped, counted, and logged (a
malformed whole-document JSON array instead aborts the run). See the
[contract page](../../docs/reference/scripts/json-etl.md) for the full config
schema and semantics.

### Operational flags

Every script composes through `Core.runScript` (ADR-0035), so these work uniformly:

- `--dry-run` — validate environment, configuration, and AWS credentials
  (pipeline stages 1–5) without running the script: `node dist/main.js --dry-run`.
- `--log-level=<level>` / `--debug`, or `M3L_LOG_LEVEL=<level>` / `M3L_DEBUG=1` —
  set the log severity floor (`debug`/`info`/`success`/`warning`/`error`/`fatal`).
  CLI wins over env; an unknown value fails loud.
- **Exit codes** map the failure origin for schedulers: `0` success, `2`
  configuration/usage (do not retry), `3` external system (retry with backoff is
  reasonable), `4` library-internal (file a report), `5` interrupted (signal).
- Each run writes its inputs, configs, and `run-report.json` under one
  per-run `data/output/<timestamp>/` directory.

### Presets

`data/config/presets/report.yaml` and `report-active.yaml` (the latter
`extends: report.yaml`) are example preset files showing the parameter bundle
and the library's `extends` inheritance. Pass one by explicit path with
`--preset` and it drives the run's config (below CLI/env, above defaults):

```bash
node dist/main.js --preset ../../data/config/presets/report-active.yaml
```

`--preset` takes an explicit path — there is no name-to-path resolution or
library search root (see [Data directories](#data-directories)).

### Examples

Unlike the other scripts in this repo, these examples show real input data
and output — json-etl's two flag grammars (`--fields`/`--filters`) are worth
teaching with real values, not just flags. Each example below is a real input
file, the command, and the exact output it produces. Two grammars do the
work:

- **`--fields`** is a comma-separated list of `outputName=path` — pick which
  values to keep and what to call them. A `path` walks nested data by dots
  (`metadata.name`), indexes arrays by number (`items.0`), and fans out with a
  `*` wildcard (`tags.*.label`).
- **`--filters`** is a comma-separated list of `path op value` rules; a row is
  kept only if it passes **every** rule. Ops: `eq ne contains regex gt lt
exists`.

Each command assumes the input file sits in `M3L_INPUT_DIR` and writes to
`M3L_OUTPUT_DIR` (see [Environment](#environment-env)).

### 1. Select columns, drop rows, sort → CSV

The everyday report: rename three fields, drop archived people, sort by id.

`people.ndjson`:

```json
{"id": 3, "metadata": {"name": "Linus"}, "status": "active"}
{"id": 1, "metadata": {"name": "Ada"},   "status": "active"}
{"id": 2, "metadata": {"name": "Grace"}, "status": "archived"}
```

```bash
node dist/main.js --input people.ndjson \
  --fields "id=id,name=metadata.name,status=status" \
  --filters "status ne archived" \
  --sort id:asc --limit 100 \
  --format csv --output people.csv
```

`people.csv` — columns follow the `--fields` order; Grace is filtered out:

```csv
id,name,status
1,Ada,active
3,Linus,active
```

### 2. Keep only rows above a number → JSON

`total gt 100` compares numerically. The `json` format writes a compact array.

`orders.ndjson`:

```json
{"order": "A-100", "total": 1299, "customer": {"tier": "gold"}}
{"order": "A-101", "total": 42,   "customer": {"tier": "silver"}}
{"order": "A-102", "total": 350,  "customer": {"tier": "gold"}}
```

```bash
node dist/main.js --input orders.ndjson \
  --fields "order=order,tier=customer.tier,total=total" \
  --filters "total gt 100" \
  --format json --output big-orders.json
```

`big-orders.json` — A-101 (42) is dropped:

```json
[
  { "order": "A-100", "tier": "gold", "total": 1299 },
  { "order": "A-102", "tier": "gold", "total": 350 }
]
```

### 3. Fan out repeated values with a wildcard (`explode`) → JSONL

`tags.*.label` matches every tag; `--multiValue explode` emits one output row
per match.

`posts.ndjson`:

```json
{"id": "p1", "tags": [{"label": "eng"}, {"label": "ai"}]}
{"id": "p2", "tags": [{"label": "ops"}]}
```

```bash
node dist/main.js --input posts.ndjson \
  --fields "id=id,tag=tags.*.label" \
  --multiValue explode \
  --format jsonl --output tags.jsonl
```

`tags.jsonl` — p1 fans into two rows:

```json
{"id":"p1","tag":"eng"}
{"id":"p1","tag":"ai"}
{"id":"p2","tag":"ops"}
```

### 4. Collect repeated values into one field (`join`) → JSONL

Same input and paths as example 3, but `--multiValue join` keeps one row per
record: several matches become an array, a single match stays a scalar.

```bash
node dist/main.js --input posts.ndjson \
  --fields "id=id,tags=tags.*.label" \
  --multiValue join \
  --format jsonl --output tags.jsonl
```

`tags.jsonl`:

```json
{"id":"p1","tags":["eng","ai"]}
{"id":"p2","tags":"ops"}
```

## Environment (`.env`)

The `.env` file is gitignored (and listed in `.worktreeinclude` so worktrees
inherit it). Secrets go **only** here or in config `secretNames` — never in
source or fixtures.

Per-script data isolation (ADR-0022): the library shares one flat
`data/{config,input,output}` root across all scripts, so point the overrides at
a per-script subtree:

```dotenv
M3L_CONFIG_DIR=<absolute-repo-path>/data/json-etl/config
M3L_INPUT_DIR=<absolute-repo-path>/data/json-etl/input
M3L_OUTPUT_DIR=<absolute-repo-path>/data/json-etl/output
```

## Data directories

| Directory | Purpose                                        |
| --------- | ---------------------------------------------- |
| `config/` | Presets / config files passed by explicit path |
| `input/`  | Files the script consumes                      |
| `output/` | Run results and archived inputs/configs        |
