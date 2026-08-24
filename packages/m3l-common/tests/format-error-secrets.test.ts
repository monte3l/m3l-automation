/**
 * `core/diagnostics/format-error` — `M3LFormatErrorChainOptions.secrets`
 * (F20 / tracker row F20, GitHub issue #517).
 *
 * `formatErrorChain` and `serializeErrorChain` gained an optional
 * `secrets?: M3LSecretNamesPort` option additively widening
 * `redactSensitiveLogText`/`redactSensitiveLogValue`'s built-in key-name
 * heuristic with a caller-declared secrets specifier.
 *
 * `formatErrorChain` renders only `name`/`message`/`stack` text (no
 * `context`), so its `secrets` differential is exercised through a bare
 * `key=value` pair embedded in the message text — the first-two-pass
 * surface `redactSensitiveLogText` widens with a declared secrets port.
 * `serializeErrorChain` additionally serializes an `M3LError`'s `context`
 * object, so its differential uses a declared-secret context key directly.
 *
 * Every "with secrets" assertion is paired with a "without secrets" arm
 * proving the pre-fix baseline genuinely leaked the value — a
 * redacted-only assertion would be a proxy per this repo's `tests.md`.
 *
 * Kept as a dedicated file (rather than added to `tests/diagnostics.test.ts`)
 * purely to avoid `check:test-counts` doc-count churn on that already-large
 * file.
 */

import { describe, expect, test } from "vitest";

import {
  formatErrorChain,
  serializeErrorChain,
} from "../src/core/diagnostics/format-error.js";
import { M3LError } from "../src/core/errors/index.js";
import type { M3LSecretNamesPort } from "../src/core/logging/redact.js";

const secrets: M3LSecretNamesPort = {
  isSecret: (name) => name === "tenantRef",
};

describe("formatErrorChain — options.secrets (message text, differential)", () => {
  const messageWithSecret = "failed while processing tenantRef=secret-value";

  test("happy path: with secrets declared, the embedded key=value pair is redacted", () => {
    const output = formatErrorChain(new Error(messageWithSecret), {
      secrets,
    });
    expect(output).not.toContain("secret-value");
    expect(output).toContain("tenantRef=[REDACTED]");
  });

  test("without secrets, the embedded key=value pair survives unredacted (proves the pre-fix baseline leaks)", () => {
    const output = formatErrorChain(new Error(messageWithSecret));
    expect(output).toContain("secret-value");
  });

  test("additive-only guard: a heuristic-matched key (apiKey) redacts identically whether or not secrets is supplied", () => {
    const messageWithHeuristicKey = "failed while processing apiKey=drop-me";

    const withoutSecrets = formatErrorChain(new Error(messageWithHeuristicKey));
    const withSecrets = formatErrorChain(new Error(messageWithHeuristicKey), {
      secrets,
    });

    expect(withoutSecrets).not.toContain("drop-me");
    expect(withSecrets).not.toContain("drop-me");
  });
});

describe("serializeErrorChain — options.secrets (context, differential)", () => {
  function buildErrorWithSecretContext(): M3LError {
    return new M3LError("bad config", {
      code: "ERR_CONFIG_MISSING",
      context: { tenantRef: "secret-value" },
    });
  }

  test("happy path: with secrets declared, the context's declared-secret key is redacted", () => {
    const [level] = serializeErrorChain(buildErrorWithSecretContext(), {
      secrets,
    });
    expect(level?.context?.["tenantRef"]).toBe("[REDACTED]");
    expect(JSON.stringify(level)).not.toContain("secret-value");
  });

  test("without secrets, the context's declared-secret key survives unredacted (proves the pre-fix baseline leaks)", () => {
    const [level] = serializeErrorChain(buildErrorWithSecretContext());
    expect(level?.context?.["tenantRef"]).toBe("secret-value");
  });

  test("additive-only guard: a heuristic-matched context key (apiKey) redacts identically whether or not secrets is supplied", () => {
    function buildErrorWithHeuristicContext(): M3LError {
      return new M3LError("bad config", {
        code: "ERR_CONFIG_MISSING",
        context: { apiKey: "drop-me" },
      });
    }

    const [withoutSecrets] = serializeErrorChain(
      buildErrorWithHeuristicContext(),
    );
    const [withSecrets] = serializeErrorChain(
      buildErrorWithHeuristicContext(),
      { secrets },
    );

    expect(withoutSecrets?.context?.["apiKey"]).toBe("[REDACTED]");
    expect(withSecrets?.context?.["apiKey"]).toBe("[REDACTED]");
  });
});
