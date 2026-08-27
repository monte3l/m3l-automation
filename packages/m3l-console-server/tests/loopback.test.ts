/**
 * Tests for src/net/loopback.ts — `isLoopbackHost` and `unwrapBracketedHost`
 * (m3l-console-server X2a contract, ADR-0071).
 */
import { describe, expect, test } from "vitest";

import { isLoopbackHost, unwrapBracketedHost } from "../src/net/loopback.js";

describe("isLoopbackHost", () => {
  test.each<[string, boolean]>([
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
  ])("returns %2$s for %1$s", (host, expected) => {
    expect(isLoopbackHost(host)).toBe(expected);
  });
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
