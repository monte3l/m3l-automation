import { Core } from "@m3l-automation/m3l-common";

/**
 * The sixteen operations `eks-ops` dispatches over `AWS.M3LEKSOperations`.
 * Declared as a bare `as const` array (rather than inline in the
 * `M3LConfigParameter`'s `oneOf` call) so the closed set is independently
 * assertable in tests without exercising config resolution — the same "bare
 * `as const` + derived union" idiom `CODEPIPELINE_OPS_OPERATIONS`/
 * `ECS_OPERATIONS` use.
 */
export const EKS_OPS_OPERATIONS = [
  "list-clusters",
  "describe-cluster",
  "create-cluster",
  "update-cluster-config",
  "update-cluster-version",
  "delete-cluster",
  "wait-cluster-active",
  "wait-cluster-deleted",
  "list-nodegroups",
  "describe-nodegroup",
  "create-nodegroup",
  "update-nodegroup-config",
  "update-nodegroup-version",
  "delete-nodegroup",
  "wait-nodegroup-active",
  "wait-nodegroup-deleted",
] as const;

/** The `force` parameter's declared default — passed to `update-cluster-version`/`update-nodegroup-version`. */
export const FORCE_DEFAULT = false;

/** The `maxWaitTime` parameter's declared default, in seconds — the single source of truth `steps/run-eks-ops.ts` reads at the config-read site too. */
export const MAX_WAIT_TIME_DEFAULT = 1200;

/** The `yes` parameter's declared default — bypasses the destructive-operation confirmation prompt when `true`. */
export const YES_DEFAULT = false;

const MAX_RESULTS_MIN = 1;
const MAX_RESULTS_MAX = 100;
const MAX_WAIT_TIME_MIN = 1;
const MAX_WAIT_TIME_MAX = 3600;

/**
 * The declared configuration schema for `eks-ops` — the script's only input
 * seam. Never read `process.env` directly (the scripts ESLint zone bans it);
 * declare a parameter here instead so resolution, coercion, validation, and
 * redaction all flow through the library.
 *
 * Only `aws.profile` and `operation` are `required: true`: per-operation
 * cross-parameter requirements (e.g. `cluster` for every operation but
 * `list-clusters`, `input` for the four create/update-config operations) are
 * not expressible by a single parameter's validator (F1b, deferred), so they
 * are guard-checked at run start instead — see `steps/run-eks-ops.ts`.
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
    validate: Core.M3LConfigValidators.oneOf<string>(EKS_OPS_OPERATIONS),
  }),
  new Core.M3LConfigParameter({
    name: "cluster",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "nodegroup",
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
    name: "kubernetesVersion",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "releaseVersion",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "force",
    type: Core.M3LConfigParameterType.BOOL,
    defaultValue: FORCE_DEFAULT,
  }),
  new Core.M3LConfigParameter({
    name: "maxResults",
    type: Core.M3LConfigParameterType.INT,
    validate: Core.M3LConfigValidators.range(MAX_RESULTS_MIN, MAX_RESULTS_MAX),
  }),
  new Core.M3LConfigParameter({
    name: "nextToken",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "include",
    type: Core.M3LConfigParameterType.STRING_ARRAY,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "maxWaitTime",
    type: Core.M3LConfigParameterType.INT,
    defaultValue: MAX_WAIT_TIME_DEFAULT,
    validate: Core.M3LConfigValidators.range(
      MAX_WAIT_TIME_MIN,
      MAX_WAIT_TIME_MAX,
    ),
  }),
  new Core.M3LConfigParameter({
    name: "yes",
    type: Core.M3LConfigParameterType.BOOL,
    defaultValue: YES_DEFAULT,
  }),
];
