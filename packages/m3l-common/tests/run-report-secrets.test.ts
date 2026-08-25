/**
 * `core/diagnostics/run-report` — `M3LRunReporterOptions.secrets`
 * (F20 / tracker row F20, GitHub issue #517).
 *
 * `M3LRunReporter` gained an optional `secrets?: M3LSecretNamesPort`
 * constructor option additively widening `sanitizeValue`/`sanitizeString`'s
 * redaction (built from `redactSensitiveLogValue`) with a caller-declared
 * secrets specifier, threaded through `build()`'s `timeline`, `archive`,
 * failure `context`, and `recovery` sections, and into the best-effort
 * stderr diagnostic `persist()` emits on write failure.
 *
 * Every "with secrets" assertion below is paired with a "without secrets"
 * arm proving the pre-fix baseline genuinely leaked the declared-secret
 * value — a redacted-only assertion would be a proxy per this repo's
 * `tests.md`.
 *
 * Scope: `M3LRunReporter` only. Not the whole `core/diagnostics` barrel —
 * see `tests/diagnostics-run-report.test.ts` for the rest of the module.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Mocked ONLY so a single test can vi.spyOn `writeFile` — the factory
// spreads the real module so every other import keeps real, unmocked
// behavior (mirrors the pattern in diagnostics-run-report.test.ts).
import * as nodeFsPromises from "node:fs/promises";

vi.mock("node:fs/promises", async () => {
  const actual =
    await vi.importActual<typeof nodeFsPromises>("node:fs/promises");
  return { ...actual };
});

import {
  deriveSecretsSpecifier,
  M3LConfigParameter,
  M3LConfigParameterType,
  M3LConfigSchema,
} from "../src/core/config/index.js";
import type { M3LBreadcrumb } from "../src/core/diagnostics/breadcrumbs.js";
import {
  M3LRunReporter,
  type M3LRunReportInput,
} from "../src/core/diagnostics/run-report.js";
import { M3LError } from "../src/core/errors/index.js";

const schemaWithSecret = new M3LConfigSchema([
  new M3LConfigParameter({
    name: "tenantRef",
    type: M3LConfigParameterType.STRING,
    secret: true,
  }),
]);

const secrets = deriveSecretsSpecifier(schemaWithSecret);

const baseInput = {
  script: { name: "test-script", version: "1.0.0" },
  correlationId: "corr-1",
  startedAt: new Date("2026-07-23T10:20:30.123Z"),
};

describe("M3LRunReporterOptions.secrets — build() via timeline (differential)", () => {
  const breadcrumb: M3LBreadcrumb = {
    timestamp: "2026-07-23T10:20:31.000Z",
    source: "test",
    event: "custom:event",
    payload: { tenantRef: "some-secret-value" },
  };

  test("without secrets, the timeline entry leaks the declared value (proves the pre-fix baseline leaks)", () => {
    const reporter = new M3LRunReporter();
    const report = reporter.build({
      ...baseInput,
      outcome: "success",
      timeline: [breadcrumb],
    });
    expect(report.timeline[0]?.payload["tenantRef"]).toBe("some-secret-value");
  });

  test("with secrets declared, the timeline entry is redacted", () => {
    const reporter = new M3LRunReporter({ secrets });
    const report = reporter.build({
      ...baseInput,
      outcome: "success",
      timeline: [breadcrumb],
    });
    expect(report.timeline[0]?.payload["tenantRef"]).toBe("[REDACTED]");
    expect(JSON.stringify(report.timeline)).not.toContain("some-secret-value");
  });
});

describe("M3LRunReporterOptions.secrets — build() via archive (differential)", () => {
  // `archive` is projected to the documented M3LFileCopyReport allowlist
  // before redaction runs (see run-report.ts's projectArchiveReport), so
  // there is no free-form KEY name a caller can inject into it. But every
  // string leaf (e.g. `destination`) still passes through
  // `redactSensitiveLogText`, whose bare `key=value` pass IS widened by
  // `secrets` — this is the surface this differential exercises.
  const archive = {
    results: [
      {
        skipped: false,
        source: "/src/a.csv",
        destination: "tenantRef=some-secret-value",
        size: 10,
        timestamp: "2026-07-23T10:00:00.000Z",
      },
    ],
  };

  test("without secrets, the embedded bare key=value pair in a projected string field survives unredacted", () => {
    const reporter = new M3LRunReporter();
    const report = reporter.build({
      ...baseInput,
      outcome: "success",
      archive,
    });
    expect(JSON.stringify(report.archive)).toContain(
      "tenantRef=some-secret-value",
    );
  });

  test("with secrets declared, the embedded bare key=value pair is redacted", () => {
    const reporter = new M3LRunReporter({ secrets });
    const report = reporter.build({
      ...baseInput,
      outcome: "success",
      archive,
    });
    expect(JSON.stringify(report.archive)).not.toContain("some-secret-value");
    expect(JSON.stringify(report.archive)).toContain("tenantRef=[REDACTED]");
  });
});

describe("M3LRunReporterOptions.secrets — build() via failure context (differential)", () => {
  function failureInput(): M3LRunReportInput {
    return {
      ...baseInput,
      outcome: "failure",
      error: new M3LError("boom", {
        code: "ERR_CONFIG_MISSING",
        context: { tenantRef: "secret-value" },
      }),
    };
  }

  test("without secrets, the failure chain's context leaks the declared value", () => {
    const reporter = new M3LRunReporter();
    const report = reporter.build(failureInput());
    expect(report.failure?.chain[0]?.context?.["tenantRef"]).toBe(
      "secret-value",
    );
  });

  test("with secrets declared, the failure chain's context is redacted", () => {
    const reporter = new M3LRunReporter({ secrets });
    const report = reporter.build(failureInput());
    expect(report.failure?.chain[0]?.context?.["tenantRef"]).toBe("[REDACTED]");
    expect(JSON.stringify(report.failure)).not.toContain("secret-value");
  });
});

describe("M3LRunReporterOptions.secrets — build() via partial recovery.item (differential)", () => {
  function partialInput(): M3LRunReportInput {
    return {
      ...baseInput,
      outcome: "partial",
      recovery: [
        {
          item: "tenantRef=secret-value",
          error: [{ name: "Error", message: "bad item" }],
          recordedAt: "2026-07-23T10:20:31.000Z",
        },
      ],
    };
  }

  test("without secrets, the recovery item embeds the declared value unredacted", () => {
    const reporter = new M3LRunReporter();
    const report = reporter.build(partialInput());
    expect(report.outcome).toBe("partial");
    if (report.outcome === "partial") {
      expect(report.recovery[0]?.item).toBe("tenantRef=secret-value");
    }
  });

  test("with secrets declared, the recovery item's key=value pair is redacted", () => {
    const reporter = new M3LRunReporter({ secrets });
    const report = reporter.build(partialInput());
    expect(report.outcome).toBe("partial");
    if (report.outcome === "partial") {
      expect(report.recovery[0]?.item).toBe("tenantRef=[REDACTED]");
    }
  });
});

describe("M3LRunReporterOptions.secrets — hostile isSecret in build()'s failure chain", () => {
  const hostileSecrets = {
    isSecret: (name: string): boolean => {
      if (name === "tenantRef") throw new Error("hostile");
      return false;
    },
  };

  function hostileFailureInput(): M3LRunReportInput {
    return {
      ...baseInput,
      outcome: "failure",
      error: new M3LError("boom", {
        code: "ERR_CONFIG_MISSING",
        context: { tenantRef: "secret-value", otherField: "keep-me" },
      }),
    };
  }

  test("the chain is a real serialized error, not the generic collapsed placeholder", () => {
    const reporter = new M3LRunReporter({ secrets: hostileSecrets });
    const report = reporter.build(hostileFailureInput());

    // A hostile isSecret must not make serializeErrorChain's own catch-all
    // collapse the whole chain to [{ name: "Error", message:
    // "[unrepresentable error chain]" }] — assert the real M3LError identity
    // survived.
    expect(report.failure?.chain[0]?.name).toBe("M3LError");
    expect(report.failure?.chain[0]?.message).toBe("boom");
  });

  test("the offending context field is redacted rather than leaked or dropped by a collapse", () => {
    const reporter = new M3LRunReporter({ secrets: hostileSecrets });
    const report = reporter.build(hostileFailureInput());

    expect(report.failure?.chain[0]?.context?.["tenantRef"]).toBe("[REDACTED]");
  });

  test("an unrelated context field on the same error survives intact", () => {
    const reporter = new M3LRunReporter({ secrets: hostileSecrets });
    const report = reporter.build(hostileFailureInput());

    expect(report.failure?.chain[0]?.context?.["otherField"]).toBe("keep-me");
  });

  test("a redaction-failure diagnostic reaches stderr", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const reporter = new M3LRunReporter({ secrets: hostileSecrets });

    reporter.build(hostileFailureInput());

    expect(stderrSpy).toHaveBeenCalled();
    const written = stderrSpy.mock.calls
      .map(([chunk]) => String(chunk))
      .join("\n");
    expect(written).toContain("redaction failed");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
});

describe("M3LRunReporterOptions.secrets — hostile isSecret in persist()'s write-failure diagnostic", () => {
  let outDir: string;
  const hostileSecrets = {
    isSecret: (name: string): boolean => {
      if (name === "tenantRef") throw new Error("hostile");
      return false;
    },
  };

  beforeEach(async () => {
    outDir = await mkdtemp(join(tmpdir(), "m3l-run-report-secrets-hostile-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(outDir, { recursive: true, force: true });
  });

  function baseReportInput(): M3LRunReportInput {
    return {
      ...baseInput,
      outcome: "success",
    };
  }

  test("the run-report-persist-failed diagnostic still reaches stderr instead of vanishing silently", async () => {
    vi.spyOn(nodeFsPromises, "writeFile").mockRejectedValue(
      new Error("disk full"),
    );
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const reporter = new M3LRunReporter({
      paths: { getOutputDir: () => outDir },
      secrets: hostileSecrets,
    });

    await reporter.persist(baseReportInput());

    // The diagnostic must not vanish silently — it must actually reach
    // stderr, identifying the persist failure.
    expect(stderrSpy).toHaveBeenCalled();
    const written = stderrSpy.mock.calls
      .map(([chunk]) => String(chunk))
      .join("\n");
    expect(written).toContain("run-report-persist-failed");
  });
});

describe("M3LRunReporterOptions.secrets — additive-only guard", () => {
  test("a heuristic-matched key (apiKey) redacts identically whether or not secrets is supplied", () => {
    const breadcrumb: M3LBreadcrumb = {
      timestamp: "2026-07-23T10:20:31.000Z",
      source: "test",
      event: "custom:event",
      payload: { apiKey: "sk-secret" },
    };

    const withoutSecrets = new M3LRunReporter().build({
      ...baseInput,
      outcome: "success",
      timeline: [breadcrumb],
    });
    const withSecrets = new M3LRunReporter({ secrets }).build({
      ...baseInput,
      outcome: "success",
      timeline: [breadcrumb],
    });

    expect(withoutSecrets.timeline[0]?.payload["apiKey"]).toBe("[REDACTED]");
    expect(withSecrets.timeline[0]?.payload["apiKey"]).toBe("[REDACTED]");
  });
});

describe("M3LRunReporterOptions.secrets — persist() write-failure diagnostic (differential)", () => {
  let outDir: string;

  beforeEach(async () => {
    outDir = await mkdtemp(join(tmpdir(), "m3l-run-report-secrets-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(outDir, { recursive: true, force: true });
  });

  function baseReportInput(): M3LRunReportInput {
    return {
      ...baseInput,
      outcome: "success",
    };
  }

  test("without secrets, the stderr diagnostic leaks the declared value embedded in the write error message", async () => {
    vi.spyOn(nodeFsPromises, "writeFile").mockRejectedValue(
      new Error("write failed with tenantRef=secret-value"),
    );
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const reporter = new M3LRunReporter({
      paths: { getOutputDir: () => outDir },
    });

    await reporter.persist(baseReportInput());

    const written = stderrSpy.mock.calls
      .map(([chunk]) => String(chunk))
      .join("\n");
    expect(written).toContain("tenantRef=secret-value");
  });

  test("with secrets declared, the stderr diagnostic redacts the embedded key=value pair", async () => {
    vi.spyOn(nodeFsPromises, "writeFile").mockRejectedValue(
      new Error("write failed with tenantRef=secret-value"),
    );
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const reporter = new M3LRunReporter({
      paths: { getOutputDir: () => outDir },
      secrets,
    });

    await reporter.persist(baseReportInput());

    const written = stderrSpy.mock.calls
      .map(([chunk]) => String(chunk))
      .join("\n");
    expect(written).not.toContain("secret-value");
    expect(written).toContain("tenantRef=[REDACTED]");
  });
});
