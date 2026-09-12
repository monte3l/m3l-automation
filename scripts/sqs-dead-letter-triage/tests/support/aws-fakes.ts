import { vi } from "vitest";

import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

/**
 * Builds a plain-object fake of `AWS.M3LSQSOperations`'s `receive` /
 * `getQueueAttributes` methods — the only two this slice's steps call.
 * `M3LSQSOperations` is a concrete class with a private field, so a
 * structural object literal is cast through `unknown`, mirroring
 * `scripts/sqs-etl/tests/support/sqsFakes.ts`'s established pattern.
 *
 * `drain-queue.ts` never constructs its own `M3LSQSOperations` — it is
 * always an injected dependency, so this fake never touches
 * `@aws-sdk/client-sqs`.
 */
export function createFakeSqsOperations(overrides?: {
  readonly receive?: ReturnType<typeof vi.fn>;
  readonly getQueueAttributes?: ReturnType<typeof vi.fn>;
  readonly sendBatch?: ReturnType<typeof vi.fn>;
  readonly deleteBatch?: ReturnType<typeof vi.fn>;
}): AWS.M3LSQSOperations {
  const fake = {
    receive: overrides?.receive ?? vi.fn().mockResolvedValue([]),
    getQueueAttributes:
      overrides?.getQueueAttributes ??
      vi.fn().mockResolvedValue({
        approximateNumberOfMessages: 0,
        approximateNumberOfMessagesNotVisible: 0,
        approximateNumberOfMessagesDelayed: 0,
        queueArn: "arn:aws:sqs:us-east-1:000000000000:fake-queue",
      }),
    // Used by `execute-actions.ts` (PR 3b): `sendBatch`/`deleteBatch` default
    // to an all-successful, empty-failure result so a test that does not care
    // about batch failures does not have to configure one.
    sendBatch:
      overrides?.sendBatch ??
      vi.fn().mockResolvedValue({ successful: [], failed: [] }),
    deleteBatch:
      overrides?.deleteBatch ??
      vi.fn().mockResolvedValue({ successful: [], failed: [] }),
  };
  return fake as unknown as AWS.M3LSQSOperations;
}

/**
 * Builds a plain-object fake of `AWS.M3LDynamoDBOperations`'s `getItem`
 * method — the only one `lookup-entity.ts` calls. Same cast-through-`unknown`
 * pattern as {@link createFakeSqsOperations}: the real class has private
 * client fields a structural literal cannot satisfy.
 */
export function createFakeDynamoDBOperations(overrides?: {
  readonly getItem?: ReturnType<typeof vi.fn>;
}): AWS.M3LDynamoDBOperations {
  const fake = {
    getItem: overrides?.getItem ?? vi.fn().mockResolvedValue(undefined),
  };
  return fake as unknown as AWS.M3LDynamoDBOperations;
}

/** One captured log event: category, message, and any structured data. */
export interface RecordedLogEvent {
  readonly category: string;
  readonly message: string;
  readonly data: Record<string, unknown> | undefined;
}

/**
 * A recording `M3LLogger` double: captures every emitted event (category,
 * message, structured data) in emission order, so a test can assert on what
 * was logged — and, just as importantly, what was NOT (e.g. that a body
 * excerpt or a lookup key never reaches a log line).
 */
export function createRecordingLogger(): {
  readonly logger: Core.M3LLogger;
  readonly events: readonly RecordedLogEvent[];
} {
  const events: RecordedLogEvent[] = [];
  const handler: Core.M3LLoggerHandler = {
    handle(event) {
      events.push({
        category: event.category,
        message: event.message,
        data: event.data,
      });
    },
    reset() {
      events.length = 0;
    },
  };
  return { logger: new Core.M3LLogger([handler]), events };
}
