/**
 * Tests for src/net/loopback.ts — `isLoopbackHost`, `unwrapBracketedHost`,
 * and the three purpose-specific delegating predicates `isPermittedBindHost`,
 * `isVerifiedBoundAddress`, and `isAcceptedRequestHostname`
 * (m3l-console-server X2a contract, ADR-0071).
 */
import { describe, expect, test } from "vitest";

import {
  isAcceptedRequestHostname,
  isLoopbackHost,
  isPermittedBindHost,
  isVerifiedBoundAddress,
  unwrapBracketedHost,
} from "../src/net/loopback.js";

const LOOPBACK_CLASSIFICATION_CASES: [string, boolean][] = [
  ["localhost", true],
  ["LOCALHOST", true],
  ["127.0.0.1", true],
  ["127.1.2.3", true],
  ["127.255.255.255", true],
  ["::1", true],
  ["[::1]", true],
  ["0:0:0:0:0:0:0:1", true],
  ["0.0.0.0", false],
  ["::", false],
  ["127.0.0.1.evil.com", false],
  ["192.168.1.1", false],
  ["", false],
  ["127.0.0.256", false],
];

describe("isLoopbackHost", () => {
  test.each<[string, boolean]>(LOOPBACK_CLASSIFICATION_CASES)(
    "returns %2$s for %1$s",
    (host, expected) => {
      expect(isLoopbackHost(host)).toBe(expected);
    },
  );
});

describe("isPermittedBindHost", () => {
  test.each<[string, boolean]>(LOOPBACK_CLASSIFICATION_CASES)(
    "returns %2$s for %1$s",
    (host, expected) => {
      expect(isPermittedBindHost(host)).toBe(expected);
    },
  );
});

describe("isVerifiedBoundAddress", () => {
  test.each<[string, boolean]>(LOOPBACK_CLASSIFICATION_CASES)(
    "returns %2$s for %1$s",
    (host, expected) => {
      expect(isVerifiedBoundAddress(host)).toBe(expected);
    },
  );
});

describe("isAcceptedRequestHostname", () => {
  test.each<[string, boolean]>(LOOPBACK_CLASSIFICATION_CASES)(
    "returns %2$s for %1$s",
    (host, expected) => {
      expect(isAcceptedRequestHostname(host)).toBe(expected);
    },
  );
});

describe("unwrapBracketedHost", () => {
  test("unwraps a bracketed IPv6 host to its bare address", () => {
    expect(unwrapBracketedHost("[::1]")).toBe("::1");
  });

  test("passes an unbracketed host through unchanged", () => {
    expect(unwrapBracketedHost("::1")).toBe("::1");
  });

  test.each<[string]>([["[::1"], ["::1]"]])(
    "passes a half-bracketed host %s through unchanged rather than mangling it",
    (host) => {
      expect(unwrapBracketedHost(host)).toBe(host);
    },
  );
});
