# Core: `analysis`

Declarative threshold evaluation over tabular data: define rules with operators, aggregations, and severities, then evaluate them against rows to detect breaches.

## Overview

The `analysis` module provides `M3LThresholdEvaluator`, which applies a set of `M3LThresholdRule` definitions to an array of data rows and detects which rules were breached. Each rule names a field, an operator, a threshold value, an aggregation over the rows, and a severity. Evaluation returns an overall `breached` flag, a human-readable summary, and per-rule results. Numeric parsing is locale-aware, so comma-decimal inputs are handled correctly.

## Public API

Exported from `@m3l-automation/m3l-common/core` (and the `Core` namespace):

- `M3LThresholdEvaluator` — the evaluator class.
- `M3LThresholdRule` — a single threshold-check definition.
- `M3LThresholdRuleResult` — the per-rule outcome.
- `M3LThresholdEvaluation` — the overall evaluation result.
- `M3LThresholdRuleValidationError` — thrown for a malformed rule.
- `M3LThresholdOperator` — the comparison-operator union.
- `M3LThresholdAggregation` — the aggregation union.
- `M3LThresholdSeverity` — the severity union.

## Rules

A `M3LThresholdRule` carries the following fields:

| Field         | Meaning                                                              |
| ------------- | -------------------------------------------------------------------- |
| `name`        | Identifier for the rule (appears in results and summary)             |
| `field`       | Optional column name the rule reads                                  |
| `operator`    | One of `>`, `>=`, `<`, `<=`, `==`, `!=`                              |
| `value`       | The threshold value compared against                                 |
| `aggregation` | How rows are reduced: `any-row`, `count`, `sum`, `avg`, `min`, `max` |
| `severity`    | `info`, `warning`, or `critical`                                     |

The `aggregation` determines what the operator compares: `any-row` tests each row individually (breached if any row matches), while `count`, `sum`, `avg`, `min`, and `max` reduce the column across all rows to a single number first.

## Evaluating rules

`M3LThresholdEvaluator.evaluate(rules, rows)` applies each rule independently and returns a `M3LThresholdEvaluation`:

- `breached` — overall boolean (true if any rule was breached).
- `summary` — a human-readable description of the outcome.
- `results` — an array of `M3LThresholdRuleResult`, one per rule.

Each `M3LThresholdRuleResult` carries:

| Field      | Meaning                                                                                                        |
| ---------- | -------------------------------------------------------------------------------------------------------------- |
| `name`     | The name of the rule this result came from.                                                                    |
| `breached` | Whether this rule's comparison matched.                                                                        |
| `severity` | The rule's severity, carried through unchanged.                                                                |
| `actual`   | The aggregate value the operator was compared against, or `null` when no single aggregate applies (see below). |

`actual` is the reduced number for `count`/`sum`/`avg`/`min`/`max`. It is `null`
for `any-row` (which is evaluated per-row, with no single aggregate) and for
`avg`/`min`/`max` when the column holds no numeric values.

```typescript
import { Core } from "@m3l-automation/m3l-common";

const rules: Core.M3LThresholdRule[] = [
  {
    name: "error-rate-too-high",
    field: "errorRate",
    operator: ">",
    value: 0.05,
    aggregation: "avg",
    severity: "critical",
  },
  {
    name: "any-failed-row",
    field: "status",
    operator: "==",
    value: "FAILED",
    aggregation: "any-row",
    severity: "warning",
  },
];

const rows = await loadResultRows();

const evaluation = new Core.M3LThresholdEvaluator().evaluate(rules, rows);

if (evaluation.breached) {
  console.error(evaluation.summary);
}
```

## Locale-aware numeric parsing

Numeric values are parsed with locale awareness, so comma-decimal formats are interpreted correctly — for example the string `"1,5"` is parsed as `1.5`. This lets the evaluator operate over data imported from locale-formatted sources without a separate normalization step.

## Notes and behavior

- Each rule is evaluated independently; one breach does not short-circuit the others, so `results` always covers every rule.
- The `severity` field classifies the breach but does not change whether `breached` is set — any breached rule sets the overall flag.
- **Rule validation.** A rule throws `M3LThresholdRuleValidationError` (code `ERR_ANALYSIS_INVALID_RULE`) when it has an unrecognized `operator`, an unrecognized `aggregation`, a field-requiring aggregation (`any-row`/`sum`/`avg`/`min`/`max`) that omits `field`, or an ordering operator (`>`/`>=`/`<`/`<=`) whose `value` is a non-numeric string. `count` is the only aggregation that does not require a `field`. Rules are validated before any evaluation runs, so a malformed rule fails fast rather than silently never breaching.
- **`count`** compares the number of rows against `value` (it ignores `field`).
- **Equality on strings.** When `value` is a string, `==` and `!=` compare the cell as a string (the `"FAILED"` case above). Ordering operators (`>`/`>=`/`<`/`<=`) always compare numerically, parsing cells locale-aware.
- **Non-numeric cells** are skipped by the reducing aggregations (`sum`/`avg`/`min`/`max`) — the aggregate is computed over the numeric cells only. For `any-row`, a non-numeric cell simply does not match a numeric comparison.
- **Empty input.** Over an empty row set (or a column with no numeric cells), reducers do not breach: `count` and `sum` yield `0`, while `avg`/`min`/`max` yield `actual: null` and are treated as not-breached. `any-row` over no rows is not breached.
- Pair this module with importers to evaluate freshly parsed tabular data, and with messaging to surface breaches.

## See also

- [importers](./importers.md)
- [messaging](./messaging.md)
- [utils](./utils.md)
- [Architecture overview](../../m3l-common-architecture.md)
