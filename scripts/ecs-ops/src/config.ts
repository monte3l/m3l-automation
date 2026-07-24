import { Core } from "@m3l-automation/m3l-common";

/**
 * The declared configuration schema for `ecs-ops` — the script's only
 * input seam. Never read `process.env` directly (the scripts ESLint zone bans
 * it); declare a parameter here instead so resolution, coercion, validation,
 * and redaction all flow through the library.
 *
 * `aws.profile` enables the `script.aws` dynamic-provisioning seam
 * (`Core.AWS_PROFILE_PARAM_NAME`) this scaffold requires since the script
 * touches AWS. This is the scaffold-phase seam only — the full `operation`
 * `oneOf` and per-operation fields (`cluster`/`service`/`input`/etc., see
 * `docs/reference/scripts/ecs-ops.md`) are added by the `implementing-scripts`
 * GREEN phase against the ratified contract.
 */
export const configParameters: readonly Core.M3LConfigParameter[] = [
  new Core.M3LConfigParameter({
    name: Core.AWS_PROFILE_PARAM_NAME,
    type: Core.M3LConfigParameterType.STRING,
    required: true,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
];
