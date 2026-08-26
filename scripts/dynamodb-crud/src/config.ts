import { Core } from "@m3l-automation/m3l-common";

const BATCH_SIZE_MIN = 1;
const BATCH_SIZE_MAX = 10_000;
const BATCH_SIZE_DEFAULT = 100;

const TOTAL_SEGMENTS_MIN = 1;
const TOTAL_SEGMENTS_MAX = 1_000;
const TOTAL_SEGMENTS_DEFAULT = 1;

const MAX_PAGES_PER_SECOND_MIN = 0;
const MAX_PAGES_PER_SECOND_MAX = Number.MAX_SAFE_INTEGER;

const MAX_IN_FLIGHT_BATCHES_MIN = 1;
const MAX_IN_FLIGHT_BATCHES_MAX = 100;
const MAX_IN_FLIGHT_BATCHES_DEFAULT = 4;

const CHECKPOINT_EVERY_PAGES_MIN = 1;
const CHECKPOINT_EVERY_PAGES_MAX = Number.MAX_SAFE_INTEGER;
const CHECKPOINT_EVERY_PAGES_DEFAULT = 25;

const PROGRESS_EVERY_RECORDS_MIN = 1;
const PROGRESS_EVERY_RECORDS_MAX = Number.MAX_SAFE_INTEGER;
const PROGRESS_EVERY_RECORDS_DEFAULT = 10_000;

const RESUME_DEFAULT = false;

/**
 * The `operation` parameter's declared operation set (ADR-0055) — the ten
 * verbs `dynamodb-crud` dispatches over `aws/dynamodb`. Feeds
 * {@link configParameters}' `operation` declaration (which auto-composes the
 * membership validator, replacing the prior hand-written `oneOf`) and
 * {@link DYNAMO_OPERATIONS}' name projection below.
 *
 * `requiredParameters` here is **declarative metadata only** — CLI
 * introspection surfaces it (ADR-0055), but it is deliberately **not**
 * enforced at config-load time: `Core.deriveOperationValidators` is NOT
 * spread into {@link configValidators} (dynamodb-crud has none), so presence
 * enforcement stays exactly where it already was — the run-start guard in
 * `steps/run-dynamodb-crud.ts` (`applyOperationGuards`/`REQUIRED_FIELDS`).
 * Wiring `deriveOperationValidators` in here would move that failure earlier
 * (to config-load time) and is out of scope for this change — do not add it
 * without deliberately deciding to change failure timing.
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
export const DYNAMO_OPERATION_DECLARATIONS = [
  {
    name: "get",
    description: "Get a single item by key.",
    requiredParameters: ["key", "output"],
  },
  {
    name: "put",
    description: "Put a full item.",
    requiredParameters: ["item"],
  },
  {
    name: "update",
    description:
      "Update an item via a merge patch, routed through the destructive-operation gate.",
    requiredParameters: ["key", "item"],
  },
  {
    name: "delete",
    description:
      "Delete an item by key, routed through the destructive-operation gate.",
    requiredParameters: ["key"],
  },
  {
    name: "query",
    description:
      "Query items across parallel segmented workers, with an optional equality key condition.",
    requiredParameters: ["key", "output"],
  },
  {
    name: "scan",
    description:
      "Scan a table across parallel segmented workers, streaming records as JSONL.",
    requiredParameters: ["output"],
  },
  {
    name: "batch-write",
    description:
      "Batch-write records read from the input file, retrying unprocessed items.",
    requiredParameters: ["input"],
  },
  {
    name: "batch-delete",
    description:
      "Batch-delete records read from the input file, routed through the destructive-operation gate.",
    requiredParameters: ["input"],
  },
  {
    name: "export",
    description:
      "Export a full table scan to JSONL across parallel segmented workers.",
    requiredParameters: ["output"],
  },
  {
    name: "import",
    description:
      "Import records from the input file, routed through the destructive-operation gate.",
    requiredParameters: ["input"],
  },
] as const;

/** The literal union of {@link DYNAMO_OPERATION_DECLARATIONS}' operation names. */
type DynamoOperationName =
  (typeof DYNAMO_OPERATION_DECLARATIONS)[number]["name"];

/**
 * Name-only projection of {@link DYNAMO_OPERATION_DECLARATIONS} — the ten
 * operations `dynamodb-crud` supports. Kept under its original name and
 * element order: `steps/run-dynamodb-crud.ts` derives its `DynamoOperation`
 * type alias from this constant, keys two exhaustive
 * `Record<DynamoOperation, …>` dispatch tables off it, and calls
 * `accessor.oneOf("operation", DYNAMO_OPERATIONS)` with it.
 */
export const DYNAMO_OPERATIONS: readonly [
  DynamoOperationName,
  ...(readonly DynamoOperationName[]),
] = Core.deriveOperationNames(DYNAMO_OPERATION_DECLARATIONS);

/**
 * The declared configuration schema for `dynamodb-crud` — the script's only
 * input seam. Never read `process.env` directly (the scripts ESLint zone bans
 * it); declare a parameter here instead so resolution, coercion, validation,
 * and redaction all flow through the library.
 *
 * Declare an AWS profile parameter with `Core.AWS_PROFILE_PARAM_NAME` when the
 * script touches AWS — that name is what enables the `script.aws`
 * dynamic-provisioning seam.
 *
 * `operation`, `tableName`, and `aws.profile` are `required: true`: presence
 * is enforced at config-load time by the library. The remaining
 * per-operation requirements (e.g. `key` for `get`, `input` for
 * `batch-write`) are declared as data on
 * {@link DYNAMO_OPERATION_DECLARATIONS}' `requiredParameters` for CLI
 * introspection, but are cross-parameter constraints a single parameter's
 * validator cannot express and are deliberately left enforced at run start
 * only (see `steps/run-dynamodb-crud.ts`) — see that constant's TSDoc for
 * why `Core.deriveOperationValidators` is not wired in here.
 */
export const configParameters: readonly Core.M3LConfigParameter[] = [
  new Core.M3LConfigParameter({
    name: Core.AWS_PROFILE_PARAM_NAME,
    type: Core.M3LConfigParameterType.STRING,
    required: true,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "operation",
    type: Core.M3LConfigParameterType.STRING,
    required: true,
    operations: DYNAMO_OPERATION_DECLARATIONS,
  }),
  new Core.M3LConfigParameter({
    name: "tableName",
    type: Core.M3LConfigParameterType.STRING,
    required: true,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "batchSize",
    type: Core.M3LConfigParameterType.INT,
    defaultValue: BATCH_SIZE_DEFAULT,
    validate: Core.M3LConfigValidators.range(BATCH_SIZE_MIN, BATCH_SIZE_MAX),
  }),
  new Core.M3LConfigParameter({
    name: "totalSegments",
    type: Core.M3LConfigParameterType.INT,
    defaultValue: TOTAL_SEGMENTS_DEFAULT,
    validate: Core.M3LConfigValidators.range(
      TOTAL_SEGMENTS_MIN,
      TOTAL_SEGMENTS_MAX,
    ),
  }),
  new Core.M3LConfigParameter({
    name: "maxPagesPerSecond",
    type: Core.M3LConfigParameterType.DOUBLE,
    validate: Core.M3LConfigValidators.range(
      MAX_PAGES_PER_SECOND_MIN,
      MAX_PAGES_PER_SECOND_MAX,
    ),
  }),
  new Core.M3LConfigParameter({
    name: "maxInFlightBatches",
    type: Core.M3LConfigParameterType.INT,
    defaultValue: MAX_IN_FLIGHT_BATCHES_DEFAULT,
    validate: Core.M3LConfigValidators.range(
      MAX_IN_FLIGHT_BATCHES_MIN,
      MAX_IN_FLIGHT_BATCHES_MAX,
    ),
  }),
  new Core.M3LConfigParameter({
    name: "checkpointEveryPages",
    type: Core.M3LConfigParameterType.INT,
    defaultValue: CHECKPOINT_EVERY_PAGES_DEFAULT,
    validate: Core.M3LConfigValidators.range(
      CHECKPOINT_EVERY_PAGES_MIN,
      CHECKPOINT_EVERY_PAGES_MAX,
    ),
  }),
  new Core.M3LConfigParameter({
    name: "runName",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "resume",
    type: Core.M3LConfigParameterType.BOOL,
    defaultValue: RESUME_DEFAULT,
  }),
  new Core.M3LConfigParameter({
    name: "key",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "item",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "indexName",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "input",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "output",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "progressEveryRecords",
    type: Core.M3LConfigParameterType.INT,
    defaultValue: PROGRESS_EVERY_RECORDS_DEFAULT,
    validate: Core.M3LConfigValidators.range(
      PROGRESS_EVERY_RECORDS_MIN,
      PROGRESS_EVERY_RECORDS_MAX,
    ),
  }),
];
