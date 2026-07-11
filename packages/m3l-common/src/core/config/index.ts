/**
 * `core/config` — layered configuration resolution: providers, a priority
 * reader, declared parameters with a coercion/fallback chain, a resolved
 * value store, and supporting schema/secrets/detection utilities.
 *
 * Re-exports all public symbols from the implementation modules.
 * No logic lives here; this file is a barrel only.
 *
 * @packageDocumentation
 */

export * from "./coerceConfigValue.js";
export * from "./M3LCommandLineConfigProvider.js";
export * from "./M3LConfig.js";
export * from "./M3LConfigCoercionError.js";
export * from "./M3LConfigMissingError.js";
export * from "./M3LConfigParameter.js";
export * from "./M3LConfigParameterType.js";
export * from "./M3LConfigParseError.js";
export * from "./M3LConfigProvider.js";
export * from "./M3LConfigReader.js";
export * from "./M3LConfigSchema.js";
export * from "./M3LConfigValidationError.js";
export * from "./M3LConfigValidator.js";
export * from "./M3LEnvironmentConfigProvider.js";
export * from "./M3LInMemoryConfigProvider.js";
export * from "./M3LJSONConfigProvider.js";
export * from "./M3LLambdaEventConfigProvider.js";
export * from "./M3LPresetConfigProvider.js";
export * from "./M3LSecretsSpecifier.js";
export * from "./M3LUnknownParameterDetector.js";
export * from "./M3LUnsafeConfigKeyError.js";
export * from "./M3LYAMLConfigProvider.js";
