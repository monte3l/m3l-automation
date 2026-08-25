/**
 * `core/diagnostics/breadcrumbs` — `M3LBreadcrumbTrailOptions.secrets`
 * (F20 / tracker row F20, GitHub issue #517).
 *
 * `M3LBreadcrumbTrail` gained an optional `secrets?: M3LSecretNamesPort`
 * constructor option additively widening `redactSensitiveLogValue`'s
 * built-in key-name heuristic. This file is a differential regression lock:
 * every "with secrets" assertion is paired with a "without secrets" arm
 * proving the pre-fix baseline genuinely leaked the declared-secret value —
 * a test that only exercised the redacted arm would be a proxy assertion
 * per this repo's `tests.md`.
 *
 * Scope: `M3LBreadcrumbTrail` only. Not the whole `core/diagnostics` barrel —
 * see `tests/diagnostics-run-report.test.ts` for the rest of the module.
 */

import { describe, expect, test, vi } from "vitest";

import {
  deriveSecretsSpecifier,
  M3LConfigParameter,
  M3LConfigParameterType,
  M3LConfigSchema,
} from "../src/core/config/index.js";
import { M3LBreadcrumbTrail } from "../src/core/diagnostics/breadcrumbs.js";
import { M3LEventEmitter } from "../src/core/events/index.js";

/** A schema declaring one secret parameter under a heuristic-unmatched name. */
const schemaWithSecret = new M3LConfigSchema([
  new M3LConfigParameter({
    name: "tenantRef",
    type: M3LConfigParameterType.STRING,
    secret: true,
  }),
]);

const secretPayload = {
  tenantRef: "secret-value",
  phase: "settings",
} as const;

describe("M3LBreadcrumbTrailOptions.secrets — via attach()/emit (differential)", () => {
  test("without secrets, a declared-but-unheuristic key survives unredacted (proves the pre-fix baseline leaks)", () => {
    const trail = new M3LBreadcrumbTrail();
    const emitter = new M3LEventEmitter<{ "pipeline:phase": unknown }>();
    trail.attach(emitter, { source: "M3LOperationPipeline" });

    emitter.emit("pipeline:phase", secretPayload);

    const [entry] = trail.entries();
    expect(entry?.payload["tenantRef"]).toBe("secret-value");
    expect(JSON.stringify(entry?.payload)).toContain("secret-value");
  });

  test("with secrets declared, the same key is redacted", () => {
    const trail = new M3LBreadcrumbTrail({
      secrets: deriveSecretsSpecifier(schemaWithSecret),
    });
    const emitter = new M3LEventEmitter<{ "pipeline:phase": unknown }>();
    trail.attach(emitter, { source: "M3LOperationPipeline" });

    emitter.emit("pipeline:phase", secretPayload);

    const [entry] = trail.entries();
    expect(entry?.payload["tenantRef"]).toBe("[REDACTED]");
    expect(JSON.stringify(entry?.payload)).not.toContain("secret-value");
  });
});

describe("M3LBreadcrumbTrailOptions.secrets — via direct record() (differential)", () => {
  test("without secrets, a direct record() call leaks the declared key", () => {
    const trail = new M3LBreadcrumbTrail();
    trail.record("M3LOperationPipeline", "pipeline:phase", secretPayload);

    const [entry] = trail.entries();
    expect(entry?.payload["tenantRef"]).toBe("secret-value");
  });

  test("with secrets declared, a direct record() call redacts the declared key", () => {
    const trail = new M3LBreadcrumbTrail({
      secrets: deriveSecretsSpecifier(schemaWithSecret),
    });
    trail.record("M3LOperationPipeline", "pipeline:phase", secretPayload);

    const [entry] = trail.entries();
    expect(entry?.payload["tenantRef"]).toBe("[REDACTED]");
    expect(JSON.stringify(entry?.payload)).not.toContain("secret-value");
  });
});

describe("M3LBreadcrumbTrailOptions.secrets — undeclared key stays heuristic-only", () => {
  test("a key not declared to secrets and not heuristic-matched is never redacted", () => {
    const trail = new M3LBreadcrumbTrail({
      secrets: deriveSecretsSpecifier(schemaWithSecret),
    });
    trail.record("M3LOperationPipeline", "pipeline:phase", {
      tenantRef: "secret-value",
      customField: "not-a-secret-by-any-means",
    });

    const [entry] = trail.entries();
    expect(entry?.payload["tenantRef"]).toBe("[REDACTED]");
    expect(entry?.payload["customField"]).toBe("not-a-secret-by-any-means");
  });
});

describe("M3LBreadcrumbTrailOptions.secrets — additive-only guard", () => {
  test("a heuristic-matched key (apiKey) redacts identically whether or not secrets is supplied", () => {
    const withoutSecrets = new M3LBreadcrumbTrail();
    const withSecrets = new M3LBreadcrumbTrail({
      secrets: deriveSecretsSpecifier(schemaWithSecret),
    });

    withoutSecrets.record("M3LOperationPipeline", "pipeline:phase", {
      apiKey: "drop-me",
      phase: "settings",
    });
    withSecrets.record("M3LOperationPipeline", "pipeline:phase", {
      apiKey: "drop-me",
      phase: "settings",
    });

    expect(withoutSecrets.entries()[0]?.payload["apiKey"]).toBe("[REDACTED]");
    expect(withSecrets.entries()[0]?.payload["apiKey"]).toBe("[REDACTED]");
  });
});

describe("M3LBreadcrumbTrailOptions.secrets — hostile isSecret degrades safely", () => {
  test("record() redacts the declared key, keeps unrelated fields intact, and reports the failure to stderr instead of collapsing the payload to {}", () => {
    const hostileSecrets = {
      isSecret: (name: string): boolean => {
        if (name === "tenantRef") throw new Error("hostile");
        return false;
      },
    };
    const trail = new M3LBreadcrumbTrail({ secrets: hostileSecrets });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    trail.record("M3LOperationPipeline", "pipeline:phase", {
      tenantRef: "secret-value",
      phase: "settings",
    });

    const [entry] = trail.entries();
    // The declared secret is redacted, not silently dropped by a `{}`
    // collapse of the whole payload.
    expect(entry?.payload["tenantRef"]).toBe("[REDACTED]");
    // An unrelated field in the same payload survives intact.
    expect(entry?.payload["phase"]).toBe("settings");

    // The redaction failure is surfaced, not silently swallowed.
    expect(stderrSpy).toHaveBeenCalled();
    const written = stderrSpy.mock.calls
      .map(([chunk]) => String(chunk))
      .join("\n");
    expect(written).toContain("redaction failed");

    stderrSpy.mockRestore();
  });
});
