/**
 * Tests for `steps/build-health-tools` — the four `AgentToolSpec`s the fleet
 * health-check workload exposes, and the one trust boundary they all share.
 *
 * Exercised directly rather than through `runBedrockToolLoop`, on purpose:
 * `describeAction` is the boundary that must hold for **any** input, and the
 * library declines to transmit a `toolUse` block whose input cannot round-trip
 * through the Converse document type — so a whole class of hostile inputs
 * (`undefined`, a prototype-only object) can never reach it from a real model.
 * The boundary must still refuse them, because nothing guarantees the next
 * dispatcher is that careful. `run-health-check.test.ts` covers the same specs
 * through the real loop.
 */

import { describe, expect, it, vi } from "vitest";

import { M3LAgentOperatorCliError } from "../../src/lib/errors.js";
import type { AgentCliSurface } from "../../src/lib/cli-surface.js";
import {
  AGENT_HEALTH_TOOL_NAMES,
  buildHealthTools,
} from "../../src/steps/build-health-tools.js";
import type { AgentToolSpec } from "../../src/steps/gate-tool.js";
import { AgentHealthObservations } from "../../src/steps/health-observations.js";
import {
  projectDoctorReport,
  projectListRow,
} from "../../src/lib/model-safety.js";

/** A surface whose every method rejects — for the pure-boundary tests. */
function unusedSurface(): AgentCliSurface {
  const refuse = (): Promise<never> =>
    Promise.reject(new Error("unexpected CLI call"));
  // `run` (V9 slice 2a) refuses like the other four rather than resolving a
  // stub envelope: it is the one mutating operation on the surface, so a
  // stray call from a pure-boundary test must fail loudly, not be absorbed.
  return {
    list: refuse,
    doctor: refuse,
    inspect: refuse,
    dryRun: refuse,
    run: refuse,
  };
}

/** Builds the specs with a real collector and a caller-supplied surface. */
function build(
  surface: AgentCliSurface = unusedSurface(),
  includeDryRunProbe = true,
): {
  readonly specs: readonly AgentToolSpec[];
  readonly observations: AgentHealthObservations;
} {
  const observations = new AgentHealthObservations();
  return {
    specs: buildHealthTools({ surface, observations, includeDryRunProbe }),
    observations,
  };
}

/** Looks up one spec by name, failing loudly rather than returning undefined. */
function spec(name: string, includeDryRunProbe = true): AgentToolSpec {
  const found = build(unusedSurface(), includeDryRunProbe).specs.find(
    (candidate) => candidate.name === name,
  );
  if (found === undefined) throw new Error(`${name} was not built`);
  return found;
}

/**
 * Builds the specs over `surface`/`observations` and returns the one named
 * `name` — failing loudly rather than indexing positionally, so a reordering
 * of the spec list cannot silently retarget a test.
 */
function named(
  surface: AgentCliSurface,
  observations: AgentHealthObservations,
  name: string,
): AgentToolSpec {
  const found = buildHealthTools({
    surface,
    observations,
    includeDryRunProbe: true,
  }).find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`${name} was not built`);
  return found;
}

/** Narrows a schema's `properties` object without a cast. */
function schemaProperties(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error("inputSchema is not an object");
  }
  const properties = (value as Record<string, unknown>)["properties"];
  if (typeof properties !== "object" || properties === null) {
    throw new Error("inputSchema declares no properties object");
  }
  return properties as Record<string, unknown>;
}

describe("buildHealthTools — the one-value invariant", () => {
  // Mechanised form of the sentence the whole model-safety boundary rests on:
  // "the model supplies exactly one value across the whole tool surface — a
  // script name." Adding a second field to ANY tool fails this.
  it.each([
    [AGENT_HEALTH_TOOL_NAMES.fleetList, 0],
    [AGENT_HEALTH_TOOL_NAMES.fleetDoctor, 0],
    [AGENT_HEALTH_TOOL_NAMES.scriptInspect, 1],
    [AGENT_HEALTH_TOOL_NAMES.scriptDryRun, 1],
  ])("%s declares exactly %i input property", (name, count) => {
    expect(Object.keys(schemaProperties(spec(name).inputSchema))).toHaveLength(
      count,
    );
  });

  it("declares scriptName as the only property either per-script tool accepts", () => {
    for (const name of [
      AGENT_HEALTH_TOOL_NAMES.scriptInspect,
      AGENT_HEALTH_TOOL_NAMES.scriptDryRun,
    ]) {
      expect(Object.keys(schemaProperties(spec(name).inputSchema))).toEqual([
        "scriptName",
      ]);
    }
  });
});

describe("buildHealthTools — describeAction is the trust boundary", () => {
  it("never derives kind from input: every action is read-only", () => {
    // A model that could choose `kind` could choose its own autonomy tier.
    expect(
      spec(AGENT_HEALTH_TOOL_NAMES.scriptInspect).describeAction({
        scriptName: "s3-objects",
        kind: "mutating",
      }).kind,
    ).toBe("read-only");
    expect(
      spec(AGENT_HEALTH_TOOL_NAMES.fleetList).describeAction({}).kind,
    ).toBe("read-only");
  });

  it("maps each tool onto the operation the committed policy actually grants", () => {
    // The policy's `agent-operator` grant declares `list`/`doctor`; every
    // fleet-script grant declares `inspect`/`dry-run`. A drift here silently
    // turns an authorized tool into an ungranted one.
    expect(
      spec(AGENT_HEALTH_TOOL_NAMES.fleetList).describeAction({}),
    ).toMatchObject({ script: "agent-operator", operation: "list" });
    expect(
      spec(AGENT_HEALTH_TOOL_NAMES.fleetDoctor).describeAction({}),
    ).toMatchObject({ script: "agent-operator", operation: "doctor" });
    expect(
      spec(AGENT_HEALTH_TOOL_NAMES.scriptInspect).describeAction({
        scriptName: "s3-objects",
      }),
    ).toMatchObject({ script: "s3-objects", operation: "inspect" });
    expect(
      spec(AGENT_HEALTH_TOOL_NAMES.scriptDryRun).describeAction({
        scriptName: "s3-objects",
      }),
    ).toMatchObject({ script: "s3-objects", operation: "dry-run" });
  });

  it("reads scriptName with Object.hasOwn, refusing a prototype-chain value", () => {
    // A model can literally send `{"__proto__": {"scriptName": "…"}}`. A
    // bracket read answers from the prototype chain; `Object.hasOwn` refuses.
    const inspect = spec(AGENT_HEALTH_TOOL_NAMES.scriptInspect);

    expect(inspect.describeAction({ scriptName: "s3-objects" }).script).toBe(
      "s3-objects",
    );
    expect(() =>
      inspect.describeAction(Object.create({ scriptName: "s3-objects" })),
    ).toThrow(M3LAgentOperatorCliError);
  });

  it.each([
    ["a non-object input", 42],
    ["null", null],
    ["undefined", undefined],
    ["an object with no scriptName", {}],
    ["a non-string scriptName", { scriptName: 7 }],
    ["a name outside the allowlist", { scriptName: "../etc/passwd" }],
    ["a name starting with a dash", { scriptName: "-rf" }],
    ["a 5,000-character name", { scriptName: "a".repeat(5000) }],
  ] as ReadonlyArray<readonly [label: string, input: unknown]>)(
    "refuses %s with ERR_AGENT_OPERATOR_SCRIPT_NAME",
    (_label, input) => {
      let thrown: unknown;
      try {
        spec(AGENT_HEALTH_TOOL_NAMES.scriptInspect).describeAction(input);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
      expect((thrown as M3LAgentOperatorCliError).code).toBe(
        "ERR_AGENT_OPERATOR_SCRIPT_NAME",
      );
    },
  );

  it("never echoes the rejected name back, because it is model-supplied", () => {
    // The length cap is what stops a hostile name from building a decision-log
    // entry that breaches the log's line ceiling — a model-triggerable
    // self-DOS. Echoing it into our own message would reintroduce the
    // unbounded string one layer up.
    const hostile = "zzHOSTILEzz".repeat(500);
    let thrown: unknown;
    try {
      spec(AGENT_HEALTH_TOOL_NAMES.scriptInspect).describeAction({
        scriptName: hostile,
      });
    } catch (error) {
      thrown = error;
    }

    const error = thrown as M3LAgentOperatorCliError;
    expect(error.message).not.toContain("zzHOSTILEzz");
    expect(JSON.stringify(error.context ?? {})).not.toContain("zzHOSTILEzz");
  });

  it.each([
    ["undefined", undefined],
    ["an empty object", {}],
    ["a populated object", { scriptName: "../nope", extra: true }],
    ["a prototype-polluted object", Object.create({ scriptName: "x" })],
  ] as ReadonlyArray<readonly [label: string, input: unknown]>)(
    "fleet_list and fleet_doctor accept %s and never read it",
    (_label, input) => {
      // The ignoring IS the guarantee: it is what preserves "the model
      // supplies exactly one value across the whole tool surface".
      expect(() =>
        spec(AGENT_HEALTH_TOOL_NAMES.fleetList).describeAction(input),
      ).not.toThrow();
      expect(() =>
        spec(AGENT_HEALTH_TOOL_NAMES.fleetDoctor).describeAction(input),
      ).not.toThrow();
    },
  );
});

describe("buildHealthTools — script_dry_run is fail-closed", () => {
  it("is not built at all when probes are disarmed", () => {
    const names = build(unusedSurface(), false).specs.map((s) => s.name);

    expect(names).toEqual([
      AGENT_HEALTH_TOOL_NAMES.fleetList,
      AGENT_HEALTH_TOOL_NAMES.fleetDoctor,
      AGENT_HEALTH_TOOL_NAMES.scriptInspect,
    ]);
    expect(names).not.toContain(AGENT_HEALTH_TOOL_NAMES.scriptDryRun);
  });

  it("is built when probes are armed", () => {
    expect(build(unusedSurface(), true).specs).toHaveLength(4);
  });
});

describe("buildHealthTools — execute records into the collector", () => {
  it("records the fleet roster and hands it back as a JSON block", async () => {
    const rows = [
      projectListRow({
        name: "s3-objects",
        description: "d",
        parameterCount: 3,
        loadError: null,
      }),
    ];
    const list = vi.fn(() => Promise.resolve(rows));
    const surface = { ...unusedSurface(), list };
    const observations = new AgentHealthObservations();
    const result = await named(
      surface,
      observations,
      AGENT_HEALTH_TOOL_NAMES.fleetList,
    ).execute({}, { toolUseId: "u", name: "fleet_list" });

    expect(list).toHaveBeenCalledTimes(1);
    expect(observations.snapshot().fleet).toBe(rows);
    // A JSON block, never text: untrusted values reach the model only as JSON
    // leaves, never concatenated into prose it reads as instruction.
    expect(result.content).toEqual([{ type: "json", json: rows }]);
  });

  it("records the doctor report", async () => {
    const report = projectDoctorReport([
      { name: "chk", status: "ok", detail: "fine" },
    ]);
    const doctor = vi.fn(() => Promise.resolve(report));
    const surface = { ...unusedSurface(), doctor };
    const observations = new AgentHealthObservations();
    await named(
      surface,
      observations,
      AGENT_HEALTH_TOOL_NAMES.fleetDoctor,
    ).execute({}, { toolUseId: "u", name: "fleet_doctor" });

    expect(doctor).toHaveBeenCalledTimes(1);
    expect(observations.snapshot().doctor).toBe(report);
  });

  it("re-validates the script name in execute, not just in describeAction", async () => {
    // The gate calls the two independently. A cached name threaded down from
    // `describeAction` would be a second source of truth to keep in step.
    const inspect = vi.fn(() => Promise.resolve([]));
    const surface = { ...unusedSurface(), inspect };

    await expect(
      named(
        surface,
        new AgentHealthObservations(),
        AGENT_HEALTH_TOOL_NAMES.scriptInspect,
      ).execute(
        { scriptName: "../escape" },
        { toolUseId: "u", name: "script_inspect" },
      ),
    ).rejects.toBeInstanceOf(M3LAgentOperatorCliError);
    expect(inspect).not.toHaveBeenCalled();
  });
});
