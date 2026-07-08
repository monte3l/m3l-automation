import { describe, expect, test } from "vitest";
import {
  diffCadence,
  extractRunTokens,
  normalizeToken,
  parseCadenceTable,
  parseLefthookStages,
} from "../../bin/check-cadence-doc.mjs";

describe("normalizeToken", () => {
  test("strips a pnpm prefix", () => {
    expect(normalizeToken("pnpm format:check")).toBe("format:check");
  });

  test("strips a pnpm exec prefix and trailing flags", () => {
    expect(normalizeToken("pnpm exec eslint --fix {staged_files}")).toBe(
      "eslint",
    );
  });

  test("strips a node bin/ wrapper and the .mjs suffix", () => {
    expect(normalizeToken("node bin/lint-commit.mjs --edit {1}")).toBe(
      "lint-commit",
    );
  });

  test("leaves a bare script token unchanged", () => {
    expect(normalizeToken("verify-signed-range")).toBe("verify-signed-range");
  });
});

describe("extractRunTokens", () => {
  test("pulls every pnpm script from a chained pre-push command", () => {
    const run =
      "pnpm format:check && pnpm lint && pnpm typecheck && pnpm test:coverage";
    expect(extractRunTokens(run)).toEqual(
      new Set(["format:check", "lint", "typecheck", "test:coverage"]),
    );
  });

  test("pulls a pnpm exec tool and a bin script", () => {
    expect(extractRunTokens("pnpm exec eslint --fix {staged_files}")).toEqual(
      new Set(["eslint"]),
    );
    expect(extractRunTokens("node bin/verify-signed-range.mjs")).toEqual(
      new Set(["verify-signed-range"]),
    );
  });
});

describe("parseLefthookStages", () => {
  const yaml = [
    "pre-commit:",
    "  parallel: true",
    "  commands:",
    "    lint:",
    "      run: pnpm exec eslint --fix {staged_files}",
    "    format:",
    "      run: pnpm exec prettier --write {staged_files}",
    "",
    "commit-msg:",
    "  commands:",
    "    commitlint:",
    "      run: node bin/lint-commit.mjs --edit {1}",
    "",
    "pre-push:",
    "  commands:",
    "    verify:",
    "      run: pnpm format:check && pnpm lint && pnpm typecheck && pnpm test:coverage",
    "    verify-signatures:",
    "      run: node bin/verify-signed-range.mjs",
    "",
  ].join("\n");

  test("groups check tokens under each tracked stage", () => {
    const stages = parseLefthookStages(yaml);
    expect(stages.get("pre-commit")).toEqual(new Set(["eslint", "prettier"]));
    expect(stages.get("commit-msg")).toEqual(new Set(["lint-commit"]));
    expect(stages.get("pre-push")).toEqual(
      new Set([
        "format:check",
        "lint",
        "typecheck",
        "test:coverage",
        "verify-signed-range",
      ]),
    );
  });

  test("ignores untracked top-level stages", () => {
    const withExtra = `${yaml}\npost-checkout:\n  commands:\n    x:\n      run: pnpm nope\n`;
    const stages = parseLefthookStages(withExtra);
    expect(stages.has("post-checkout")).toBe(false);
  });
});

describe("parseCadenceTable", () => {
  const claudeMd = [
    "## Commands",
    "",
    "| Stage | Checks run | Scope |",
    "| ----- | ---------- | ----- |",
    "| `pre-commit` (lefthook) | `eslint --fix`, `prettier --write` | staged |",
    "| `commit-msg` (lefthook) | `lint-commit` | message |",
    "| `pre-push` (lefthook) | `pnpm lint`, `verify-signed-range` | repo |",
    "| CI `verify` job (`ci.yml`) | every `check:*`, `pnpm build` | repo |",
    "",
    "## CI/CD",
    "",
  ].join("\n");

  test("reads only the lefthook rows, skipping the CI row", () => {
    const stages = parseCadenceTable(claudeMd);
    expect(stages.get("pre-commit")).toEqual(new Set(["eslint", "prettier"]));
    expect(stages.get("pre-push")).toEqual(
      new Set(["lint", "verify-signed-range"]),
    );
    // The CI row's `check:*` / `pnpm build` tokens must not leak into any stage.
    for (const set of stages.values()) {
      expect(set.has("build")).toBe(false);
    }
  });

  test("throws when the Commands section is absent", () => {
    expect(() => parseCadenceTable("# no commands here")).toThrow(
      /## Commands/,
    );
  });
});

describe("diffCadence", () => {
  const hook = new Map([
    ["pre-commit", new Set(["eslint", "prettier"])],
    ["commit-msg", new Set(["lint-commit"])],
    ["pre-push", new Set(["lint", "verify-signed-range"])],
  ]);

  test("no drift when the doc matches the hook", () => {
    expect(diffCadence(hook, new Map(hook))).toEqual([]);
  });

  test("flags a check the hook runs but the doc omits", () => {
    const doc = new Map(hook);
    doc.set("pre-push", new Set(["verify-signed-range"])); // dropped `lint`
    const errors = diffCadence(hook, doc);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/pre-push.*lint.*omits it/);
  });

  test("flags a check the doc lists but the hook does not run", () => {
    const doc = new Map(hook);
    doc.set("pre-push", new Set(["lint", "verify-signed-range", "build"]));
    const errors = diffCadence(hook, doc);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/pre-push.*build.*does not run it/);
  });

  test("flags a missing doc row for a stage", () => {
    const doc = new Map(hook);
    doc.delete("commit-msg");
    const errors = diffCadence(hook, doc);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/commit-msg.*row/);
  });
});
