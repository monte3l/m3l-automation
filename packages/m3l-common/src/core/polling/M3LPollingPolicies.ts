/**
 * `core/polling/M3LPollingPolicies` — pre-baked polling / retry parameter sets
 * tuned for common AWS and HTTP use cases.
 *
 * @packageDocumentation
 */

import { M3LBackoff } from "./M3LBackoff.js";
import {
  awsNetworkClassifier,
  awsThrottlingClassifier,
  combineClassifiers,
  httpRetryAfterClassifier,
} from "./classifiers.js";
import type { M3LPollerOptions } from "./M3LPoller.js";
import type { M3LRetryRunnerOptions } from "./M3LRetryRunner.js";

/** Athena poll tuning: 1s start, 20s cap, up to 120 checks. */
const ATHENA_START_MS = 1_000;
const ATHENA_CAP_MS = 20_000;
const ATHENA_MAX_ATTEMPTS = 120;

/** CloudWatch Logs poll tuning: 500ms start, 10s cap, up to 60 checks. */
const CWL_START_MS = 500;
const CWL_CAP_MS = 10_000;
const CWL_MAX_ATTEMPTS = 60;

/** AWS throttling retry tuning: 200ms start, 5s cap. */
const AWS_THROTTLING_START_MS = 200;
const AWS_THROTTLING_CAP_MS = 5_000;

/** HTTP download retry tuning: 500ms start, 15s cap. */
const HTTP_DOWNLOAD_START_MS = 500;
const HTTP_DOWNLOAD_CAP_MS = 15_000;

/** SQS batch-send retry tuning: 100ms start, 3s cap. */
const SQS_START_MS = 100;
const SQS_CAP_MS = 3_000;

/**
 * Factory for tuned polling / retry option sets. `awsThrottling`,
 * `httpDownload`, and `sqsBatchSend` return {@link M3LRetryRunner} constructor
 * arguments; `athenaQuery` and `cloudWatchLogsQuery` return {@link M3LPoller}
 * constructor arguments.
 *
 * @example
 * ```ts
 * import { Core } from "@m3l-automation/m3l-common/core";
 *
 * const runner = new Core.M3LRetryRunner(
 *   Core.M3LPollingPolicies.awsThrottling(),
 * );
 * ```
 */
export class M3LPollingPolicies {
  private constructor() {
    // Static factory only; never instantiated.
  }

  /**
   * Poller options for waiting on an Athena query to reach a terminal state:
   * jittered backoff from 1s to 20s, up to 120 checks.
   *
   * @returns {@link M3LPoller} constructor options.
   */
  static athenaQuery(): M3LPollerOptions {
    return {
      backoff: M3LBackoff.exponentialJittered(ATHENA_START_MS, ATHENA_CAP_MS),
      maxAttempts: ATHENA_MAX_ATTEMPTS,
    };
  }

  /**
   * Poller options for waiting on a CloudWatch Logs Insights query: jittered
   * backoff from 500ms to 10s, up to 60 checks.
   *
   * @returns {@link M3LPoller} constructor options.
   */
  static cloudWatchLogsQuery(): M3LPollerOptions {
    return {
      backoff: M3LBackoff.exponentialJittered(CWL_START_MS, CWL_CAP_MS),
      maxAttempts: CWL_MAX_ATTEMPTS,
    };
  }

  /**
   * Retry-runner options for AWS throttling: combines the throttling and
   * network classifiers over jittered backoff from 200ms to 5s, treating
   * unclassified errors as fatal.
   *
   * @returns {@link M3LRetryRunner} constructor options.
   */
  static awsThrottling(): M3LRetryRunnerOptions {
    return {
      classifier: combineClassifiers(
        awsThrottlingClassifier,
        awsNetworkClassifier,
      ),
      backoff: M3LBackoff.exponentialJittered(
        AWS_THROTTLING_START_MS,
        AWS_THROTTLING_CAP_MS,
      ),
      unknownDecision: "fatal",
    };
  }

  /**
   * Retry-runner options for HTTP downloads: HTTP status plus network
   * classifiers over jittered backoff from 500ms to 15s.
   *
   * @returns {@link M3LRetryRunner} constructor options.
   */
  static httpDownload(): M3LRetryRunnerOptions {
    return {
      classifier: combineClassifiers(
        httpRetryAfterClassifier,
        awsNetworkClassifier,
      ),
      backoff: M3LBackoff.exponentialJittered(
        HTTP_DOWNLOAD_START_MS,
        HTTP_DOWNLOAD_CAP_MS,
      ),
      unknownDecision: "fatal",
    };
  }

  /**
   * Retry-runner options for SQS batch sends: throttling plus network
   * classifiers over exponential backoff from 100ms to 3s.
   *
   * @returns {@link M3LRetryRunner} constructor options.
   */
  static sqsBatchSend(): M3LRetryRunnerOptions {
    return {
      classifier: combineClassifiers(
        awsThrottlingClassifier,
        awsNetworkClassifier,
      ),
      backoff: M3LBackoff.exponential(SQS_START_MS, SQS_CAP_MS),
      unknownDecision: "fatal",
    };
  }
}
