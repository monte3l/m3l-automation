/**
 * Core `polling` submodule — resilient waiting and retrying primitives.
 *
 * Surfaces exactly the documented public API: the {@link M3LPoller} /
 * {@link M3LRetryRunner} primitives, the {@link M3LBackoff} and
 * {@link M3LPollingPolicies} factories, the poller and retry types, the
 * {@link combineClassifiers} composer, and the three built-in classifiers.
 *
 * Construction option interfaces and the backoff-strategy contract are
 * intentionally not re-exported — callers build options via the factories and
 * pass them opaquely.
 *
 * @packageDocumentation
 */

export { M3LPoller } from "./M3LPoller.js";
export type { M3LPollCheckFn, M3LPollDecision } from "./M3LPoller.js";

export { M3LRetryRunner } from "./M3LRetryRunner.js";
export type {
  M3LRetryAdvice,
  M3LRetryClassifier,
  M3LRetryDecision,
} from "./M3LRetryRunner.js";

export { M3LBackoff } from "./M3LBackoff.js";
export { M3LPollingPolicies } from "./M3LPollingPolicies.js";

export {
  awsNetworkClassifier,
  awsThrottlingClassifier,
  combineClassifiers,
  httpRetryAfterClassifier,
} from "./classifiers.js";
