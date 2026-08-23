import { Core } from "@m3l-automation/m3l-common";

/**
 * The closed set of operations `sqs-dead-letter-triage` dispatches on in
 * this slice. `triage` and `execute` (the AWS-facing operations) are **not**
 * declared here — they land in a later PR (ADR-0072 reviewable-slice
 * discipline). Every operation in this list runs with no AWS credentials at
 * all, which is what lets `validate` run as a CI gate.
 */
export const TRIAGE_OPERATIONS = ["validate", "explain", "convert"] as const;

/** One member of {@link TRIAGE_OPERATIONS}. */
export type TriageOperation = (typeof TRIAGE_OPERATIONS)[number];

/** The default preset directory, relative to `M3L_INPUT_DIR`. */
export const RUNBOOK_DIR_DEFAULT = "runbooks";

/**
 * The declared configuration schema — the script's only input seam. Mirrors
 * `docs/reference/scripts/sqs-dead-letter-triage.md`'s "Configuration
 * schema" table exactly, in table order.
 *
 * Only `operation` and `runbookDir` carry a default; `queue`, `source` and
 * `output` are bare-optional because whether they are required depends on
 * the operation, which {@link configValidators} adjudicates at config-load
 * time.
 *
 * `Core.AWS_PROFILE_PARAM_NAME` is deliberately **not** declared: this slice
 * never touches AWS, and declaring it would provision `script.aws` for no
 * reason. `operation` defaults to `"validate"`, not a destructive/AWS path.
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
