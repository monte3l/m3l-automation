import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  AGENT_OPERATOR_SCRIPT_NAME_MAX_LENGTH,
  AGENT_OPERATOR_SCRIPT_NAME_RE,
  assertAllowedScriptName,
  isAllowedScriptName,
} from "../../src/lib/cli-names.js";
import { M3LAgentOperatorCliError } from "../../src/lib/errors.js";

/**
 * Contract: PR 1 spec `src/lib/cli-names.ts`. `AGENT_OPERATOR_SCRIPT_NAME_RE`
 * must copy `SCRIPT_NAME_RE` from `packages/m3l-cli/src/scaffold/manifest.ts`
 * verbatim (ADR-0029: a script depends only on `@m3l-automation/m3l-common`,
 * so the regex cannot be imported and must be drift-guarded against the
 * source of truth instead). `AGENT_OPERATOR_SCRIPT_NAME_MAX_LENGTH` (64) is
 * this package's own additional cap, checked BEFORE the regex.
 */

const REJECTED_NAMES = [
  "--json",
  "-h",
  "../../etc/passwd",
  "a;rm -rf /",
  "",
  "-",
  "x".repeat(65),
  "a\0b",
  "Agent-Operator",
  "a--b",
  "1abc",
  "abc-",
];

const ACCEPTED_NAMES = [
  "json-etl",
  "sqs-etl",
  "s3-objects",
  "a",
  "a1",
  "cloudwatch-logs-insights",
];

describe("AGENT_OPERATOR_SCRIPT_NAME_RE / AGENT_OPERATOR_SCRIPT_NAME_MAX_LENGTH", () => {
  it("caps script names at 64 characters", () => {
    expect(AGENT_OPERATOR_SCRIPT_NAME_MAX_LENGTH).toBe(64);
  });

  it("matches the drift-guarded regex source copied from manifest.ts", () => {
    // Resolve relative to this test file's own URL, never process.cwd(), so
    // the guard is stable regardless of the invoking working directory.
    const manifestPath = fileURLToPath(
      new URL(
        "../../../../packages/m3l-cli/src/scaffold/manifest.ts",
        import.meta.url,
      ),
    );
    const manifestText = readFileSync(manifestPath, "utf8");

    const match = /export const SCRIPT_NAME_RE: RegExp = (\/.+\/);/.exec(
      manifestText,
    );
    expect(match).not.toBeNull();
    const literalSource = match?.[1];
    expect(literalSource).toBe("/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/");

    // Round-trip AGENT_OPERATOR_SCRIPT_NAME_RE.source back into `/.../ ` form
    // so the comparison is against the exact same literal text, not a
    // reconstructed approximation.
    expect(`/${AGENT_OPERATOR_SCRIPT_NAME_RE.source}/`).toBe(literalSource);
  });
});

describe("isAllowedScriptName", () => {
  it.each(REJECTED_NAMES.map((name) => [name] as const))(
    "rejects %j",
    (name) => {
      expect(isAllowedScriptName(name)).toBe(false);
    },
  );

  it.each(ACCEPTED_NAMES.map((name) => [name] as const))(
    "accepts %j",
    (name) => {
      expect(isAllowedScriptName(name)).toBe(true);
    },
  );

  it("rejects non-string values", () => {
    expect(isAllowedScriptName(42)).toBe(false);
    expect(isAllowedScriptName(null)).toBe(false);
    expect(isAllowedScriptName(undefined)).toBe(false);
    expect(isAllowedScriptName({})).toBe(false);
    expect(isAllowedScriptName(["json-etl"])).toBe(false);
  });

  it("checks length before the regex (an over-length otherwise-valid name is rejected on length alone)", () => {
    // "a" repeated 65 times is otherwise regex-valid (starts with a letter,
    // only lowercase letters) but exceeds the 64-char cap.
    const overLength = "a".repeat(65);
    expect(overLength.length).toBeGreaterThan(
      AGENT_OPERATOR_SCRIPT_NAME_MAX_LENGTH,
    );
    expect(AGENT_OPERATOR_SCRIPT_NAME_RE.test(overLength)).toBe(true);
    expect(isAllowedScriptName(overLength)).toBe(false);
  });
});

describe("assertAllowedScriptName", () => {
  it.each(ACCEPTED_NAMES.map((name) => [name] as const))(
    "returns the narrowed string for %j",
    (name) => {
      expect(assertAllowedScriptName(name)).toBe(name);
    },
  );

  it.each(REJECTED_NAMES.map((name) => [name] as const))(
    "throws M3LAgentOperatorCliError coded ERR_AGENT_OPERATOR_SCRIPT_NAME for %j",
    (name) => {
      let thrown: unknown;
      try {
        assertAllowedScriptName(name);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
      const cliError = thrown as M3LAgentOperatorCliError;
      expect(cliError.code).toBe("ERR_AGENT_OPERATOR_SCRIPT_NAME");
    },
  );

  it("never echoes the rejected, model-supplied value in the thrown message", () => {
    const maliciousName = "a;rm -rf /--secret-marker--";
    let thrown: unknown;
    try {
      assertAllowedScriptName(maliciousName);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
    const cliError = thrown as M3LAgentOperatorCliError;
    expect(cliError.message).not.toContain(maliciousName);
    expect(cliError.message).not.toContain("secret-marker");
  });

  it("never echoes a null-byte-embedding value either", () => {
    const withNullByte = "a\0secret-marker";
    let thrown: unknown;
    try {
      assertAllowedScriptName(withNullByte);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
    const cliError = thrown as M3LAgentOperatorCliError;
    expect(cliError.message).not.toContain("secret-marker");
  });
});
