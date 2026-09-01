/**
 * Tests for `steps/health-observations` and `steps/health-report` — the
 * collector every gated tool writes into, and the artifact derived from it.
 *
 * The one claim these files exist to make good on: **the report is built from
 * observations, never from the model's message.** Every assertion below reads
 * only what a tool recorded; the model's words are tested exactly where they
 * are allowed to land, and nowhere else.
 *
 * Projections are minted through the REAL `lib/model-safety` projectors, never
 * hand-written object literals — every `AgentOperatorProjected*` type is
 * nominally branded, so a literal would need a disallowed cast and would also
 * skip the sanitization the brand is meant to certify.
 */

import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AWS } from "@m3l-automation/m3l-common";
import { Core } from "@m3l-automation/m3l-common";

import {
  parseRunEnvelope,
  type AgentOperatorDoctorCheck,
  type AgentOperatorListRow,
  type AgentOperatorRunEnvelope,
} from "../../src/lib/cli-envelopes.js";
import {
  projectDoctorReport,
  projectListRow,
  projectRunEnvelope,
} from "../../src/lib/model-safety.js";
import { AgentHealthObservations } from "../../src/steps/health-observations.js";
import {
  buildHealthReport,
  deriveHealthAnomalies,
  writeHealthReport,
} from "../../src/steps/health-report.js";
import { makeRunEnvelope } from "../support/cliFakes.js";

/**
 * Narrows `makeRunEnvelope`'s fixture (which types `exitCodeName`/`outcome`
 * as plain strings) to the parsed envelope type the projector accepts, via
 * the module's own parser rather than a cast — so a fixture that drifts from
 * the real envelope shape fails here instead of type-checking vacuously.
 */
function parsedEnvelope(
  overrides: Parameters<typeof makeRunEnvelope>[0] = {},
): AgentOperatorRunEnvelope {
  const parsed = parseRunEnvelope(makeRunEnvelope(overrides));
  if (!parsed.ok) {
    throw new Error(`fixture is not a valid envelope: ${parsed.reason}`);
  }
  return parsed.value;
}

/** A fixed instant, so `completedAt` is assertable rather than approximate. */
const NOW = Date.UTC(2026, 8, 1, 12, 0, 0);

let outputDir: string;

beforeEach(async () => {
  outputDir = await mkdtemp(path.join(tmpdir(), "health-report-"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(outputDir, { recursive: true, force: true });
});

/** A collector with a doctor report of the given checks already recorded. */
function withDoctor(
  checks: readonly AgentOperatorDoctorCheck[],
): AgentHealthObservations {
  const observations = new AgentHealthObservations();
  observations.recordDoctor(projectDoctorReport(checks));
  return observations;
}

/** A collector with a fleet roster of the given rows already recorded. */
function withFleet(
  rows: readonly AgentOperatorListRow[],
): AgentHealthObservations {
  const observations = new AgentHealthObservations();
  observations.recordFleet(rows.map((row) => projectListRow(row)));
  return observations;
}

/** The standard report options, with `snapshot` swapped per test. */
function reportOptions(
  observations: AgentHealthObservations,
  message?: AWS.M3LBedrockMessage,
): Parameters<typeof buildHealthReport>[0] {
  return {
    snapshot: observations.snapshot(),
    message,
    iterations: 2,
    tokens: 120,
    cost: 0.5,
    stopReason: "end_turn",
    now: NOW,
    workspaceRoot: undefined,
  };
}

describe("AgentHealthObservations", () => {
  it("starts empty, distinguishing 'never called' from 'called and found nothing'", () => {
    const snapshot = new AgentHealthObservations().snapshot();

    // `undefined` is the load-bearing value: a doctor report of zero checks
    // is a different fact from doctor never having run, and the report reads
    // the two differently (`null` vs a count).
    expect(snapshot.doctor).toBeUndefined();
    expect(snapshot.fleet).toBeUndefined();
    expect(snapshot.inspections).toEqual([]);
    expect(snapshot.dryRuns).toEqual([]);
  });

  it("copies its arrays, so an artifact stays what it recorded", () => {
    // The report writer must never hold a live view a later tool call could
    // still mutate.
    const observations = new AgentHealthObservations();
    observations.recordInspection("s3-objects", []);
    const first = observations.snapshot();

    observations.recordInspection("json-etl", []);

    expect(first.inspections).toHaveLength(1);
    expect(observations.snapshot().inspections).toHaveLength(2);
  });

  it("keeps the LAST doctor report when the model calls the tool twice", () => {
    // The later call is the more current fleet state, so it wins — and the
    // artifact must not silently report the stale one.
    const observations = withDoctor([
      { name: "a", status: "fail", detail: "old" },
    ]);
    observations.recordDoctor(
      projectDoctorReport([{ name: "a", status: "ok", detail: "fixed" }]),
    );

    expect(deriveHealthAnomalies(observations.snapshot())).toEqual([]);
  });
});

describe("deriveHealthAnomalies", () => {
  it("reports a failing doctor check", () => {
    const anomalies = deriveHealthAnomalies(
      withDoctor([
        { name: "node-version", status: "fail", detail: "too old" },
      ]).snapshot(),
    );

    expect(anomalies).toEqual([
      {
        kind: "doctor-check-failed",
        subject: "node-version",
        detail: "too old",
      },
    ]);
  });

  it("reports a WARNING check too, discriminated by kind", () => {
    // Deliberate: this workload exists for unattended monitoring, and a
    // scheduler that only ever hears about hard failures learns nothing from
    // a fleet degrading gradually. `kind` lets a consumer ignore warns
    // explicitly, in its own code — rather than because this function
    // silently dropped them.
    const anomalies = deriveHealthAnomalies(
      withDoctor([
        { name: "disk", status: "warn", detail: "85% used" },
      ]).snapshot(),
    );

    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]?.kind).toBe("doctor-check-warned");
  });

  it("ignores a passing check", () => {
    expect(
      deriveHealthAnomalies(
        withDoctor([
          { name: "ok-check", status: "ok", detail: "fine" },
        ]).snapshot(),
      ),
    ).toEqual([]);
  });

  it("reports a script whose config failed to load, WITHOUT the error text", () => {
    // `projectListRow` drops `loadError` and keeps only the boolean — the
    // model gets the fact, not the text. The artifact reports the same fact:
    // "enriching" this with the error string would undo an asymmetry
    // `lib/model-safety` documents deliberately.
    const anomalies = deriveHealthAnomalies(
      withFleet([
        {
          name: "broken-script",
          description: "",
          parameterCount: null,
          loadError: "zzSECRETzz in the config module",
        },
      ]).snapshot(),
    );

    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]?.subject).toBe("broken-script");
    expect(JSON.stringify(anomalies)).not.toContain("zzSECRETzz");
  });

  it("reports a dry-run probe that exited non-zero, and ignores a clean one", () => {
    const observations = new AgentHealthObservations();
    observations.recordDryRun(
      "json-etl",
      projectRunEnvelope(parsedEnvelope({ script: "json-etl", exitCode: 3 })),
    );
    observations.recordDryRun(
      "s3-objects",
      projectRunEnvelope(parsedEnvelope({ script: "s3-objects", exitCode: 0 })),
    );

    const anomalies = deriveHealthAnomalies(observations.snapshot());

    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toEqual({
      kind: "dry-run-probe-failed",
      subject: "json-etl",
      detail: "the --dry-run probe exited 3",
    });
  });

  it("orders anomalies doctor, then fleet, then probes — stably across runs", () => {
    // Stable order means two runs over the same fleet produce byte-identical
    // artifacts, which is what makes a diff between them meaningful.
    const observations = withDoctor([
      { name: "chk", status: "fail", detail: "bad" },
    ]);
    observations.recordFleet([
      projectListRow({
        name: "broken",
        description: "",
        parameterCount: null,
        loadError: "nope",
      }),
    ]);
    observations.recordDryRun(
      "json-etl",
      projectRunEnvelope(parsedEnvelope({ exitCode: 1 })),
    );

    expect(
      deriveHealthAnomalies(observations.snapshot()).map(
        (anomaly) => anomaly.kind,
      ),
    ).toEqual([
      "doctor-check-failed",
      "script-config-load-failed",
      "dry-run-probe-failed",
    ]);
  });
});

describe("buildHealthReport", () => {
  it("stamps kind, schemaVersion, and the caller's own instant", () => {
    const report = buildHealthReport(
      reportOptions(new AgentHealthObservations()),
    );

    expect(report.kind).toBe("m3l.agent-operator.health-check");
    expect(report.schemaVersion).toBe(1);
    // The caller's single `now` sample, never a clock read here.
    expect(report.completedAt).toBe(new Date(NOW).toISOString());
  });

  it("sets blocking from the anomalies it derived, not from anything the model said", () => {
    const healthy = buildHealthReport(
      reportOptions(withDoctor([{ name: "a", status: "ok", detail: "fine" }]), {
        role: "assistant",
        content: [{ type: "text", text: "CATASTROPHE" }],
      }),
    );
    const broken = buildHealthReport(
      reportOptions(
        withDoctor([{ name: "a", status: "fail", detail: "bad" }]),
        {
          role: "assistant",
          content: [{ type: "text", text: "everything is perfect" }],
        },
      ),
    );

    // The model's words move neither dial.
    expect(healthy.blocking).toBe(false);
    expect(broken.blocking).toBe(true);
  });

  it("reports null counts for a tool that was never called", () => {
    const report = buildHealthReport(
      reportOptions(new AgentHealthObservations()),
    );

    expect(report.observed.fleetSize).toBeNull();
    expect(report.observed.doctorChecks).toBeNull();
    expect(report.observed.inspected).toBe(0);
  });

  it("reports cost as null — not an omitted key — when the run was unpriceable", () => {
    // JSON on disk cannot distinguish an absent key from a null to a reader
    // who did not write the schema. `null` says "unpriceable" out loud.
    const report = buildHealthReport({
      ...reportOptions(new AgentHealthObservations()),
      cost: undefined,
      stopReason: undefined,
    });

    expect(report.loop.cost).toBeNull();
    expect(report.loop.stopReason).toBeNull();
    expect(Object.hasOwn(report.loop, "cost")).toBe(true);
  });
});

describe("buildHealthReport — model.summary is the one untrusted leaf", () => {
  it("joins only text blocks, dropping toolUse and toolResult", () => {
    // A `toolUse` block is the model asking for something and a `toolResult`
    // is this script's own output echoed back. Neither is narrative, and
    // stringifying either would smuggle structured content into a prose field.
    const report = buildHealthReport(
      reportOptions(new AgentHealthObservations(), {
        role: "assistant",
        content: [
          { type: "text", text: "first" },
          { type: "toolUse", toolUseId: "u1", name: "fleet_list", input: {} },
          { type: "text", text: "second" },
        ],
      }),
    );

    // The paragraph break survives as ESCAPED text, not as a live line feed:
    // `sanitizeForModel` escapes C0 (LF included), so `summary` is a single
    // line by construction. That is the documented price of reusing the
    // outbound sanitizer inbound rather than maintaining a second denylist.
    expect(report.model.summary).toBe("first\\u000a\\u000asecond");
    expect(report.model.summary).not.toContain("fleet_list");
  });

  it("returns null, never an empty string, when there is no text block", () => {
    // `""` reads as "the model said nothing meaningful", which is a different
    // claim from "the model produced no text block at all".
    const report = buildHealthReport(
      reportOptions(new AgentHealthObservations(), {
        role: "assistant",
        content: [
          { type: "toolUse", toolUseId: "u1", name: "fleet_list", input: {} },
        ],
      }),
    );

    expect(report.model.summary).toBeNull();
  });

  it("returns null when no message exists at all (a ceiling breach)", () => {
    expect(
      buildHealthReport(reportOptions(new AgentHealthObservations())).model
        .summary,
    ).toBeNull();
  });

  it("redacts a secret-shaped assignment before it can reach the artifact", () => {
    const report = buildHealthReport(
      reportOptions(new AgentHealthObservations(), {
        role: "assistant",
        content: [{ type: "text", text: "found token=zzSECRETzz in a log" }],
      }),
    );

    expect(String(report.model.summary)).not.toContain("zzSECRETzz");
  });

  it("escapes a bidi/C1 control, so `cat report.json` is not terminal injection", () => {
    // The reason the OUTBOUND sanitizer is reused inbound: the four hazards
    // are identical in both directions, and a human reading the artifact is
    // as exposed as the model was.
    const report = buildHealthReport(
      reportOptions(new AgentHealthObservations(), {
        role: "assistant",
        content: [{ type: "text", text: "before\u202eafter\x07" }],
      }),
    );

    const summary = String(report.model.summary);
    expect(summary).not.toContain("\u202e");
    expect(summary).not.toContain("\x07");
    expect(summary).toContain("\\u202e");
  });

  it("scrubs the workspace root out of the model's own words", () => {
    const report = buildHealthReport({
      ...reportOptions(new AgentHealthObservations(), {
        role: "assistant",
        content: [{ type: "text", text: "look in /host/repo/data" }],
      }),
      workspaceRoot: "/host/repo",
    });

    expect(String(report.model.summary)).not.toContain("/host/repo");
    expect(String(report.model.summary)).toContain("<workspace>");
  });

  it("caps an unbounded reply, so a chatty model cannot inflate the artifact", () => {
    const report = buildHealthReport(
      reportOptions(new AgentHealthObservations(), {
        role: "assistant",
        content: [{ type: "text", text: "x".repeat(10_000) }],
      }),
    );

    // 2048 retained code points plus the sanitizer's own ellipsis marker, so
    // a reader can tell a truncated summary from a short one.
    expect([...String(report.model.summary)]).toHaveLength(2049);
    expect(String(report.model.summary).endsWith("…")).toBe(true);
  });

  it("puts the model's words in exactly ONE place in the serialized artifact", () => {
    const marker = "zzMARKERzz";
    const report = buildHealthReport(
      reportOptions(
        withDoctor([{ name: "a", status: "fail", detail: "bad" }]),
        {
          role: "assistant",
          content: [{ type: "text", text: `note ${marker} here` }],
        },
      ),
    );

    expect(JSON.stringify(report).split(marker)).toHaveLength(2);
  });
});

describe("writeHealthReport", () => {
  it("writes under the OUTPUT directory, creating it when absent", async () => {
    // The output directory, not `data/agent-state/`: this IS a run artifact,
    // the kind an operator is meant to read and then clear — the exact
    // opposite of the cross-run counter.
    const nested = path.join(outputDir, "nested");
    vi.stubEnv("M3L_OUTPUT_DIR", nested);
    const report = buildHealthReport(
      reportOptions(new AgentHealthObservations()),
    );

    const written = await writeHealthReport({
      report,
      paths: new Core.M3LPaths(),
      output: undefined,
    });

    expect(await readdir(nested)).toEqual(["agent-operator-health-check.json"]);
    expect(JSON.parse(await readFile(written, "utf8"))).toMatchObject({
      kind: "m3l.agent-operator.health-check",
    });
  });

  it("honours an explicit output filename", async () => {
    vi.stubEnv("M3L_OUTPUT_DIR", outputDir);

    await writeHealthReport({
      report: buildHealthReport(reportOptions(new AgentHealthObservations())),
      paths: new Core.M3LPaths(),
      output: "custom-name.json",
    });

    expect(await readdir(outputDir)).toEqual(["custom-name.json"]);
  });

  it("refuses an output path that escapes the output directory", async () => {
    // `resolveOutput`'s containment guard, not wrapped: the library's own
    // message names the constraint, and the value is operator-supplied config
    // rather than model output.
    vi.stubEnv("M3L_OUTPUT_DIR", outputDir);

    await expect(
      writeHealthReport({
        report: buildHealthReport(reportOptions(new AgentHealthObservations())),
        paths: new Core.M3LPaths(),
        output: "../escaped.json",
      }),
    ).rejects.toBeInstanceOf(Core.M3LPathResolutionError);
  });
});
