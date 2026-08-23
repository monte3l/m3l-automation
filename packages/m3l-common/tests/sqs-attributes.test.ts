/**
 * Tests for the getQueueAttributes() operation in the aws/sqs submodule.
 *
 * Contract source: docs/reference/aws/sqs.md, ADR-0026.
 *
 * Split from sqs.test.ts per ADR-0072 (test-file size ceiling).
 * Source for the helpers under test now lives in
 * packages/m3l-common/src/aws/sqs/attributes.ts.
 *
 * Mocking strategy: `@aws-sdk/client-sqs` is mocked with a top-level
 * `vi.mock` + `vi.hoisted` bag (this repo's convention — see
 * `tests/clients.test.ts`), extended with a `.send()` spy dispatching by
 * command class.
 */

import { beforeEach, describe, expect, expectTypeOf, test, vi } from "vitest";

// vi.hoisted: mutable spies referenced by the hoisted `vi.mock` factory below.
const h = vi.hoisted(() => {
  const send = vi.fn();
  const destroy = vi.fn();

  class GetQueueAttributesCommand {
    constructor(readonly input: unknown) {}
  }
  class SQSClient {
    readonly config: unknown;
    send = send;
    destroy = destroy;
    constructor(config?: unknown) {
      this.config = config;
    }
  }

  return {
    send,
    destroy,
    SQSClient,
    GetQueueAttributesCommand,
  };
});

vi.mock("@aws-sdk/client-sqs", () => ({
  SQSClient: h.SQSClient,
  GetQueueAttributesCommand: h.GetQueueAttributesCommand,
}));

import type {
  M3LSQSQueueAttributes,
  M3LSQSRedriveAllowPolicy,
  M3LSQSRedrivePermission,
  M3LSQSRedrivePolicy,
} from "../src/aws/sqs/index.js";
import {
  M3LSQSOperationError,
  M3LSQSOperations,
} from "../src/aws/sqs/index.js";

import type { SQSClient } from "@aws-sdk/client-sqs";

const QUEUE_URL =
  "https://sqs.eu-south-1.amazonaws.com/123456789012/test-queue";

/** Casts the hoisted fake `SQSClient` (mocked shape) to the real SDK type for construction. */
function fakeClient(): SQSClient {
  return new h.SQSClient() as unknown as SQSClient;
}

describe("M3LSQSOperations", () => {
  beforeEach(() => {
    h.send.mockReset();
    h.destroy.mockReset();
  });

  describe("getQueueAttributes()", () => {
    const FIFO_QUEUE_URL =
      "https://sqs.eu-south-1.amazonaws.com/123456789012/test-queue.fifo";

    /** Minimal valid SQS GetQueueAttributes Attributes map for a standard (non-FIFO) queue. */
    function standardQueueAttributes(): Record<string, string> {
      return {
        ApproximateNumberOfMessages: "5",
        ApproximateNumberOfMessagesNotVisible: "2",
        ApproximateNumberOfMessagesDelayed: "0",
        QueueArn: "arn:aws:sqs:eu-south-1:123456789012:test-queue",
      };
    }

    /** Full Attributes map for a FIFO queue with all optional fields present. */
    function fifoQueueAttributes(): Record<string, string> {
      return {
        ApproximateNumberOfMessages: "10",
        ApproximateNumberOfMessagesNotVisible: "3",
        ApproximateNumberOfMessagesDelayed: "1",
        QueueArn: "arn:aws:sqs:eu-south-1:123456789012:test-queue.fifo",
        FifoQueue: "true",
        RedrivePolicy:
          '{"maxReceiveCount":5,"deadLetterTargetArn":"arn:aws:sqs:eu-south-1:123456789012:dlq"}',
        RedriveAllowPolicy: '{"redrivePermission":"allowAll"}',
      };
    }

    test("happy path: resolves with a fully-populated M3LSQSQueueAttributes for a FIFO queue with all optional fields present", async () => {
      h.send.mockResolvedValueOnce({ Attributes: fifoQueueAttributes() });
      const operations = new M3LSQSOperations(fakeClient());

      const result = await operations.getQueueAttributes(FIFO_QUEUE_URL);

      expect(result).toEqual({
        approximateNumberOfMessages: 10,
        approximateNumberOfMessagesNotVisible: 3,
        approximateNumberOfMessagesDelayed: 1,
        queueArn: "arn:aws:sqs:eu-south-1:123456789012:test-queue.fifo",
        fifoQueue: true,
        // redrivePolicy is now a parsed object, not the raw JSON string.
        redrivePolicy: {
          deadLetterTargetArn: "arn:aws:sqs:eu-south-1:123456789012:dlq",
          maxReceiveCount: 5,
        },
        // redriveAllowPolicy is a parsed object; allowAll has no sourceQueueArns.
        redriveAllowPolicy: {
          redrivePermission: "allowAll",
        },
      });
    });

    test("issues exactly one GetQueueAttributesCommand with QueueUrl and the explicit seven-attribute AttributeNames list, NOT 'All'", async () => {
      h.send.mockResolvedValueOnce({ Attributes: standardQueueAttributes() });
      const operations = new M3LSQSOperations(fakeClient());

      await operations.getQueueAttributes(QUEUE_URL);

      expect(h.send).toHaveBeenCalledTimes(1);
      const [command] = h.send.mock.calls[0] as [
        { input: Record<string, unknown> },
      ];
      expect(command).toBeInstanceOf(h.GetQueueAttributesCommand);
      expect(command.input).toMatchObject({ QueueUrl: QUEUE_URL });
      const attrNames = command.input["AttributeNames"] as string[];
      expect(attrNames).toHaveLength(7);
      expect(attrNames).toContain("ApproximateNumberOfMessages");
      expect(attrNames).toContain("ApproximateNumberOfMessagesNotVisible");
      expect(attrNames).toContain("ApproximateNumberOfMessagesDelayed");
      expect(attrNames).toContain("QueueArn");
      expect(attrNames).toContain("FifoQueue");
      expect(attrNames).toContain("RedrivePolicy");
      expect(attrNames).toContain("RedriveAllowPolicy");
      expect(attrNames).not.toContain("All");
    });

    test("minimal fixture: absent FifoQueue yields fifoQueue: false; absent RedrivePolicy and RedriveAllowPolicy are omitted, not set to undefined", async () => {
      // Standard (non-FIFO) queue: FifoQueue, RedrivePolicy, RedriveAllowPolicy all absent.
      h.send.mockResolvedValueOnce({ Attributes: standardQueueAttributes() });
      const operations = new M3LSQSOperations(fakeClient());

      const result = await operations.getQueueAttributes(QUEUE_URL);

      expect(result.fifoQueue).toBe(false);
      // exactOptionalPropertyTypes: the key must be absent (Object.hasOwn
      // returns false), not set to an explicit `undefined`.
      expect(Object.hasOwn(result, "redrivePolicy")).toBe(false);
      expect(Object.hasOwn(result, "redriveAllowPolicy")).toBe(false);
    });

    test("FifoQueue string 'false' maps to boolean false (not absent)", async () => {
      h.send.mockResolvedValueOnce({
        Attributes: { ...standardQueueAttributes(), FifoQueue: "false" },
      });
      const operations = new M3LSQSOperations(fakeClient());

      const result = await operations.getQueueAttributes(QUEUE_URL);

      expect(result.fifoQueue).toBe(false);
    });

    test("malformed: throws M3LSQSOperationError when the response has no Attributes map", async () => {
      h.send.mockResolvedValueOnce({});
      const operations = new M3LSQSOperations(fakeClient());

      let thrown: unknown;
      try {
        await operations.getQueueAttributes(QUEUE_URL);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LSQSOperationError);
    });

    test("malformed: throws M3LSQSOperationError when a counter attribute is non-numeric — must not silently produce NaN", async () => {
      h.send.mockResolvedValueOnce({
        Attributes: {
          ...standardQueueAttributes(),
          ApproximateNumberOfMessages: "abc",
        },
      });
      const operations = new M3LSQSOperations(fakeClient());

      // Must throw rather than resolve with NaN on the counter field.
      await expect(
        operations.getQueueAttributes(QUEUE_URL),
      ).rejects.toBeInstanceOf(M3LSQSOperationError);
    });

    test("malformed: throws M3LSQSOperationError when QueueArn is absent — cannot silently default to ''", async () => {
      // Deliberately build the fixture without QueueArn — it is required in
      // M3LSQSQueueAttributes and must be loud if missing, not defaulted to "".
      h.send.mockResolvedValueOnce({
        Attributes: {
          ApproximateNumberOfMessages: "5",
          ApproximateNumberOfMessagesNotVisible: "2",
          ApproximateNumberOfMessagesDelayed: "0",
          // QueueArn intentionally absent
        },
      });
      const operations = new M3LSQSOperations(fakeClient());

      await expect(
        operations.getQueueAttributes(QUEUE_URL),
      ).rejects.toBeInstanceOf(M3LSQSOperationError);
    });

    test("request failure: rejects M3LSQSOperationError with cause chained and queue URL in the message", async () => {
      const sdkError = new Error("network blip");
      h.send.mockRejectedValueOnce(sdkError);
      const operations = new M3LSQSOperations(fakeClient());

      let thrown: unknown;
      try {
        await operations.getQueueAttributes(QUEUE_URL);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LSQSOperationError);
      expect((thrown as M3LSQSOperationError).cause).toBe(sdkError);
      expect((thrown as M3LSQSOperationError).message).toContain(QUEUE_URL);
    });

    test("retries once on a ThrottlingException then succeeds (send called exactly twice)", async () => {
      vi.useFakeTimers();
      try {
        h.send
          .mockRejectedValueOnce(
            Object.assign(new Error("throttled"), {
              name: "ThrottlingException",
            }),
          )
          .mockResolvedValueOnce({ Attributes: standardQueueAttributes() });

        const operations = new M3LSQSOperations(fakeClient());

        let result: M3LSQSQueueAttributes | undefined;
        let thrown: unknown;
        const run = (async () => {
          try {
            result = await operations.getQueueAttributes(QUEUE_URL);
          } catch (error) {
            thrown = error;
          }
        })();
        await vi.advanceTimersByTimeAsync(5_000);
        await run;

        expect(thrown).toBeUndefined();
        expect(result?.queueArn).toBe(
          "arn:aws:sqs:eu-south-1:123456789012:test-queue",
        );
        expect(h.send).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    test("exhausted retries: rejects M3LSQSOperationError with cause=throttle error after exactly 10 attempts", async () => {
      vi.useFakeTimers();
      try {
        const throttleError = Object.assign(new Error("throttled"), {
          name: "ThrottlingException",
        });
        h.send.mockRejectedValue(throttleError);

        const operations = new M3LSQSOperations(fakeClient());

        let thrown: unknown;
        const run = (async () => {
          try {
            await operations.getQueueAttributes(QUEUE_URL);
          } catch (error) {
            thrown = error;
          }
        })();
        await vi.advanceTimersByTimeAsync(60_000);
        await run;

        expect(thrown).toBeInstanceOf(M3LSQSOperationError);
        expect((thrown as M3LSQSOperationError).cause).toBe(throttleError);
        expect(h.send).toHaveBeenCalledTimes(10);
      } finally {
        vi.useRealTimers();
      }
    });

    test("an unrecognized SDK error is fatal, not retried (send called exactly once)", async () => {
      h.send.mockRejectedValue(
        Object.assign(new Error("denied"), { name: "AccessDeniedException" }),
      );
      const operations = new M3LSQSOperations(fakeClient());

      await expect(
        operations.getQueueAttributes(QUEUE_URL),
      ).rejects.toBeInstanceOf(M3LSQSOperationError);
      expect(h.send).toHaveBeenCalledTimes(1);
    });

    test("type-level: M3LSQSQueueAttributes fields match the documented contract", () => {
      expectTypeOf<
        M3LSQSQueueAttributes["approximateNumberOfMessages"]
      >().toEqualTypeOf<number>();
      expectTypeOf<
        M3LSQSQueueAttributes["approximateNumberOfMessagesNotVisible"]
      >().toEqualTypeOf<number>();
      expectTypeOf<
        M3LSQSQueueAttributes["approximateNumberOfMessagesDelayed"]
      >().toEqualTypeOf<number>();
      expectTypeOf<M3LSQSQueueAttributes["queueArn"]>().toEqualTypeOf<string>();
      expectTypeOf<
        M3LSQSQueueAttributes["fifoQueue"]
      >().toEqualTypeOf<boolean>();
      // Optional fields are now parsed object types, not raw strings.
      expectTypeOf<M3LSQSQueueAttributes["redrivePolicy"]>().toEqualTypeOf<
        M3LSQSRedrivePolicy | undefined
      >();
      expectTypeOf<M3LSQSQueueAttributes["redriveAllowPolicy"]>().toEqualTypeOf<
        M3LSQSRedriveAllowPolicy | undefined
      >();
      // M3LSQSRedrivePolicy interface shape.
      expectTypeOf<
        M3LSQSRedrivePolicy["deadLetterTargetArn"]
      >().toEqualTypeOf<string>();
      expectTypeOf<
        M3LSQSRedrivePolicy["maxReceiveCount"]
      >().toEqualTypeOf<number>();
      // M3LSQSRedriveAllowPolicy interface shape.
      expectTypeOf<
        M3LSQSRedriveAllowPolicy["redrivePermission"]
      >().toEqualTypeOf<M3LSQSRedrivePermission>();
      expectTypeOf<M3LSQSRedriveAllowPolicy["sourceQueueArns"]>().toEqualTypeOf<
        readonly string[] | undefined
      >();
      // M3LSQSRedrivePermission is a closed union.
      expectTypeOf<M3LSQSRedrivePermission>().toEqualTypeOf<
        "allowAll" | "denyAll" | "byQueue"
      >();
    });

    // Group A — counter regression: empty/whitespace strings are 0 and finite
    // under Number(), so a naive Number() guard silently resolves to 0.  The
    // wrapper must reject these rather than returning a misleading zero count.

    test("counter regression A1: empty string for ApproximateNumberOfMessages throws M3LSQSOperationError (must NOT resolve to 0)", async () => {
      h.send.mockResolvedValueOnce({
        Attributes: {
          ...standardQueueAttributes(),
          ApproximateNumberOfMessages: "",
        },
      });
      const operations = new M3LSQSOperations(fakeClient());

      await expect(
        operations.getQueueAttributes(QUEUE_URL),
      ).rejects.toBeInstanceOf(M3LSQSOperationError);
    });

    test("counter regression A2: whitespace-only string for ApproximateNumberOfMessages throws M3LSQSOperationError (Number('   ') === 0 and is finite — not a valid count)", async () => {
      h.send.mockResolvedValueOnce({
        Attributes: {
          ...standardQueueAttributes(),
          ApproximateNumberOfMessages: "   ",
        },
      });
      const operations = new M3LSQSOperations(fakeClient());

      await expect(
        operations.getQueueAttributes(QUEUE_URL),
      ).rejects.toBeInstanceOf(M3LSQSOperationError);
    });

    test('counter regression A3: legitimate "0" resolves to the number 0 — the empty-string fix must not break the zero case', async () => {
      h.send.mockResolvedValueOnce({
        Attributes: {
          ...standardQueueAttributes(),
          ApproximateNumberOfMessages: "0",
        },
      });
      const operations = new M3LSQSOperations(fakeClient());

      const result = await operations.getQueueAttributes(QUEUE_URL);

      expect(result.approximateNumberOfMessages).toBe(0);
    });

    // Group B — redrivePolicy JSON parsing.

    test("redrivePolicy B1: well-formed JSON resolves to a parsed object with maxReceiveCount as a number, not the string", async () => {
      h.send.mockResolvedValueOnce({
        Attributes: {
          ...standardQueueAttributes(),
          RedrivePolicy:
            '{"deadLetterTargetArn":"arn:aws:sqs:eu-west-1:123456789012:orders-dlq","maxReceiveCount":5}',
        },
      });
      const operations = new M3LSQSOperations(fakeClient());

      const result = await operations.getQueueAttributes(QUEUE_URL);

      expect(result.redrivePolicy).toEqual({
        deadLetterTargetArn: "arn:aws:sqs:eu-west-1:123456789012:orders-dlq",
        maxReceiveCount: 5,
      });
      expect(typeof result.redrivePolicy?.maxReceiveCount).toBe("number");
    });

    test("redrivePolicy B2: malformed JSON throws M3LSQSOperationError — not a raw SyntaxError; message must not embed the raw payload", async () => {
      h.send.mockResolvedValueOnce({
        Attributes: {
          ...standardQueueAttributes(),
          RedrivePolicy: "{not json",
        },
      });
      const operations = new M3LSQSOperations(fakeClient());

      let thrown: unknown;
      try {
        await operations.getQueueAttributes(QUEUE_URL);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LSQSOperationError);
      // The error message must not echo the raw policy JSON back to the caller.
      expect((thrown as M3LSQSOperationError).message).not.toContain(
        "{not json",
      );
    });

    test("redrivePolicy B3a: valid JSON with maxReceiveCount as a string (wrong shape) throws M3LSQSOperationError", async () => {
      h.send.mockResolvedValueOnce({
        Attributes: {
          ...standardQueueAttributes(),
          RedrivePolicy:
            '{"deadLetterTargetArn":"arn:aws:sqs:eu-west-1:123456789012:orders-dlq","maxReceiveCount":"5"}',
        },
      });
      const operations = new M3LSQSOperations(fakeClient());

      await expect(
        operations.getQueueAttributes(QUEUE_URL),
      ).rejects.toBeInstanceOf(M3LSQSOperationError);
    });

    test("redrivePolicy B3b: valid JSON missing deadLetterTargetArn (wrong shape) throws M3LSQSOperationError", async () => {
      h.send.mockResolvedValueOnce({
        Attributes: {
          ...standardQueueAttributes(),
          RedrivePolicy: '{"maxReceiveCount":5}',
        },
      });
      const operations = new M3LSQSOperations(fakeClient());

      await expect(
        operations.getQueueAttributes(QUEUE_URL),
      ).rejects.toBeInstanceOf(M3LSQSOperationError);
    });

    test("redrivePolicy B4: valid JSON that is not an object (array literal) throws M3LSQSOperationError", async () => {
      h.send.mockResolvedValueOnce({
        Attributes: {
          ...standardQueueAttributes(),
          RedrivePolicy: "[]",
        },
      });
      const operations = new M3LSQSOperations(fakeClient());

      await expect(
        operations.getQueueAttributes(QUEUE_URL),
      ).rejects.toBeInstanceOf(M3LSQSOperationError);
    });

    // Group C — redriveAllowPolicy JSON parsing.

    test("redriveAllowPolicy C1: byQueue permission with sourceQueueArns resolves with a string array", async () => {
      h.send.mockResolvedValueOnce({
        Attributes: {
          ...standardQueueAttributes(),
          RedriveAllowPolicy:
            '{"redrivePermission":"byQueue","sourceQueueArns":["arn:aws:sqs:eu-west-1:123456789012:orders"]}',
        },
      });
      const operations = new M3LSQSOperations(fakeClient());

      const result = await operations.getQueueAttributes(QUEUE_URL);

      expect(result.redriveAllowPolicy).toEqual({
        redrivePermission: "byQueue",
        sourceQueueArns: ["arn:aws:sqs:eu-west-1:123456789012:orders"],
      });
      expect(Array.isArray(result.redriveAllowPolicy?.sourceQueueArns)).toBe(
        true,
      );
    });

    test("redriveAllowPolicy C2: allowAll permission without sourceQueueArns resolves with the key absent (exactOptionalPropertyTypes)", async () => {
      h.send.mockResolvedValueOnce({
        Attributes: {
          ...standardQueueAttributes(),
          RedriveAllowPolicy: '{"redrivePermission":"allowAll"}',
        },
      });
      const operations = new M3LSQSOperations(fakeClient());

      const result = await operations.getQueueAttributes(QUEUE_URL);

      const policy = result.redriveAllowPolicy;
      expect(policy).toBeDefined();
      expect(policy?.redrivePermission).toBe("allowAll");
      // exactOptionalPropertyTypes: the key must be absent, not set to undefined.
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- policy proven defined by the assertion above; expect() does not narrow TS types
      expect(Object.hasOwn(policy!, "sourceQueueArns")).toBe(false);
    });

    test("redriveAllowPolicy C3: unrecognised redrivePermission value throws M3LSQSOperationError (the union is closed)", async () => {
      h.send.mockResolvedValueOnce({
        Attributes: {
          ...standardQueueAttributes(),
          RedriveAllowPolicy: '{"redrivePermission":"sometimes"}',
        },
      });
      const operations = new M3LSQSOperations(fakeClient());

      await expect(
        operations.getQueueAttributes(QUEUE_URL),
      ).rejects.toBeInstanceOf(M3LSQSOperationError);
    });

    test("redriveAllowPolicy C4: sourceQueueArns containing a non-string element throws M3LSQSOperationError", async () => {
      h.send.mockResolvedValueOnce({
        Attributes: {
          ...standardQueueAttributes(),
          RedriveAllowPolicy:
            '{"redrivePermission":"byQueue","sourceQueueArns":["arn:valid",42]}',
        },
      });
      const operations = new M3LSQSOperations(fakeClient());

      await expect(
        operations.getQueueAttributes(QUEUE_URL),
      ).rejects.toBeInstanceOf(M3LSQSOperationError);
    });

    test("redriveAllowPolicy C5: malformed JSON throws M3LSQSOperationError — not a raw SyntaxError", async () => {
      h.send.mockResolvedValueOnce({
        Attributes: {
          ...standardQueueAttributes(),
          RedriveAllowPolicy: "{bad",
        },
      });
      const operations = new M3LSQSOperations(fakeClient());

      let thrown: unknown;
      try {
        await operations.getQueueAttributes(QUEUE_URL);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LSQSOperationError);
    });

    // Group D — counter parsing strict validation regression.
    // The implementation is tightened from a Number() + isFinite() guard to a
    // /^\d+$/ test on the raw string.  These tests fail against the loose form
    // (silently resolves to a numeric value) and pass against the strict form.

    test("counter parsing D1: hex literal '0x10' throws M3LSQSOperationError — must not silently resolve to 16", async () => {
      h.send.mockResolvedValueOnce({
        Attributes: {
          ...standardQueueAttributes(),
          ApproximateNumberOfMessages: "0x10",
        },
      });
      const operations = new M3LSQSOperations(fakeClient());

      let thrown: unknown;
      try {
        await operations.getQueueAttributes(QUEUE_URL);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LSQSOperationError);
      // Attribute values must never appear verbatim in error messages.
      expect((thrown as M3LSQSOperationError).message).not.toContain("0x10");
    });

    test("counter parsing D2: scientific notation '1e5' throws M3LSQSOperationError — must not silently resolve to 100000", async () => {
      h.send.mockResolvedValueOnce({
        Attributes: {
          ...standardQueueAttributes(),
          ApproximateNumberOfMessages: "1e5",
        },
      });
      const operations = new M3LSQSOperations(fakeClient());

      let thrown: unknown;
      try {
        await operations.getQueueAttributes(QUEUE_URL);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LSQSOperationError);
      expect((thrown as M3LSQSOperationError).message).not.toContain("1e5");
    });

    test("counter parsing D3: negative value '-5' throws M3LSQSOperationError — a negative queue depth is meaningless", async () => {
      h.send.mockResolvedValueOnce({
        Attributes: {
          ...standardQueueAttributes(),
          ApproximateNumberOfMessages: "-5",
        },
      });
      const operations = new M3LSQSOperations(fakeClient());

      let thrown: unknown;
      try {
        await operations.getQueueAttributes(QUEUE_URL);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LSQSOperationError);
      expect((thrown as M3LSQSOperationError).message).not.toContain("-5");
    });

    test("counter parsing D4: non-integer '12.5' throws M3LSQSOperationError — queue depths are always whole numbers", async () => {
      h.send.mockResolvedValueOnce({
        Attributes: {
          ...standardQueueAttributes(),
          ApproximateNumberOfMessages: "12.5",
        },
      });
      const operations = new M3LSQSOperations(fakeClient());

      let thrown: unknown;
      try {
        await operations.getQueueAttributes(QUEUE_URL);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LSQSOperationError);
      expect((thrown as M3LSQSOperationError).message).not.toContain("12.5");
    });

    test("counter parsing D5: padded decimal '  12  ' throws M3LSQSOperationError — only unpadded decimal strings are accepted", async () => {
      h.send.mockResolvedValueOnce({
        Attributes: {
          ...standardQueueAttributes(),
          ApproximateNumberOfMessages: "  12  ",
        },
      });
      const operations = new M3LSQSOperations(fakeClient());

      await expect(
        operations.getQueueAttributes(QUEUE_URL),
      ).rejects.toBeInstanceOf(M3LSQSOperationError);
    });

    test("counter parsing sanity D6: '0' still resolves to 0 — strict /^\\d+$/ must not reject the zero case", async () => {
      // Regression guard against the D-group fix over-tightening.
      // A3 above covers the same value for the earlier empty-string fix;
      // this guard is specifically for the strict-decimal-form tightening.
      h.send.mockResolvedValueOnce({
        Attributes: {
          ...standardQueueAttributes(),
          ApproximateNumberOfMessages: "0",
        },
      });
      const operations = new M3LSQSOperations(fakeClient());

      const result = await operations.getQueueAttributes(QUEUE_URL);

      expect(result.approximateNumberOfMessages).toBe(0);
    });

    test("counter parsing sanity D7: large plain decimal '1234567' still resolves to 1234567 — strict parsing must not reject valid large counts", async () => {
      h.send.mockResolvedValueOnce({
        Attributes: {
          ...standardQueueAttributes(),
          ApproximateNumberOfMessages: "1234567",
        },
      });
      const operations = new M3LSQSOperations(fakeClient());

      const result = await operations.getQueueAttributes(QUEUE_URL);

      expect(result.approximateNumberOfMessages).toBe(1234567);
    });

    // Group E — prototype-chain guard regression tests.
    // parseRedrivePolicy / parseRedriveAllowPolicy must use Object.hasOwn()
    // guards rather than bare bracket access to prevent inherited Object.prototype
    // properties from being silently read as own-field values.
    //
    // Each test uses try/finally to unconditionally delete the prototype
    // property — even when the assertion throws — to prevent leakage into
    // unrelated suites.  The pollution is confined within a single test.

    test("prototype guard E1: inherited Object.prototype.maxReceiveCount is NOT read when the own property is absent — parseRedrivePolicy must throw", async () => {
      // Without Object.hasOwn guard, bare `parsed["maxReceiveCount"]` would
      // return 5 from the prototype chain and silently accept the malformed payload.
      Object.assign(Object.prototype, { maxReceiveCount: 5 });
      try {
        h.send.mockResolvedValueOnce({
          Attributes: {
            ...standardQueueAttributes(),
            // Deliberately omit maxReceiveCount so only the prototype carries it.
            RedrivePolicy:
              '{"deadLetterTargetArn":"arn:aws:sqs:eu-west-1:123456789012:q-dlq"}',
          },
        });
        const operations = new M3LSQSOperations(fakeClient());

        await expect(
          operations.getQueueAttributes(QUEUE_URL),
        ).rejects.toBeInstanceOf(M3LSQSOperationError);
      } finally {
        Reflect.deleteProperty(Object.prototype, "maxReceiveCount");
      }
    });

    test("prototype guard E2: inherited Object.prototype.deadLetterTargetArn is NOT read when the own property is absent — parseRedrivePolicy must throw", async () => {
      Object.assign(Object.prototype, {
        deadLetterTargetArn: "arn:aws:sqs:eu-west-1:123456789012:evil",
      });
      try {
        h.send.mockResolvedValueOnce({
          Attributes: {
            ...standardQueueAttributes(),
            // Deliberately omit deadLetterTargetArn so only the prototype carries it.
            RedrivePolicy: '{"maxReceiveCount":5}',
          },
        });
        const operations = new M3LSQSOperations(fakeClient());

        await expect(
          operations.getQueueAttributes(QUEUE_URL),
        ).rejects.toBeInstanceOf(M3LSQSOperationError);
      } finally {
        Reflect.deleteProperty(Object.prototype, "deadLetterTargetArn");
      }
    });

    test("prototype guard E3: inherited Object.prototype.sourceQueueArns is NOT read when the own property is absent — key must be omitted from resolved redriveAllowPolicy", async () => {
      Object.assign(Object.prototype, {
        sourceQueueArns: ["arn:aws:sqs:eu-west-1:123456789012:evil"],
      });
      try {
        h.send.mockResolvedValueOnce({
          Attributes: {
            ...standardQueueAttributes(),
            // allowAll legitimately has no sourceQueueArns — only the prototype does.
            RedriveAllowPolicy: '{"redrivePermission":"allowAll"}',
          },
        });
        const operations = new M3LSQSOperations(fakeClient());

        const result = await operations.getQueueAttributes(QUEUE_URL);

        const policy = result.redriveAllowPolicy;
        expect(policy).toBeDefined();
        // Object.hasOwn guard: the inherited array must NOT appear as an own
        // property on the resolved redriveAllowPolicy object.
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- policy proven defined by the assertion above; expect() does not narrow TS types
        expect(Object.hasOwn(policy!, "sourceQueueArns")).toBe(false);
      } finally {
        Reflect.deleteProperty(Object.prototype, "sourceQueueArns");
      }
    });

    test("prototype guard E4: inherited Object.prototype.redrivePermission is NOT read when the own property is absent — parseRedriveAllowPolicy must throw", async () => {
      Object.assign(Object.prototype, { redrivePermission: "allowAll" });
      try {
        h.send.mockResolvedValueOnce({
          Attributes: {
            ...standardQueueAttributes(),
            // Empty object — redrivePermission exists only on the prototype.
            RedriveAllowPolicy: "{}",
          },
        });
        const operations = new M3LSQSOperations(fakeClient());

        await expect(
          operations.getQueueAttributes(QUEUE_URL),
        ).rejects.toBeInstanceOf(M3LSQSOperationError);
      } finally {
        Reflect.deleteProperty(Object.prototype, "redrivePermission");
      }
    });

    test("prototype guard E5 (positive control): own maxReceiveCount wins over inherited — Object.hasOwn guard must not break normal reads", async () => {
      // Proves the guard correctly passes own properties through unchanged.
      Object.assign(Object.prototype, { maxReceiveCount: 5 });
      try {
        h.send.mockResolvedValueOnce({
          Attributes: {
            ...standardQueueAttributes(),
            // Policy carries its own maxReceiveCount: 3 — must resolve to 3, not 5.
            RedrivePolicy:
              '{"deadLetterTargetArn":"arn:aws:sqs:eu-west-1:123456789012:q-dlq","maxReceiveCount":3}',
          },
        });
        const operations = new M3LSQSOperations(fakeClient());

        const result = await operations.getQueueAttributes(QUEUE_URL);

        expect(result.redrivePolicy?.maxReceiveCount).toBe(3);
      } finally {
        Reflect.deleteProperty(Object.prototype, "maxReceiveCount");
      }
    });
  });
});
