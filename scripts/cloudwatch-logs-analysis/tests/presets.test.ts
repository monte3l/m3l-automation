import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import { buildAnalysisProcedure } from "../src/steps/build-procedure.js";
import { parseRunbookPreset, PRESET_CODE } from "../src/steps/load-runbook.js";

/**
 * The committed `presets/` directory is documentation-as-fixture: one
 * structural example per stage combination. This is the same check
 * `--operation validate` performs, run against the shipped examples so a
 * change to the schema or the step graph cannot leave them stale.
 *
 * **This file reads the real filesystem, deliberately, and that is the one
 * exception in this package.** Every sibling test mocks `node:fs/promises`
 * because their subject is a *behaviour* that happens to do I/O. Here the
 * subject IS the committed artifacts: mocking the reads would leave the test
 * validating a copy pasted into the test file, which is exactly the drift it
 * exists to catch. `packages/m3l-common/tests/text.test.ts` takes the same
 * shape for the same reason — it hands real committed fixture paths to the
 * extractor unmocked.
 *
 * The reads are also all module-level and synchronous, so they run once at
 * collection rather than per test, and nothing here is order-dependent or
 * mutates disk. `readdirSync` is load-bearing rather than incidental: it is
 * what makes a *fourth* preset added later fail this suite instead of
 * shipping unvalidated.
 */
const presetsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "presets",
);
const files = readdirSync(presetsDir).filter((name) => name.endsWith(".json"));
const reader = new Core.M3LInputFileReader({
  paths: new Core.M3LPaths(),
  code: PRESET_CODE,
});

/** Parses one committed preset file. */
function load(name: string): ReturnType<typeof parseRunbookPreset> {
  const record = JSON.parse(
    readFileSync(join(presetsDir, name), "utf8"),
  ) as Record<string, unknown>;
  return parseRunbookPreset(reader, record, name);
}

describe("the committed example presets", () => {
  it("ships one example per stage combination", () => {
    expect(new Set(files)).toEqual(
      new Set([
        "example-gateway-5xx.json",
        "example-function-errors.json",
        "example-broker-memory.json",
      ]),
    );
  });

  it.each(files)("%s passes the trust boundary and builds clean", (name) => {
    const preset = load(name);
    expect(preset.todos).toEqual([]);
    expect(() => buildAnalysisProcedure(preset)).not.toThrow();
  });

  it.each(files)("%s is keyed by its own file stem", (name) => {
    expect(`${load(name).alarm}.json`).toBe(name);
  });

  it("covers the full-stage combination: ladder, authorizer and a trace chain", () => {
    const preset = load("example-gateway-5xx.json");
    expect(preset.severityLadder.length).toBeGreaterThan(1);
    expect(preset.severityPlaceholder).toBeDefined();
    expect(preset.authorizer).toBeDefined();
    expect(preset.trace.length).toBeGreaterThan(1);
  });

  it("covers the minimal combination: no ladder, no authorizer, no trace", () => {
    const preset = load("example-function-errors.json");
    expect(preset.severityLadder).toEqual([]);
    expect(preset.authorizer).toBeUndefined();
    expect(preset.trace).toEqual([]);
  });

  it("covers the out-of-scope combination, with manual steps in place of stages", () => {
    const preset = load("example-broker-memory.json");
    expect(preset.entry).toBeUndefined();
    expect(preset.unsupported?.manualSteps.length).toBeGreaterThan(0);
  });

  it.each(files)(
    "%s declares only authorable verdicts on its case rows",
    (name) => {
      for (const row of load(name).cases) {
        expect(row.verdict).not.toBe("no-evidence");
        expect(row.verdict).not.toBe("no-correlation-id");
        expect(row.verdict).not.toBe("unsupported");
      }
    },
  );

  it.each(files)("%s uses placeholder identifiers only", (name) => {
    const raw = readFileSync(join(presetsDir, name), "utf8");
    for (const logGroup of load(name).entry?.logGroups ?? []) {
      expect(logGroup.startsWith("/example/")).toBe(true);
    }
    expect(raw).toContain("example");
  });
});
