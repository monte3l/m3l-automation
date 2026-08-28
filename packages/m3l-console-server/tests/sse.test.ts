/**
 * Tests for src/http/sse.ts — the SSE wire-format encoder (X4, ADR-0066,
 * slice 2). `src/http/sse.ts` does not exist yet; this suite is RED until
 * implementation lands.
 *
 * Framing rules under test: `id: <n>\n`, `event: <name>\n`, one `data: `
 * line per line of payload, then a terminating blank line.
 *
 * The module's one coherent rule, which the tests below are organized
 * around: arbitrary payload data (`data`) is **sanitized** — it is
 * attacker-influenced script output, so `\r\n`/`\r` are normalized to `\n`
 * BEFORE splitting rather than left able to forge a frame boundary. Every
 * internal control value (`event` name, `id`, `retryMs`, comment text) is
 * **validated and throws** — all are supplied by our own code, so a bad
 * value there is a defect, not attacker input, and sanitizing it would only
 * hide the defect.
 */
import { describe, expect, test } from "vitest";

import type { M3LConsoleError } from "../src/errors/console-error.js";
import { isConsoleError } from "../src/errors/console-error.js";
import {
  encodeSseComment,
  encodeSseFrame,
  encodeSseRetry,
} from "../src/http/sse.js";

/** Extracts the thrown value from a call expected to throw, without a cast at the call site. */
function captureThrow(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

/** Asserts that calling `fn` throws an `M3LConsoleError` with code `ERR_CONSOLE_INTERNAL`. */
function expectConsoleInternalThrow(fn: () => unknown): void {
  const thrown = captureThrow(fn);

  expect(isConsoleError(thrown)).toBe(true);
  expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_INTERNAL");
}

describe("encodeSseFrame — single-line payload", () => {
  test("emits id, event, one data line, then a blank line", () => {
    const encoded = encodeSseFrame({
      id: 42,
      event: "run.output",
      data: "hello world",
    });

    expect(encoded).toBe("id: 42\nevent: run.output\ndata: hello world\n\n");
  });
});

describe("encodeSseFrame — multi-line payload", () => {
  test("splits a payload with embedded \\n across multiple data: lines", () => {
    const encoded = encodeSseFrame({
      id: 7,
      event: "run.output",
      data: "line one\nline two\nline three",
    });

    expect(encoded).toBe(
      "id: 7\nevent: run.output\ndata: line one\ndata: line two\ndata: line three\n\n",
    );
  });
});

describe("encodeSseFrame — CRLF / lone CR normalization (security-relevant)", () => {
  test.each([
    ["\\r\\n", "line one\r\nline two"],
    ["a lone \\r", "line one\rline two"],
  ])(
    "normalizes %s to \\n before splitting, same as a plain \\n payload",
    (_label, data) => {
      const encoded = encodeSseFrame({ id: 1, event: "run.output", data });

      expect(encoded).toBe(
        "id: 1\nevent: run.output\ndata: line one\ndata: line two\n\n",
      );
    },
  );

  test("normalizes a mixed \\r\\n / lone \\r / \\n payload with no stray blank line", () => {
    const encoded = encodeSseFrame({
      id: 3,
      event: "run.output",
      data: "a\r\nb\rc\nd",
    });

    expect(encoded).toBe(
      "id: 3\nevent: run.output\ndata: a\ndata: b\ndata: c\ndata: d\n\n",
    );
    // No interior blank line: the only doubled newline is the frame's own
    // trailing terminator.
    expect(encoded.indexOf("\n\n")).toBe(encoded.length - 2);
  });
});

describe("encodeSseFrame — empty payload", () => {
  test("still emits exactly one (empty) data: line, never zero", () => {
    const encoded = encodeSseFrame({ id: 1, event: "run.output", data: "" });

    expect(encoded).toBe("id: 1\nevent: run.output\ndata: \n\n");
  });
});

describe("encodeSseFrame — blank line in the middle of the payload", () => {
  test("preserves the empty line as its own empty data: line", () => {
    const encoded = encodeSseFrame({
      id: 2,
      event: "run.output",
      data: "a\n\nb",
    });

    expect(encoded).toBe(
      "id: 2\nevent: run.output\ndata: a\ndata: \ndata: b\n\n",
    );
  });
});

describe("encodeSseFrame — trailing newline in the payload", () => {
  // DECISION: a trailing "\n" produces a trailing empty `data:` line
  // (naive `"a\n".split("\n")` -> ["a", ""]), rather than being collapsed
  // away. This is the *faithful* reading, not a bug: per the SSE
  // reconstruction rule, a client that receives multiple `data:` fields
  // joins their values with "\n". Joining ["a", ""] with "\n" yields
  // exactly "a\n" — the original payload, byte for byte. Collapsing the
  // trailing empty line instead would silently drop the client's trailing
  // newline.
  test("a trailing \\n round-trips as a trailing empty data: line", () => {
    const encoded = encodeSseFrame({
      id: 9,
      event: "run.output",
      data: "a\n",
    });

    expect(encoded).toBe("id: 9\nevent: run.output\ndata: a\ndata: \n\n");
  });
});

describe("encodeSseFrame — id handling", () => {
  test("omits the id: line entirely when id is not provided", () => {
    const encoded = encodeSseFrame({ event: "run.output", data: "hi" });

    expect(encoded).toBe("event: run.output\ndata: hi\n\n");
    expect(encoded).not.toContain("id:");
  });

  // `id` is an internal control value (it sets the client's Last-Event-ID),
  // never caller-supplied user data, so a bad value is a defect and must
  // throw rather than be sanitized onto the wire. This matters beyond the
  // encoder itself: an emitted `id: 0` would make a reconnecting client
  // send `Last-Event-ID: 0`, which slice 1's `resolveResumeDecision` reads
  // as "replay everything retained" — a silent duplicate-delivery bug the
  // client would see, not us. Ids are 1-based in slice 1, so `0` is
  // unreachable in correct operation; the only way it reaches this encoder
  // is a bug in the (not-yet-written) `stream-writer.ts`. Throwing loudly
  // here beats a subtle duplicate-delivery bug that would be very hard to
  // trace back to this seam.
  test.each([
    ["0", 0],
    ["a negative integer", -1],
    ["a non-integer", 1.5],
    ["NaN", Number.NaN],
    ["positive Infinity", Number.POSITIVE_INFINITY],
    ["negative Infinity", Number.NEGATIVE_INFINITY],
  ])(
    "rejects an id of %s (not a positive integer) with ERR_CONSOLE_INTERNAL",
    (_label, id) => {
      expectConsoleInternalThrow(() =>
        encodeSseFrame({ id, event: "run.output", data: "hi" }),
      );
    },
  );
});

describe("encodeSseFrame — event name validation (asymmetry with data)", () => {
  test.each([
    ["a newline", "run.output\ninjected"],
    ["a carriage return", "run.output\rinjected"],
  ])(
    "throws ERR_CONSOLE_INTERNAL when the event name contains %s",
    (_label, event) => {
      expectConsoleInternalThrow(() => encodeSseFrame({ event, data: "safe" }));
    },
  );

  // The linchpin of the module's sanitize-data / validate-and-throw-controls
  // rule: the exact same characters that are a defect (and throw) in
  // `event` are ordinary, sanitized-not-rejected content in `data` — proving
  // the asymmetry is deliberate, not an accidental omission of a check.
  test("data containing the same characters that throw for event is sanitized, not rejected", () => {
    expect(() =>
      encodeSseFrame({
        event: "run.output",
        data: "line one\r\nline two\rline three",
      }),
    ).not.toThrow();
  });
});

describe("encodeSseComment", () => {
  test("produces a `: <text>` comment frame terminated by a blank line", () => {
    expect(encodeSseComment("keep-alive")).toBe(": keep-alive\n\n");
  });

  // Comment text is an internal control value (a heartbeat literal
  // supplied by our own code, never caller/attacker data), so — per the
  // module's rule — a newline in it is a defect to reject, not sanitize.
  // Sanitizing it instead (as `data` does) would risk a strict SSE parser
  // reading the embedded \n as ending the comment line early and the
  // remainder as a forged, unprefixed line — the same frame-forging hazard
  // normalization exists to prevent for `data`.
  test.each([
    ["a newline", "keep\nalive"],
    ["\\r\\n", "keep\r\nalive"],
    ["a lone \\r", "keep\ralive"],
  ])(
    "rejects comment text containing %s with ERR_CONSOLE_INTERNAL",
    (_label, text) => {
      expectConsoleInternalThrow(() => encodeSseComment(text));
    },
  );
});

describe("encodeSseRetry", () => {
  test.each([
    [0, "retry: 0\n\n"],
    [1, "retry: 1\n\n"],
    [5000, "retry: 5000\n\n"],
  ])("encodes a valid retryMs of %i", (retryMs, expected) => {
    expect(encodeSseRetry(retryMs)).toBe(expected);
  });

  test.each([
    ["NaN", Number.NaN],
    ["a negative integer", -1],
    ["a non-integer", 1.5],
    ["positive Infinity", Number.POSITIVE_INFINITY],
    ["negative Infinity", Number.NEGATIVE_INFINITY],
  ])("rejects %s with ERR_CONSOLE_INTERNAL", (_label, retryMs) => {
    expectConsoleInternalThrow(() => encodeSseRetry(retryMs));
  });
});
