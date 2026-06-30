# Skill Benchmark: write-work-log

**Model**: <model-name>
**Date**: 2026-06-30T07:47:00Z
**Evals**: 1, 2, 3 (3 distinct evals × 1 run per configuration)

## Summary

| Metric    | With Skill   | Without Skill  | Delta  |
| --------- | ------------ | -------------- | ------ |
| Pass Rate | 100% ± 0%    | 83% ± 29%      | +0.17  |
| Time      | 72.4s ± 7.2s | 108.3s ± 30.3s | -35.9s |
| Tokens    | 26665 ± 1681 | 31578 ± 4186   | -4913  |

## Analyst notes

- **stddev reflects cross-scenario variance, not repeatability.** Each eval was
  run once per configuration, so the ± figures measure spread across three
  different prompt difficulties (rich context, general task, minimal context) —
  not stochastic noise from repeated runs of the same prompt. Do not interpret
  `± 29%` as a reliability measure.

- **eval-general-task (ID 2) contributes zero discriminating power on log
  quality.** Both agents had access to `SKILL.md` on disk in the worktree and
  produced byte-for-byte identical output `.md` files. The `response.txt` files
  differ (the with-skill version appends the Step 4 commit reminder), but the
  graded artifact is the same for both. The **+17pp delta is driven entirely by
  eval-minimal-context** (ambiguity handling: with-skill asks one clarifying
  question immediately; without-skill exhausts 17 tool calls first) **and
  eval-submodule-implementation** (time/token efficiency).
