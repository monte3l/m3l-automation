import { Core } from "@m3l-automation/m3l-common";

/**
 * The closed set of operations `sqs-dead-letter-triage` dispatches on.
 * `validate`/`explain`/`convert` run with no AWS credentials at all, which
 * is what lets `validate` run as a CI gate; `triage` and `execute` are the
 * two operations that reach AWS. `execute` only mutates when the caller also
 * passes `--apply` — without it, it triages and prints the plan, exactly
 * like `triage` plus the plan report.
 */
export const TRIAGE_OPERATIONS = [
  "validate",
  "explain",
  "convert",
  "triage",
  "execute",
] as const;

/** One member of {@link TRIAGE_OPERATIONS}. */
export type TriageOperation = (typeof TRIAGE_OPERATIONS)[number];

/** The default preset directory, relative to `M3L_INPUT_DIR`. */
export const RUNBOOK_DIR_DEFAULT = "runbooks";

/** The default total-message cap one `triage` drain pulls across every page. */
export const MAX_MESSAGES_DEFAULT = 100;
const MAX_MESSAGES_MIN = 1;
const MAX_MESSAGES_MAX = 10_000;

/**
 * The default visibility timeout (seconds) applied to a drained batch. This
 * is now also the window an operator has to complete `execute --apply`'s
 * destructive confirmation: `execute-actions.ts`'s `applyActions` reuses the
 * exact receipt handles the drain obtained instead of re-receiving, and a
 * handle expires when this timeout elapses. A value here shorter than a
 * slow/interactive confirmation takes means an expired handle and a failed
 * apply — the affected message(s) land in `ApplyResult.failed` (which
 * demotes the run to `"partial"`) rather than being removed/reinserted, and
 * stay safely in the dead-letter queue.
 */
export const VISIBILITY_TIMEOUT_DEFAULT = 1800;
const VISIBILITY_TIMEOUT_MIN = 0;
const VISIBILITY_TIMEOUT_MAX = 43_200;

/**
 * The declared configuration schema — the script's only input seam. Mirrors
 * `docs/reference/scripts/sqs-dead-letter-triage.md`'s "Configuration
 * schema" table exactly, in table order.
 *
 * Only `operation`, `runbookDir`, `maxMessages`, `visibilityTimeout`, `apply`,
 * `yes` and `yesSensitive` carry a default; `queue`, `queueUrl`, `source`,
 * `output` and `sourceQueueUrl` are bare-optional because whether they are
 * required depends on the operation (or, for `sourceQueueUrl`, on the plan
 * `execute` actually builds), which {@link configValidators} and `execute`'s
 * own run-time guard adjudicate, never here.
 *
 * `Core.AWS_PROFILE_PARAM_NAME` (`aws.profile`) IS now declared — `triage`
 * and `execute` reach AWS — but deliberately not `required: true`: declaring
 * the parameter is what makes `M3LScript` provision `script.aws`, and only
 * `triage`/`execute` need it. `validate`, `explain` and `convert` must stay
 * runnable with no AWS credentials at all, which is what makes `validate` a
 * CI gate. `operation` still defaults to `"validate"`, not an AWS-facing one.
 *
 * `sourceQueueUrl` is where a planned `reinsert` sends — required only when
 * `execute`'s plan actually contains one, guarded at run time in
 * `run-sqs-dead-letter-triage.ts`, never here (decision 1: an operator
 * triaging a queue that yields no reinserts must never be forced to supply
 * it). `apply` gates whether `execute` mutates at all (default `false`:
 * plan-only). Every `execute --apply` is treated as sensitive (review round
 * 2, MUST-FIX 7: the library never populates `M3LDestructiveTarget.accountId`,
 * so an account-keyed allow-list could never work) — `yes`/`yesSensitive` are
 * the `Core.confirmDestructive` bypass flags, and only `yes && yesSensitive`
 * (both strictly `true`) bypasses the gate; see that function's TSDoc for the
 * two flags' deliberately asymmetric polarity.
 */
export const configParameters: readonly Core.M3LConfigParameter[] = [
  new Core.M3LConfigParameter({
    name: "operation",
    type: Core.M3LConfigParameterType.STRING,
    defaultValue: "validate",
    validate: Core.M3LConfigValidators.oneOf<string>(TRIAGE_OPERATIONS),
  }),
  new Core.M3LConfigParameter({
    name: "runbookDir",
    type: Core.M3LConfigParameterType.STRING,
    defaultValue: RUNBOOK_DIR_DEFAULT,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "queue",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "source",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "output",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "queueUrl",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "maxMessages",
    type: Core.M3LConfigParameterType.INT,
    defaultValue: MAX_MESSAGES_DEFAULT,
    validate: Core.M3LConfigValidators.range(
      MAX_MESSAGES_MIN,
      MAX_MESSAGES_MAX,
    ),
  }),
  new Core.M3LConfigParameter({
    name: "visibilityTimeout",
    type: Core.M3LConfigParameterType.INT,
    defaultValue: VISIBILITY_TIMEOUT_DEFAULT,
    validate: Core.M3LConfigValidators.range(
      VISIBILITY_TIMEOUT_MIN,
      VISIBILITY_TIMEOUT_MAX,
    ),
  }),
  new Core.M3LConfigParameter({
    name: Core.AWS_PROFILE_PARAM_NAME,
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "sourceQueueUrl",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "apply",
    type: Core.M3LConfigParameterType.BOOL,
    defaultValue: false,
  }),
  new Core.M3LConfigParameter({
    name: "yes",
    type: Core.M3LConfigParameterType.BOOL,
    defaultValue: false,
  }),
  new Core.M3LConfigParameter({
    name: "yesSensitive",
    type: Core.M3LConfigParameterType.BOOL,
    defaultValue: false,
  }),
];

/**
 * Which bare-optional parameters each operation cannot run without. Keyed as
 * a `Record<TriageOperation, ...>` so adding an operation to
 * {@link TRIAGE_OPERATIONS} without deciding its requirements is a compile
 * error, not a run-time gap.
 */
const REQUIRED_BY_OPERATION: Record<TriageOperation, readonly string[]> = {
  validate: [],
  explain: ["queue"],
  convert: ["source"],
  triage: ["queue", "queueUrl"],
  execute: ["queue", "queueUrl"],
};

/** Reads `operation`, falling back to the declared default. */
function readOperation(config: Core.M3LConfig): TriageOperation {
  const raw = config.get("operation");
  const match = TRIAGE_OPERATIONS.find((candidate) => candidate === raw);
  return match ?? "validate";
}

/**
 * The schema-level (cross-parameter) validators, wired into `main.ts` as
 * `config.validate`.
 *
 * Two constraints live here because no per-parameter validator can express
 * them: per-operation requiredness (a validator never sees a second
 * parameter's value), and a `queue` traversal guard — `queue` is
 * interpolated into a preset filename (`<runbookDir>/<queue>.json`), so a
 * value carrying a path separator or `..` must fail loud here rather than
 * resolving a file outside the runbook directory.
 */
export const configValidators: readonly Core.M3LConfigSchemaValidator[] = [
  (config: Core.M3LConfig): true | string => {
    const operation = readOperation(config);
    const missing = REQUIRED_BY_OPERATION[operation].filter((name) => {
      const value = config.get(name);
      return typeof value !== "string" || value.length === 0;
    });
    return missing.length === 0
      ? true
      : `operation '${operation}' requires: ${missing.join(", ")}`;
  },
  (config: Core.M3LConfig): true | string => {
    const queue = config.get("queue");
    if (typeof queue !== "string" || queue.length === 0) return true;
    return queue.includes("/") || queue.includes("\\") || queue.includes("..")
      ? "'queue' must not contain a path separator or '..' — it is interpolated into a preset filename"
      : true;
  },
];
