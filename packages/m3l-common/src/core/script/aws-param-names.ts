/**
 * `core/script/aws-param-names` — the canonical config parameter names the
 * AWS-provisioning seam looks up.
 *
 * @packageDocumentation
 */

/**
 * The config parameter name that gates the AWS provisioning seam (stage 5).
 * A schema declaring a parameter under this name is the sole trigger for
 * {@link M3LScript} to provision `script.aws`.
 *
 * @example
 * ```ts
 * import {
 *   AWS_PROFILE_PARAM_NAME,
 *   M3LConfigParameter,
 *   M3LConfigParameterType,
 * } from "@m3l-automation/m3l-common/core";
 *
 * const awsProfile = new M3LConfigParameter({
 *   name: AWS_PROFILE_PARAM_NAME,
 *   type: M3LConfigParameterType.STRING,
 * });
 * ```
 */
export const AWS_PROFILE_PARAM_NAME = "aws.profile" as const;

/**
 * The config parameter name carrying the optional AWS region override. Never
 * independently gates provisioning: only {@link AWS_PROFILE_PARAM_NAME} being
 * declared triggers stage 5; `aws.region` is consulted only once
 * provisioning is already underway.
 *
 * @example
 * ```ts
 * import {
 *   AWS_REGION_PARAM_NAME,
 *   M3LConfigParameter,
 *   M3LConfigParameterType,
 * } from "@m3l-automation/m3l-common/core";
 *
 * const awsRegion = new M3LConfigParameter({
 *   name: AWS_REGION_PARAM_NAME,
 *   type: M3LConfigParameterType.STRING,
 *   defaultValue: "us-east-1",
 * });
 * ```
 */
export const AWS_REGION_PARAM_NAME = "aws.region" as const;
