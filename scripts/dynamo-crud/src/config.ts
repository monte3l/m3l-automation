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

/** The ten operations `dynamo-crud` supports. */
const DYNAMO_OPERATIONS = [
  "get",
  "put",
  "update",
  "delete",
  "query",
  "scan",
  "batch-write",
  "batch-delete",
  "export",
  "import",
] as const;

/**
 * The declared configuration schema for `dynamo-crud` — the script's only
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
 * `batch-write`) are cross-parameter constraints a single parameter's
 * validator cannot express, so they are guard-checked at run start instead
 * (see `steps/run-dynamo-crud.ts`).
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
    validate: Core.M3LConfigValidators.oneOf<string>(DYNAMO_OPERATIONS),
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
