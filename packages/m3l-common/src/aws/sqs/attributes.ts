/**
 * `aws/sqs/attributes` — module-private helpers behind
 * {@link M3LSQSOperations.getQueueAttributes}. Extracted from `aws/sqs/client`
 * to keep that file inside the per-file size budget (ADR-0072).
 *
 * This module is **not** part of the public surface: it is not re-exported
 * from `aws/sqs/index` and has no entry in the `exports` map.
 *
 * @packageDocumentation
 */

import type { QueueAttributeName } from "@aws-sdk/client-sqs";

import { M3LSQSOperationError } from "./error.js";
import type {
  M3LSQSRedriveAllowPolicy,
  M3LSQSRedrivePermission,
  M3LSQSRedrivePolicy,
} from "./types.js";

/**
 * The seven `QueueAttributeName`s requested by
 * {@link M3LSQSOperations.getQueueAttributes} — never `"All"`.
 */
export const GET_QUEUE_ATTRIBUTE_NAMES: readonly QueueAttributeName[] = [
  "ApproximateNumberOfMessages",
  "ApproximateNumberOfMessagesNotVisible",
  "ApproximateNumberOfMessagesDelayed",
  "QueueArn",
  "FifoQueue",
  "RedrivePolicy",
  "RedriveAllowPolicy",
];

/**
 * Reads a required attribute from a `GetQueueAttributes` response map,
 * throwing {@link M3LSQSOperationError} when the key is absent.
 *
 * @param attrs - The SDK response's `Attributes` map.
 * @param name - The `QueueAttributeName` to read.
 * @param queueUrl - The queue URL, for the error message.
 * @returns The attribute's string value.
 * @throws {@link M3LSQSOperationError} when the attribute is absent.
 */
export function readRequiredAttribute(
  attrs: Partial<Record<QueueAttributeName, string>>,
  name: QueueAttributeName,
  queueUrl: string,
): string {
  const value = Object.hasOwn(attrs, name) ? attrs[name] : undefined;
  if (value === undefined) {
    throw new M3LSQSOperationError(
      `getQueueAttributes: GetQueueAttributes response is missing required attribute "${String(name)}" for queueUrl=${queueUrl}`,
    );
  }
  return value;
}

/**
 * Parses a raw SQS counter string to a finite `number`, throwing
 * {@link M3LSQSOperationError} when the value is empty, whitespace-only,
 * not a non-negative decimal integer string, or otherwise not finite.
 *
 * Empty and whitespace-only strings are rejected before coercion because
 * `Number("")` and `Number(" ")` both return `0`, which is finite — they would
 * silently resolve as `0` without this guard, contradicting the TSDoc contract.
 *
 * Only unpadded non-negative decimal integer strings (matching `/^\d+$/` on the
 * raw value) are accepted. Hex literals (`"0x10"`), scientific notation
 * (`"1e5"`), negative values (`"-5"`), and whitespace-padded values (`"  12  "`)
 * are categorically malformed for SQS counters and are rejected with a typed
 * error rather than silently resolving to a plausible-but-wrong number.
 *
 * @param raw - The raw string value from the `Attributes` map.
 * @param name - The attribute name, for the error message.
 * @param queueUrl - The queue URL, for the error message.
 * @returns A finite `number`.
 * @throws {@link M3LSQSOperationError} when `raw` is empty, whitespace-only,
 *   not an unpadded non-negative decimal integer string, or does not resolve to
 *   a finite number.
 */
function parseFiniteCounter(
  raw: string,
  name: string,
  queueUrl: string,
): number {
  if (raw.trim() === "") {
    throw new M3LSQSOperationError(
      `getQueueAttributes: counter "${name}" is empty or whitespace for queueUrl=${queueUrl}`,
    );
  }
  // Reject hex literals, scientific notation, negative values, and any
  // leading/trailing whitespace — SQS reports counters as plain unpadded
  // non-negative decimal integer strings only. The pattern tests `raw`
  // directly (not trimmed) so that '  12  ' is rejected as malformed.
  // Pattern is non-backtracking: one non-overlapping character class, no
  // nested quantifier.
  if (!/^\d+$/.test(raw)) {
    throw new M3LSQSOperationError(
      `getQueueAttributes: counter "${name}" is not a non-negative decimal integer for queueUrl=${queueUrl}`,
    );
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new M3LSQSOperationError(
      `getQueueAttributes: counter "${name}" is not a finite number for queueUrl=${queueUrl}`,
    );
  }
  return n;
}

/**
 * Reads and parses a required numeric attribute from a `GetQueueAttributes`
 * response map, combining {@link readRequiredAttribute} and
 * `parseFiniteCounter` in one call.
 *
 * @param attrs - The SDK response's `Attributes` map.
 * @param name - The `QueueAttributeName` to read and parse.
 * @param queueUrl - The queue URL, for the error message.
 * @returns A finite `number`.
 * @throws {@link M3LSQSOperationError} when the attribute is absent, empty,
 *   whitespace-only, not an unpadded non-negative decimal integer string, or
 *   does not resolve to a finite number.
 */
export function readRequiredCounter(
  attrs: Partial<Record<QueueAttributeName, string>>,
  name: QueueAttributeName,
  queueUrl: string,
): number {
  return parseFiniteCounter(
    readRequiredAttribute(attrs, name, queueUrl),
    String(name),
    queueUrl,
  );
}

/**
 * Reads an optional attribute from a `GetQueueAttributes` response map,
 * returning `undefined` when the key is absent (own-property check only).
 *
 * @param attrs - The SDK response's `Attributes` map.
 * @param name - The `QueueAttributeName` to read.
 * @returns The string value, or `undefined` when absent.
 */
export function readOptionalAttribute(
  attrs: Partial<Record<QueueAttributeName, string>>,
  name: QueueAttributeName,
): string | undefined {
  return Object.hasOwn(attrs, name) ? attrs[name] : undefined;
}

/**
 * Runtime membership set for the {@link M3LSQSRedrivePermission} union. Keyed
 * as a `Record<M3LSQSRedrivePermission, true>` so the compiler rejects both a
 * missing and an excess key — adding a union member becomes a compile error
 * rather than a silent runtime miss.
 */
const REDRIVE_PERMISSION_SET: Record<M3LSQSRedrivePermission, true> = {
  allowAll: true,
  denyAll: true,
  byQueue: true,
};

/**
 * Parses and shape-validates the `RedrivePolicy` JSON string from a
 * `GetQueueAttributes` response into a typed {@link M3LSQSRedrivePolicy}.
 *
 * The raw `SyntaxError` from a malformed payload is intentionally NOT chained
 * as `cause` and NOT included in the message — Node's `SyntaxError` message
 * embeds a snippet of the input, which may be sensitive. Only the attribute
 * name and queue URL are included.
 *
 * @param raw - The raw JSON string from the `RedrivePolicy` attribute.
 * @param queueUrl - The queue URL, for the error message.
 * @returns The parsed {@link M3LSQSRedrivePolicy}.
 * @throws {@link M3LSQSOperationError} when the JSON is malformed, not a plain
 *   object, or missing/wrong-typed `deadLetterTargetArn` or `maxReceiveCount`.
 */
export function parseRedrivePolicy(
  raw: string,
  queueUrl: string,
): M3LSQSRedrivePolicy {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Do not chain the SyntaxError as cause: Node's SyntaxError message
    // embeds a snippet of the parsed content, which library-src.md forbids
    // leaking at the library boundary. Name only the attribute and queue URL.
    throw new M3LSQSOperationError(
      `getQueueAttributes: malformed RedrivePolicy JSON for queueUrl=${queueUrl}`,
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new M3LSQSOperationError(
      `getQueueAttributes: RedrivePolicy is not a plain object for queueUrl=${queueUrl}`,
    );
  }
  // Cast to record for field access — the above check proved it is a non-null,
  // non-array object (i.e. a plain object).
  const record = parsed as Record<string, unknown>;

  const deadLetterTargetArn = Object.hasOwn(record, "deadLetterTargetArn")
    ? record["deadLetterTargetArn"]
    : undefined;
  if (typeof deadLetterTargetArn !== "string") {
    throw new M3LSQSOperationError(
      `getQueueAttributes: RedrivePolicy.deadLetterTargetArn is missing or not a string for queueUrl=${queueUrl}`,
    );
  }

  const maxReceiveCount = Object.hasOwn(record, "maxReceiveCount")
    ? record["maxReceiveCount"]
    : undefined;
  if (
    typeof maxReceiveCount !== "number" ||
    !Number.isFinite(maxReceiveCount)
  ) {
    throw new M3LSQSOperationError(
      `getQueueAttributes: RedrivePolicy.maxReceiveCount is missing or not a finite number for queueUrl=${queueUrl}`,
    );
  }

  return { deadLetterTargetArn, maxReceiveCount };
}

// Module-private helper for parseRedriveAllowPolicy. Validates and returns
// the `sourceQueueArns` array when the key is an own property of `record`,
// or `undefined` when the key is absent. Throws on a present-but-malformed value.
function extractSourceQueueArns(
  record: Record<string, unknown>,
  queueUrl: string,
): readonly string[] | undefined {
  if (!Object.hasOwn(record, "sourceQueueArns")) {
    return undefined;
  }
  const rawArns = record["sourceQueueArns"];
  if (
    !Array.isArray(rawArns) ||
    !rawArns.every((arn): arn is string => typeof arn === "string")
  ) {
    throw new M3LSQSOperationError(
      `getQueueAttributes: RedriveAllowPolicy.sourceQueueArns must be a string array for queueUrl=${queueUrl}`,
    );
  }
  // Spread into a new readonly array so the caller owns a fresh copy.
  return [...rawArns];
}

/**
 * Parses and shape-validates the `RedriveAllowPolicy` JSON string from a
 * `GetQueueAttributes` response into a typed {@link M3LSQSRedriveAllowPolicy}.
 *
 * The raw `SyntaxError` from a malformed payload is intentionally NOT chained
 * as `cause` and NOT included in the message — see {@link parseRedrivePolicy}.
 *
 * The `redrivePermission` union is validated against
 * `REDRIVE_PERMISSION_SET` — a `Record<M3LSQSRedrivePermission, true>` keyed
 * off the union literal so that adding a member is a compile error, not a
 * silent runtime miss.
 *
 * @param raw - The raw JSON string from the `RedriveAllowPolicy` attribute.
 * @param queueUrl - The queue URL, for the error message.
 * @returns The parsed {@link M3LSQSRedriveAllowPolicy}.
 * @throws {@link M3LSQSOperationError} when the JSON is malformed; not a plain
 *   object; `redrivePermission` is missing, not a string, or outside the
 *   closed union; or `sourceQueueArns` is present but not an all-string array.
 */
export function parseRedriveAllowPolicy(
  raw: string,
  queueUrl: string,
): M3LSQSRedriveAllowPolicy {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Same rationale as parseRedrivePolicy: do not chain or echo the raw
    // SyntaxError message.
    throw new M3LSQSOperationError(
      `getQueueAttributes: malformed RedriveAllowPolicy JSON for queueUrl=${queueUrl}`,
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new M3LSQSOperationError(
      `getQueueAttributes: RedriveAllowPolicy is not a plain object for queueUrl=${queueUrl}`,
    );
  }
  // Cast to record for field access — the above check proved it is a non-null,
  // non-array object (i.e. a plain object).
  const record = parsed as Record<string, unknown>;

  if (
    !Object.hasOwn(record, "redrivePermission") ||
    typeof record["redrivePermission"] !== "string" ||
    !Object.hasOwn(REDRIVE_PERMISSION_SET, record["redrivePermission"])
  ) {
    throw new M3LSQSOperationError(
      `getQueueAttributes: RedriveAllowPolicy.redrivePermission is missing or not a valid permission for queueUrl=${queueUrl}`,
    );
  }
  // Safe cast: Object.hasOwn + typeof "string" + REDRIVE_PERMISSION_SET membership proves the union.
  const permission = record["redrivePermission"] as M3LSQSRedrivePermission;

  // Extracted into a helper to keep parseRedriveAllowPolicy within the cyclomatic
  // complexity ceiling (complexity rule, max 10): adding the Object.hasOwn guard
  // on redrivePermission required one extra branch, reclaimed here.
  const sourceQueueArns = extractSourceQueueArns(record, queueUrl);
  if (sourceQueueArns !== undefined) {
    return { redrivePermission: permission, sourceQueueArns };
  }

  return { redrivePermission: permission };
}
