import { Core } from "@m3l-automation/m3l-common";

/**
 * The `operation` parameter's declared operation set (ADR-0055) — the five
 * verbs `sqs-dead-letter-triage` dispatches over. `validate`/`explain`/
 * `convert` run with no AWS credentials at all, which is what lets
 * `validate` run as a CI gate; `triage` and `execute` are the two
 * operations that reach AWS. `execute` only mutates when the caller also
 * passes `--apply` — without it, it triages and prints the plan, exactly
 * like `triage` plus the plan report. Feeds {@link configParameters}'
 * `operation` declaration (which auto-composes the membership validator)
 * and {@link Core.deriveOperationValidators}'s per-operation
 * `requiredParameters` derivation below.
 *
 * Deliberately declared with a bare `as const` — NOT
 * `as const satisfies Core.M3LOperationDeclarationList` — because a
 * `satisfies` clause on this literal fails `tsc --isolatedDeclarations`
 * (the mode each script's `tsconfig.build.json` builds under). The shape is
 * still fully compile-time-checked at both use sites without it: passing
 * this value to `Core.deriveOperationNames` below and to `operations:` in
 * `configParameters` each independently check it against
 * `Core.M3LOperationDeclarationList` — do not re-add `satisfies` here.
 */
export const TRIAGE_OPERATION_DECLARATIONS = [
  {
    name: "validate",
    description: "Build every preset offline and fail on any problem.",
    requiredParameters: [],
  },
  {
    name: "explain",
    description: "Print one preset's compiled step graph, cases and digest.",
    requiredParameters: ["queue"],
  },
  {
    name: "convert",
    description: "Turn one runbook markdown file into a preset skeleton.",
    requiredParameters: ["source"],
  },
  {
    name: "triage",
    description:
      "Drain the queue, run the compiled preset per message, and write the triage report.",
    requiredParameters: ["queue", "queueUrl"],
  },
  {
    name: "execute",
    description:
      "Re-run the triage pass, build the remediation plan, and apply it when 'apply' is set.",
    requiredParameters: ["queue", "queueUrl"],
  },
] as const;

/** The literal union of {@link TRIAGE_OPERATION_DECLARATIONS}' operation names. */
type TriageOperationName =
  (typeof TRIAGE_OPERATION_DECLARATIONS)[number]["name"];

/**
 * The closed set of operations `sqs-dead-letter-triage` dispatches on.
 * `validate`/`explain`/`convert` run with no AWS credentials at all, which
 * is what lets `validate` run as a CI gate; `triage` and `execute` are the
 * two operations that reach AWS. `execute` only mutates when the caller also
 * passes `--apply` — without it, it triages and prints the plan, exactly
 * like `triage` plus the plan report.
 */
export const TRIAGE_OPERATIONS: readonly [
  TriageOperationName,
  ...(readonly TriageOperationName[]),
] = Core.deriveOperationNames(TRIAGE_OPERATION_DECLARATIONS);

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
 * required depends on the operation — declared on
 * {@link TRIAGE_OPERATION_DECLARATIONS} — or, for `sourceQueueUrl`, on the
 * plan `execute` actually builds, which only {@link configValidators} and
 * `execute`'s own run-time guard adjudicate, never here.
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
    operations: TRIAGE_OPERATION_DECLARATIONS,
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
 * The schema-level (cross-parameter) validators, wired into `main.ts` as
 * `config.validate`.
 *
 * The per-operation requiredness validator is DERIVED from
 * {@link TRIAGE_OPERATION_DECLARATIONS} by
 * {@link Core.deriveOperationValidators} (ADR-0055) — `queue` for
 * `explain`; `source` for `convert`; `queue` and `queueUrl` for `triage` and
 * `execute`; `validate` requires nothing extra. Unlike the prior
 * hand-written check, each derived validator reports one missing parameter
 * at a time (fail-fast) and never names the resolved `operation` value,
 * matching the library's secret-safety discipline — see
 * `docs/reference/scripts/sqs-dead-letter-triage.md` for the exact wording
 * change this produces.
 *
 * The `queue` path-traversal guard stays hand-written: it is not
 * per-operation requiredness, but a genuinely independent format constraint
 * — `queue` is interpolated into a preset filename
 * (`<runbookDir>/<queue>.json`), so a value carrying a path separator or
 * `..` must fail loud here rather than resolving a file outside the
 * runbook directory.
 */
export const configValidators: readonly Core.M3LConfigSchemaValidator[] = [
  ...Core.deriveOperationValidators(configParameters),
  (config: Core.M3LConfig): true | string => {
    const queue = config.get("queue");
    if (typeof queue !== "string" || queue.length === 0) return true;
    return queue.includes("/") || queue.includes("\\") || queue.includes("..")
      ? "'queue' must not contain a path separator or '..' — it is interpolated into a preset filename"
      : true;
  },
];
