/**
 * `store/migrations/telemetry` — the `console_telemetry_rollup` DDL.
 *
 * Split out of `./registry.ts` following the same ADR-0072 file-size ceiling
 * precedent as `./human-actions.ts`: this module holds one const with the
 * full DDL so the drift digest (computed over `statements` in
 * `registry.ts:26-58`) is stable across `prettier` reformats.
 *
 * **Six measured findings that explain the schema's shape:**
 *
 * 1. **`WITHOUT ROWID` makes every PRIMARY KEY column implicitly `NOT NULL`.**
 *    A `NULL` dimension is rejected outright (`NOT NULL constraint failed`).
 *    Hence every dimension column is `TEXT NOT NULL` with `''` meaning
 *    "not applicable to this metric", never `NULL`.
 *
 * 2. **The rowid + `UNIQUE INDEX` alternative fails silently.** With nullable
 *    dimensions and a unique index, `NULL != NULL`, so `ON CONFLICT DO UPDATE`
 *    never matches: three identical upserts produced three rows each with
 *    `count: 1` instead of one row with `count: 3`. The `''` sentinel is
 *    therefore not optional — it is the semantic requirement for correct rollup.
 *
 * 3. **Every `CHECK` here is determinate — none can be satisfied-by-`NULL`.**
 *    `granularity`, `metric` and every dimension are `NOT NULL`, so each
 *    `x <> ''` / `x IN (…)` is always a definite 0/1; `IS NULL` is itself
 *    always definite. This avoids the nullability trap
 *    `store/migrations/registry.ts:100-120` documents for `console_runs`.
 *
 * 4. **No secondary index — measured as actively harmful.** A
 *    `(metric, granularity, bucket_start_ms)` index made whole-window
 *    aggregates 2× slower (149 ms vs 72 ms over 432,000 rows after `ANALYZE`):
 *    a `WITHOUT ROWID` secondary index carries the full PK as its payload, so
 *    fetching non-indexed columns costs a second b-tree lookup per row. The PK
 *    *is* the index; v9 ships **one statement** only.
 *
 * 5. **Both hot paths hit the PK prefix.** `EXPLAIN QUERY PLAN` reports
 *    `SEARCH … USING PRIMARY KEY (granularity=? AND bucket_start_ms<?)` for
 *    the prune and `(granularity=? AND bucket_start_ms>?)` for a time-ranged
 *    list. This is why `granularity, bucket_start_ms` lead the PK ahead of
 *    `metric`.
 *
 * 6. **Long PK values are accepted** (2 KiB and 64 KiB both inserted fine at
 *    the 4096-byte page size) — a performance note only, and moot once
 *    slice 2 uses the bounded route pattern.
 *
 * **`*_value` unit is metric-dependent:** milliseconds for `http.request` /
 * `run.finished`, bytes for `store.health`, `NULL` for the pure counters
 * (`sse.stream`, `policy.decision`). The columns are therefore named
 * `sum_value` / `min_value` / `max_value`, not `sum_ms`.
 *
 * **What is deliberately NOT `CHECK`ed, and why:** the *vocabulary* of
 * `outcome` (`'2xx'`, `'succeeded'`, a stream stop reason, …). Presence vs
 * absence per metric is structural and certain today; the vocabularies belong
 * to slices 2–4's recorders, which have not been built or measured. A closed
 * `CHECK` guessed now and found wrong later costs a full table recreate —
 * the exact v7/v8 tax `human-actions.ts:10-15` documents. Do not "tighten"
 * this column without shipping a migration.
 *
 * @packageDocumentation
 */

/**
 * The exact DDL for `console_telemetry_rollup`, `CONSOLE_MIGRATIONS`' v9
 * (X8 telemetry store foundation, slice 1). A rollup-bucket table: one row
 * per (granularity × bucket × metric × dimensions), upserted per measurement.
 *
 * ADR-0070 names "age-based rollup" as *the* telemetry retention policy and
 * scopes the feature to "SQLite-grade aggregation, not an APM platform", so
 * bounded growth is the schema rather than a later bolt-on.
 *
 * The `outcome` vocabulary (`'2xx'`, `'succeeded'`, a stream stop reason …)
 * is intentionally not `CHECK`-constrained — see this module's
 * `@packageDocumentation` for why.
 *
 * Every PK column is also `NOT NULL` via the `WITHOUT ROWID` implicit rule
 * (finding 1). The `''` sentinel signals "not applicable to this metric" for
 * each dimension column; translating `''` to `undefined` on the read path
 * would silently corrupt rollup counts (finding 2).
 */
export const CREATE_CONSOLE_TELEMETRY_ROLLUP_TABLE = `
  CREATE TABLE console_telemetry_rollup (
    granularity TEXT NOT NULL CHECK (granularity IN ('minute','hour','day')),
    bucket_start_ms INTEGER NOT NULL CHECK (bucket_start_ms >= 0),
    metric TEXT NOT NULL CHECK (metric IN (
      'http.request','run.finished','sse.stream','policy.decision','store.health'
    )),
    route TEXT NOT NULL,
    script TEXT NOT NULL,
    operation TEXT NOT NULL,
    outcome TEXT NOT NULL,
    posture TEXT NOT NULL,
    sample_count INTEGER NOT NULL CHECK (sample_count > 0),
    sum_value INTEGER,
    min_value INTEGER,
    max_value INTEGER,
    PRIMARY KEY (
      granularity, bucket_start_ms, metric,
      route, script, operation, outcome, posture
    ),
    CHECK (
      bucket_start_ms % CASE granularity
        WHEN 'minute' THEN 60000
        WHEN 'hour' THEN 3600000
        ELSE 86400000
      END = 0
    ),
    CHECK ((route <> '') = (metric = 'http.request')),
    CHECK ((script <> '') = (metric = 'run.finished')),
    CHECK (operation = '' OR metric = 'run.finished'),
    CHECK ((posture <> '') = (metric = 'policy.decision')),
    CHECK (outcome = '' OR metric <> 'store.health'),
    CHECK ((sum_value IS NULL) = (min_value IS NULL)),
    CHECK ((sum_value IS NULL) = (max_value IS NULL)),
    CHECK (
      sum_value IS NULL
      OR (min_value >= 0 AND min_value <= max_value AND max_value <= sum_value)
    ),
    CHECK (
      metric NOT IN ('http.request','run.finished') OR sum_value IS NOT NULL
    )
  ) STRICT, WITHOUT ROWID
`;
