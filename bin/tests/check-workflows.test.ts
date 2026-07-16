import { describe, expect, test } from "vitest";
import {
  extractMaxAgents,
  extractPropLiterals,
  MAX_WORKFLOW_AGENTS,
  parseWorkflowScriptRows,
  validateWorkflowSurface,
} from "../check-workflows.mjs";

describe("MAX_WORKFLOW_AGENTS", () => {
  test("pins the ADR-0025 guardrail ceiling at 25", () => {
    expect(MAX_WORKFLOW_AGENTS).toBe(25);
  });
});

describe("extractPropLiterals", () => {
  test("finds multiple model literals in double and single quotes", () => {
    const source =
      "const a = { model: \"sonnet\" };\nconst b = { model: 'opus' };\n";
    expect(extractPropLiterals(source, "model")).toEqual({
      literals: ["sonnet", "opus"],
      dynamicCount: 0,
    });
  });

  test("finds multiple effort literals the same way", () => {
    const source =
      "const a = { effort: \"medium\" };\nconst b = { effort: 'high' };\n";
    expect(extractPropLiterals(source, "effort")).toEqual({
      literals: ["medium", "high"],
      dynamicCount: 0,
    });
  });

  test("counts an identifier value as dynamic, not a literal", () => {
    const source = "const a = { model: someVar };\n";
    expect(extractPropLiterals(source, "model")).toEqual({
      literals: [],
      dynamicCount: 1,
    });
  });

  test("counts a ternary value as dynamic, not a literal", () => {
    const source = 'const a = { model: cond ? "a" : "b" };\n';
    expect(extractPropLiterals(source, "model")).toEqual({
      literals: [],
      dynamicCount: 1,
    });
  });

  test("counts a template-literal value as dynamic, not a literal", () => {
    const source = "const a = { model: `${dynamicModel}` };\n";
    expect(extractPropLiterals(source, "model")).toEqual({
      literals: [],
      dynamicCount: 1,
    });
  });

  test("returns empty literals and zero dynamic count when the prop is absent", () => {
    const source = "const a = { other: 1 };\n";
    expect(extractPropLiterals(source, "model")).toEqual({
      literals: [],
      dynamicCount: 0,
    });
  });
});

describe("extractMaxAgents", () => {
  test("parses the max-agents header from the first lines", () => {
    const source = "// max-agents: 20\nexport const run = () => {};\n";
    expect(extractMaxAgents(source)).toBe(20);
  });

  test("returns null when the header is absent", () => {
    const source = "export const run = () => {};\n";
    expect(extractMaxAgents(source)).toBeNull();
  });

  test("returns null when the header is malformed", () => {
    const source = "// max-agents: lots\nexport const run = () => {};\n";
    expect(extractMaxAgents(source)).toBeNull();
  });

  test("returns null when the header appears after the first 10 lines", () => {
    const filler = Array.from({ length: 10 }, (_, i) => `// line ${i}`).join(
      "\n",
    );
    const source = `${filler}\n// max-agents: 20\n`;
    expect(extractMaxAgents(source)).toBeNull();
  });
});

describe("parseWorkflowScriptRows", () => {
  const docWithMatrix = [
    "# Model Selection",
    "",
    "<!-- BEGIN MODEL-MATRIX -->",
    "| Surface | Name | Model | Effort |",
    "| ------- | ---- | ----- | ------ |",
    "| agent | `code-implementer` | `sonnet` | `high` |",
    "| workflow | `ci.yml` | `sonnet` | `medium` |",
    "| workflow-script | `deploy.js` | `sonnet` | `high` |",
    "| workflow-script | `deploy.js:rollback` | `opus` | `medium` |",
    "<!-- END MODEL-MATRIX -->",
    "",
    "Some other prose.",
    "",
  ].join("\n");

  test("reads only workflow-script rows, ignoring agent and workflow rows", () => {
    const rows = parseWorkflowScriptRows(docWithMatrix);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.file === "deploy.js")).toBe(true);
  });

  test("splits a file:label row and leaves a bare row's label null", () => {
    const rows = parseWorkflowScriptRows(docWithMatrix);
    expect(rows[0]).toEqual({
      name: "deploy.js",
      file: "deploy.js",
      label: null,
      model: "sonnet",
      effort: "high",
    });
    expect(rows[1]).toEqual({
      name: "deploy.js:rollback",
      file: "deploy.js",
      label: "rollback",
      model: "opus",
      effort: "medium",
    });
  });

  test("throws when the BEGIN/END MODEL-MATRIX block is missing", () => {
    expect(() => parseWorkflowScriptRows("# no matrix here\n")).toThrow(
      /MODEL-MATRIX block/,
    );
  });
});

describe("validateWorkflowSurface", () => {
  test("R1: flags a row naming a file that does not exist", () => {
    const scripts = new Map<string, string>();
    const rows = [
      {
        name: "missing.js",
        file: "missing.js",
        label: null,
        model: "sonnet",
        effort: "n/a",
      },
    ];
    const errors = validateWorkflowSurface(scripts, rows);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/does not exist under \.claude\/workflows\//);
    expect(errors[0]).toMatch(/R1/);
  });

  test("R2: flags a script with zero file-level matrix rows", () => {
    const scripts = new Map([
      ["a.js", "// max-agents: 5\nexport const run = () => {};\n"],
    ]);
    const errors = validateWorkflowSurface(scripts, []);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/0 file-level/);
    expect(errors[0]).toMatch(/R2/);
  });

  test("R2: flags a script with two file-level matrix rows", () => {
    const scripts = new Map([
      ["a.js", "// max-agents: 5\nexport const run = () => {};\n"],
    ]);
    const rows = [
      {
        name: "a.js",
        file: "a.js",
        label: null,
        model: "sonnet",
        effort: "n/a",
      },
      {
        name: "a.js",
        file: "a.js",
        label: null,
        model: "opus",
        effort: "n/a",
      },
    ];
    const errors = validateWorkflowSurface(scripts, rows);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/2 file-level/);
    expect(errors[0]).toMatch(/R2/);
  });

  test("R3: flags a script literal with no matching matrix row", () => {
    const scripts = new Map([
      ["a.js", '// max-agents: 5\nconst cfg = { model: "sonnet" };\n'],
    ]);
    const rows = [
      {
        name: "a.js",
        file: "a.js",
        label: null,
        model: "opus",
        effort: "n/a",
      },
    ];
    const errors = validateWorkflowSurface(scripts, rows);
    expect(
      errors.some((e) => e.includes("model: sonnet") && e.includes("R3")),
    ).toBe(true);
  });

  test("R4: flags a step row pinning a model/effort the script never carries", () => {
    const scripts = new Map([
      [
        "a.js",
        '// max-agents: 5\nconst cfg = { model: "opus", effort: "high" };\nrunStep("build");\n',
      ],
    ]);
    const rows = [
      {
        name: "a.js",
        file: "a.js",
        label: null,
        model: "opus",
        effort: "high",
      },
      {
        name: "a.js:build",
        file: "a.js",
        label: "build",
        model: "sonnet",
        effort: "medium",
      },
    ];
    const errors = validateWorkflowSurface(scripts, rows);
    expect(
      errors.some(
        (e) => e.includes("model: sonnet") && e.includes("stale step row"),
      ),
    ).toBe(true);
    expect(
      errors.some(
        (e) => e.includes("effort: medium") && e.includes("stale step row"),
      ),
    ).toBe(true);
  });

  test("R4: flags a step row whose label never appears as a quoted string", () => {
    const scripts = new Map([
      [
        "a.js",
        '// max-agents: 5\nconst cfg = { model: "sonnet", effort: "medium" };\n',
      ],
    ]);
    const rows = [
      {
        name: "a.js",
        file: "a.js",
        label: null,
        model: "sonnet",
        effort: "medium",
      },
      {
        name: "a.js:missingLabel",
        file: "a.js",
        label: "missingLabel",
        model: "sonnet",
        effort: "medium",
      },
    ];
    const errors = validateWorkflowSurface(scripts, rows);
    expect(
      errors.some(
        (e) =>
          e.includes("missingLabel") &&
          e.includes("never appears as a string literal"),
      ),
    ).toBe(true);
  });

  test("R5: flags a matrix row pinning an illegal model", () => {
    const scripts = new Map([
      ["a.js", "// max-agents: 5\nexport const run = () => {};\n"],
    ]);
    const rows = [
      {
        name: "a.js",
        file: "a.js",
        label: null,
        model: "gpt-4",
        effort: "n/a",
      },
    ];
    const errors = validateWorkflowSurface(scripts, rows);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/gpt-4/);
    expect(errors[0]).toMatch(/R5/);
  });

  test("R5: flags a step row with effort n/a but allows it on a file-level row", () => {
    const scripts = new Map([["a.js", "// max-agents: 5\n"]]);
    const rows = [
      {
        name: "a.js",
        file: "a.js",
        label: null,
        model: "sonnet",
        effort: "n/a",
      },
      {
        name: "a.js:step",
        file: "a.js",
        label: "step",
        model: "sonnet",
        effort: "n/a",
      },
    ];
    const errors = validateWorkflowSurface(scripts, rows);
    expect(
      errors.some((e) => e.includes("only a file-level row may carry")),
    ).toBe(true);
    expect(
      errors.every(
        (e) =>
          !e.startsWith("MODEL-MATRIX workflow-script row `a.js` pins effort"),
      ),
    ).toBe(true);
  });

  test("R6: flags a non-literal model value as not statically auditable", () => {
    const scripts = new Map([
      ["a.js", "// max-agents: 5\nconst cfg = { model: someVar };\n"],
    ]);
    const errors = validateWorkflowSurface(scripts, []);
    expect(
      errors.some(
        (e) => e.includes("statically auditable") && e.includes("R6"),
      ),
    ).toBe(true);
  });

  test("R7: flags a script missing the max-agents header", () => {
    const scripts = new Map([["a.js", "export const run = () => {};\n"]]);
    const rows = [
      {
        name: "a.js",
        file: "a.js",
        label: null,
        model: "sonnet",
        effort: "n/a",
      },
    ];
    const errors = validateWorkflowSurface(scripts, rows);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/max-agents/);
    expect(errors[0]).toMatch(/R7/);
  });

  test("R7: flags a max-agents value above the guardrail ceiling", () => {
    const scripts = new Map([
      ["a.js", "// max-agents: 26\nexport const run = () => {};\n"],
    ]);
    const rows = [
      {
        name: "a.js",
        file: "a.js",
        label: null,
        model: "sonnet",
        effort: "n/a",
      },
    ];
    const errors = validateWorkflowSurface(scripts, rows);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/26/);
    expect(errors[0]).toMatch(/R7/);
  });

  test("R7: flags a max-agents value of zero", () => {
    const scripts = new Map([
      ["a.js", "// max-agents: 0\nexport const run = () => {};\n"],
    ]);
    const rows = [
      {
        name: "a.js",
        file: "a.js",
        label: null,
        model: "sonnet",
        effort: "n/a",
      },
    ];
    const errors = validateWorkflowSurface(scripts, rows);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/max-agents: 0/);
    expect(errors[0]).toMatch(/R7/);
  });

  test("passes a fully compliant script and matrix with an empty error array", () => {
    const scripts = new Map([
      [
        "workflow.js",
        '// max-agents: 20\nconst cfg = { model: "sonnet", effort: "medium" };\nrunStep("verify");\n',
      ],
    ]);
    const rows = [
      {
        name: "workflow.js",
        file: "workflow.js",
        label: null,
        model: "inherit",
        effort: "n/a",
      },
      {
        name: "workflow.js:verify",
        file: "workflow.js",
        label: "verify",
        model: "sonnet",
        effort: "medium",
      },
    ];
    expect(validateWorkflowSurface(scripts, rows)).toEqual([]);
  });

  test("passes an empty surface (no scripts, no rows) with an empty error array", () => {
    expect(validateWorkflowSurface(new Map<string, string>(), [])).toEqual([]);
  });
});

describe("check-agents.mjs §5 row-regex boundary", () => {
  // Copied verbatim from bin/check-agents.mjs §5 (~L244-245) — the
  // `(agent|workflow)` row regex must never match a `workflow-script` row,
  // or check-agents.mjs would double-parse rows this module owns.
  const rowRe =
    /^\|\s*(agent|workflow)\s*\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|/gm;

  test("does not match a workflow-script matrix row", () => {
    const line = "| workflow-script | `x.js` | `sonnet` | `high` |";
    expect(rowRe.test(line)).toBe(false);
  });
});
