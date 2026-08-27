/**
 * Tests for bin/lib/workflow-build-order.mjs — pure logic behind
 * bin/check-workflow-build-order.mjs (`pnpm check:workflow-build-order`).
 *
 * bin/check-workflow-build-order.mjs itself is NOT imported here: it executes
 * its full CLI body unconditionally at module load (no
 * `process.argv[1] === fileURLToPath(...)` main guard, no separately exported
 * functions) — the same shape documented in vitest.bin.config.ts's coverage
 * comment and bin/tests/check-script-docs.test.ts's header. This file follows
 * that established convention of exercising only the side-effect-free
 * bin/lib/*.mjs exports.
 *
 * resolveCliDistCone's fs interaction is exercised against a SYNTHETIC bin/
 * tree (never the live repo's own bin/ layout) per .claude/rules/tests.md's
 * "Test a bin/ checker against synthetic state, not just the live repo" rule
 * — a regression that only manifests the next time someone adds a bin/
 * script would otherwise stay invisible.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import * as fs from "node:fs";

// Spread the actual fs so vi.spyOn can intercept individual methods (ESM
// namespace objects are non-writable by default), following
// bin/tests/check-file-budget.test.ts / bin/tests/check-test-counts.test.ts.
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof fs>("node:fs");
  return { ...actual };
});

import {
  resolveCliDistCone,
  parseWorkflowJobSteps,
  findBuildOrderViolations,
} from "../lib/workflow-build-order.mjs";

/** Minimal fake `Dirent` satisfying the shape resolveCliDistCone reads. */
function fakeDirent(name: string, kind: "file" | "dir") {
  return {
    name,
    isDirectory: () => kind === "dir",
    isFile: () => kind === "file",
  };
}

// ---------------------------------------------------------------------------
// resolveCliDistCone
// ---------------------------------------------------------------------------

describe("resolveCliDistCone", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Synthetic bin/ tree:
  //   bin/a.mjs            — direct hit (imports packages/m3l-cli/dist/...)
  //   bin/lib/helper.mjs   — direct hit
  //   bin/lib/x.mjs        — imports ./y.mjs (cycle, no CLI dist import)
  //   bin/lib/y.mjs        — imports ./x.mjs (cycle, no CLI dist import)
  //   bin/consumer.mjs     — imports ./lib/helper.mjs (transitive hit)
  //   bin/unrelated.mjs    — imports only node:fs (not in cone)
  //   bin/tests/excluded.mjs — imports CLI dist directly, but bin/tests/**
  //                            is excluded from the walk entirely
  const root = "/repo";

  const TREE: Record<string, ReturnType<typeof fakeDirent>[]> = {
    "/repo/bin": [
      fakeDirent("a.mjs", "file"),
      fakeDirent("lib", "dir"),
      fakeDirent("consumer.mjs", "file"),
      fakeDirent("unrelated.mjs", "file"),
      fakeDirent("tests", "dir"),
    ],
    "/repo/bin/lib": [
      fakeDirent("helper.mjs", "file"),
      fakeDirent("x.mjs", "file"),
      fakeDirent("y.mjs", "file"),
    ],
  };

  const FILES: Record<string, string> = {
    "/repo/bin/a.mjs":
      'import { cli } from "../packages/m3l-cli/dist/index.js";\n',
    "/repo/bin/lib/helper.mjs":
      'import { cli } from "../../packages/m3l-cli/dist/index.js";\n',
    "/repo/bin/lib/x.mjs": 'import { y } from "./y.mjs";\n',
    "/repo/bin/lib/y.mjs": 'import { x } from "./x.mjs";\n',
    "/repo/bin/consumer.mjs": 'import { helper } from "./lib/helper.mjs";\n',
    "/repo/bin/unrelated.mjs": 'import { readFileSync } from "node:fs";\n',
  };

  function mockTree() {
    vi.spyOn(fs, "readdirSync").mockImplementation(((dir: string) => {
      const key = String(dir);
      const entries = TREE[key];
      if (!entries) throw new Error(`unexpected readdirSync(${key})`);
      return entries;
    }) as unknown as typeof fs.readdirSync);

    vi.spyOn(fs, "readFileSync").mockImplementation(((path: string) => {
      const key = String(path);
      const content = FILES[key];
      if (content === undefined) {
        throw new Error(`unexpected readFileSync(${key})`);
      }
      return content;
    }) as unknown as typeof fs.readFileSync);
  }

  test("includes a script that directly imports packages/m3l-cli/dist", () => {
    mockTree();
    const cone = resolveCliDistCone(root);
    expect(cone.has("bin/a.mjs")).toBe(true);
  });

  test("includes a bin/lib/*.mjs helper that directly imports packages/m3l-cli/dist", () => {
    mockTree();
    const cone = resolveCliDistCone(root);
    expect(cone.has("bin/lib/helper.mjs")).toBe(true);
  });

  test("transitively includes a script that only imports a direct-hit local helper", () => {
    mockTree();
    const cone = resolveCliDistCone(root);
    expect(cone.has("bin/consumer.mjs")).toBe(true);
  });

  test("excludes a script whose only import is an unrelated built-in", () => {
    mockTree();
    const cone = resolveCliDistCone(root);
    expect(cone.has("bin/unrelated.mjs")).toBe(false);
  });

  test("a local-import cycle with no CLI dist import resolves to not-in-cone without infinite looping", () => {
    mockTree();
    const cone = resolveCliDistCone(root);
    expect(cone.has("bin/lib/x.mjs")).toBe(false);
    expect(cone.has("bin/lib/y.mjs")).toBe(false);
  });

  test("never reads or includes a bin/tests/** file, even one that directly imports the CLI dist", () => {
    // bin/tests/excluded.mjs is deliberately absent from FILES: if the walk
    // ever tried to read it, readFileSync's mock throws and this test fails
    // loudly instead of silently passing.
    mockTree();
    const cone = resolveCliDistCone(root);
    expect(cone.has("bin/tests/excluded.mjs")).toBe(false);
    expect(() => resolveCliDistCone(root)).not.toThrow();
  });

  test("returns exactly the three in-cone scripts, nothing more", () => {
    mockTree();
    const cone = resolveCliDistCone(root);
    expect([...cone].sort()).toEqual(
      ["bin/a.mjs", "bin/consumer.mjs", "bin/lib/helper.mjs"].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// parseWorkflowJobSteps
// ---------------------------------------------------------------------------

describe("parseWorkflowJobSteps", () => {
  test("parses a single-line run: step", () => {
    const wf = [
      "jobs:",
      "  gates:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: Lint",
      "        run: pnpm lint",
      "",
    ].join("\n");

    const jobs = parseWorkflowJobSteps(wf);
    expect(jobs.get("gates")).toEqual([{ name: "Lint", run: "pnpm lint" }]);
  });

  test("parses a run: | block-scalar step spanning multiple lines", () => {
    const wf = [
      "jobs:",
      "  gates:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: Multi-line shell",
      "        run: |",
      "          echo one",
      "          echo two",
      "",
    ].join("\n");

    const jobs = parseWorkflowJobSteps(wf);
    const steps = jobs.get("gates");
    expect(steps).toHaveLength(1);
    expect(steps?.[0]?.name).toBe("Multi-line shell");
    expect(steps?.[0]?.run).toContain("echo one");
    expect(steps?.[0]?.run).toContain("echo two");
  });

  test("parses a run: > block-scalar step the same way as run: |", () => {
    const wf = [
      "jobs:",
      "  gates:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: Folded shell",
      "        run: >",
      "          echo folded",
      "",
    ].join("\n");

    const steps = parseWorkflowJobSteps(wf).get("gates");
    expect(steps?.[0]?.run).toContain("echo folded");
  });

  test("represents a uses:-only step (no run:) with an empty run string", () => {
    const wf = [
      "jobs:",
      "  gates:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: actions/checkout@abc123",
      "      - name: Lint",
      "        run: pnpm lint",
      "",
    ].join("\n");

    const steps = parseWorkflowJobSteps(wf).get("gates");
    expect(steps).toHaveLength(2);
    expect(steps?.[0]?.name).toBeUndefined();
    expect(steps?.[0]?.run).toBe("");
    expect(steps?.[1]?.name).toBe("Lint");
  });

  test("keeps steps from different jobs separate, in order, with no leakage across job boundaries", () => {
    const wf = [
      "jobs:",
      "  gates:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: Gates step one",
      "        run: pnpm check:one",
      "      - name: Gates step two",
      "        run: pnpm check:two",
      "  build:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: Build step",
      "        run: pnpm build",
      "",
    ].join("\n");

    const jobs = parseWorkflowJobSteps(wf);
    expect([...jobs.keys()]).toEqual(["gates", "build"]);
    expect(jobs.get("gates")).toEqual([
      { name: "Gates step one", run: "pnpm check:one" },
      { name: "Gates step two", run: "pnpm check:two" },
    ]);
    expect(jobs.get("build")).toEqual([
      { name: "Build step", run: "pnpm build" },
    ]);
  });

  test("returns an empty map when there is no jobs: section", () => {
    expect(parseWorkflowJobSteps("name: CI\non: push\n")).toEqual(new Map());
  });
});

// ---------------------------------------------------------------------------
// findBuildOrderViolations
// ---------------------------------------------------------------------------

describe("findBuildOrderViolations", () => {
  const workflowPath = ".github/workflows/ci.yml";

  test("[buggy fixture] an in-cone script invoked with no prior build step reports exactly one violation", () => {
    const cliDistCone = new Set(["bin/gen-project-hub.mjs"]);
    const wf = [
      "jobs:",
      "  gates:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: actions/checkout@abc123",
      "      - name: Generate project hub",
      "        run: node bin/gen-project-hub.mjs",
      "",
    ].join("\n");

    const violations = findBuildOrderViolations(
      workflowPath,
      wf,
      cliDistCone,
      {},
    );

    expect(violations).toEqual([
      {
        workflow: workflowPath,
        job: "gates",
        step: "Generate project hub",
        script: "bin/gen-project-hub.mjs",
      },
    ]);
  });

  test("[fixed fixture] a correctly-scoped CLI build step before the in-cone script reports zero violations", () => {
    const cliDistCone = new Set(["bin/gen-project-hub.mjs"]);
    const wf = [
      "jobs:",
      "  gates:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: actions/checkout@abc123",
      "      - name: Build CLI",
      "        run: pnpm turbo run build --filter=@m3l-automation/m3l-cli",
      "      - name: Generate project hub",
      "        run: node bin/gen-project-hub.mjs",
      "",
    ].join("\n");

    expect(findBuildOrderViolations(workflowPath, wf, cliDistCone, {})).toEqual(
      [],
    );
  });

  test("an unscoped `pnpm build` step satisfies the build requirement", () => {
    const cliDistCone = new Set(["bin/gen-project-hub.mjs"]);
    const wf = [
      "jobs:",
      "  gates:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: Build",
      "        run: pnpm build",
      "      - name: Generate project hub",
      "        run: node bin/gen-project-hub.mjs",
      "",
    ].join("\n");

    expect(findBuildOrderViolations(workflowPath, wf, cliDistCone, {})).toEqual(
      [],
    );
  });

  test("a turbo build step scoped to a DIFFERENT package does not satisfy the requirement", () => {
    const cliDistCone = new Set(["bin/gen-project-hub.mjs"]);
    const wf = [
      "jobs:",
      "  gates:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: Build other package",
      "        run: pnpm turbo run build --filter=@m3l-automation/some-other-package",
      "      - name: Generate project hub",
      "        run: node bin/gen-project-hub.mjs",
      "",
    ].join("\n");

    const violations = findBuildOrderViolations(
      workflowPath,
      wf,
      cliDistCone,
      {},
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.script).toBe("bin/gen-project-hub.mjs");
  });

  test("a `pnpm <scriptName>` alias resolving (via packageScripts) to an in-cone node bin/*.mjs invocation is detected the same as a direct call", () => {
    const cliDistCone = new Set(["bin/gen-project-hub.mjs"]);
    const packageScripts = {
      "gen-project-hub": "node bin/gen-project-hub.mjs",
    };
    const wf = [
      "jobs:",
      "  gates:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: Generate project hub",
      "        run: pnpm gen-project-hub",
      "",
    ].join("\n");

    const violations = findBuildOrderViolations(
      workflowPath,
      wf,
      cliDistCone,
      packageScripts,
    );
    expect(violations).toEqual([
      {
        workflow: workflowPath,
        job: "gates",
        step: "Generate project hub",
        script: "bin/gen-project-hub.mjs",
      },
    ]);
  });

  test("a `pnpm <scriptName>` alias with a prior scoped `turbo run build --filter=` step reports zero violations", () => {
    const cliDistCone = new Set(["bin/gen-project-hub.mjs"]);
    const packageScripts = {
      "gen-project-hub": "node bin/gen-project-hub.mjs",
    };
    const wf = [
      "jobs:",
      "  gates:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: Build CLI",
      "        run: pnpm turbo run build --filter=@m3l-automation/m3l-cli",
      "      - name: Generate project hub",
      "        run: pnpm gen-project-hub",
      "",
    ].join("\n");

    expect(
      findBuildOrderViolations(workflowPath, wf, cliDistCone, packageScripts),
    ).toEqual([]);
  });

  // stepBuildsCli recognizes pnpm's OWN workspace-filter syntax
  // (`pnpm --filter <pkg> build` / `pnpm --filter=<pkg> build`), distinct
  // from turbo's `--filter`, as satisfying the build requirement when
  // `<pkg>` is @m3l-automation/m3l-cli. Previously a gap (test.fails
  // regression noted this form was unrecognized); fixed in
  // bin/lib/workflow-build-order.mjs.
  test("a `pnpm --filter @m3l-automation/m3l-cli build` step satisfies the build requirement", () => {
    const cliDistCone = new Set(["bin/gen-project-hub.mjs"]);
    const wf = [
      "jobs:",
      "  gates:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: Build CLI",
      "        run: pnpm --filter @m3l-automation/m3l-cli build",
      "      - name: Generate project hub",
      "        run: node bin/gen-project-hub.mjs",
      "",
    ].join("\n");

    expect(findBuildOrderViolations(workflowPath, wf, cliDistCone, {})).toEqual(
      [],
    );
  });

  test("a `pnpm --filter=@m3l-automation/m3l-cli build` step (equals-sign form) also satisfies the build requirement", () => {
    const cliDistCone = new Set(["bin/gen-project-hub.mjs"]);
    const wf = [
      "jobs:",
      "  gates:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: Build CLI",
      "        run: pnpm --filter=@m3l-automation/m3l-cli build",
      "      - name: Generate project hub",
      "        run: node bin/gen-project-hub.mjs",
      "",
    ].join("\n");

    expect(findBuildOrderViolations(workflowPath, wf, cliDistCone, {})).toEqual(
      [],
    );
  });

  test("a `pnpm --filter` build step scoped to a DIFFERENT package does not satisfy the requirement", () => {
    const cliDistCone = new Set(["bin/gen-project-hub.mjs"]);
    const wf = [
      "jobs:",
      "  gates:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: Build other package",
      "        run: pnpm --filter @m3l-automation/some-other-package build",
      "      - name: Generate project hub",
      "        run: node bin/gen-project-hub.mjs",
      "",
    ].join("\n");

    const violations = findBuildOrderViolations(
      workflowPath,
      wf,
      cliDistCone,
      {},
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.script).toBe("bin/gen-project-hub.mjs");
  });

  test("a script NOT in cliDistCone never triggers a violation, regardless of any build step", () => {
    const cliDistCone = new Set(["bin/gen-project-hub.mjs"]);
    const wf = [
      "jobs:",
      "  gates:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: Run unrelated script",
      "        run: node bin/check-something-else.mjs",
      "",
    ].join("\n");

    expect(findBuildOrderViolations(workflowPath, wf, cliDistCone, {})).toEqual(
      [],
    );
  });

  test("a build step in one job does not count for an in-cone script invoked in a different job", () => {
    const cliDistCone = new Set(["bin/gen-project-hub.mjs"]);
    const wf = [
      "jobs:",
      "  a:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: Build CLI",
      "        run: pnpm turbo run build --filter=@m3l-automation/m3l-cli",
      "  b:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: Generate project hub",
      "        run: node bin/gen-project-hub.mjs",
      "",
    ].join("\n");

    const violations = findBuildOrderViolations(
      workflowPath,
      wf,
      cliDistCone,
      {},
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.job).toBe("b");
  });

  test("falls back to '(unnamed step)' when a violating step has no name:", () => {
    const cliDistCone = new Set(["bin/gen-project-hub.mjs"]);
    const wf = [
      "jobs:",
      "  gates:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: actions/checkout@abc123",
      "        run: node bin/gen-project-hub.mjs",
      "",
    ].join("\n");

    const violations = findBuildOrderViolations(
      workflowPath,
      wf,
      cliDistCone,
      {},
    );
    expect(violations).toEqual([
      {
        workflow: workflowPath,
        job: "gates",
        step: "(unnamed step)",
        script: "bin/gen-project-hub.mjs",
      },
    ]);
  });
});
