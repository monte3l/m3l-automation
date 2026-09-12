/**
 * Tests for `src/sessions/flow-yaml.ts` — `renderFlowYaml` (X13
 * session-flow-export domain module, issue #561, PR 4/6).
 *
 * RED: `../src/sessions/flow-yaml.ts` does not exist yet — every import below
 * is expected to fail to resolve until the implementer lands the module.
 *
 * The correctness rule under test: every scalar (every key AND every value)
 * is emitted via `JSON.stringify`, a valid YAML 1.2 double-quoted scalar for
 * any JavaScript string. Every scenario below proves this by a real
 * round-trip: render, write the result to a real file inside a per-test
 * `mkdtemp` sandbox (this repo's test-I/O policy — no `node:fs` mock here,
 * mirroring `packages/m3l-cli/tests/flow-load.test.ts`'s own real-file
 * pattern for `Core.M3LYAMLConfigProvider`), then parse it back through the
 * exact reader `packages/m3l-cli/src/flow/load.ts` uses in production.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import { renderFlowYaml } from "../src/sessions/flow-yaml.js";
import type {
  M3LFlowYamlDocument,
  M3LFlowYamlStep,
} from "../src/sessions/flow-yaml.js";

/** Temp roots created by this file, removed in `afterEach`. */
const createdRoots: string[] = [];

afterEach(() => {
  while (createdRoots.length > 0) {
    const root = createdRoots.pop();
    if (root !== undefined) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

/** Writes `content` to a fresh temp file inside a per-test mkdtemp sandbox. */
function writeTempYaml(content: string): string {
  const root = mkdtempSync(join(tmpdir(), "m3l-flow-yaml-"));
  createdRoots.push(root);
  const filePath = join(root, "flow.yaml");
  writeFileSync(filePath, content, "utf8");
  return filePath;
}

/** The parsed-back shape `Core.M3LYAMLConfigProvider` reports for a rendered document. */
interface ParsedFlow {
  readonly name: unknown;
  readonly description: unknown;
  readonly steps: unknown;
}

/**
 * Renders `document`/`headerComments`, writes the result to a real temp
 * file, and parses it back through `Core.M3LYAMLConfigProvider` — the exact
 * reader `packages/m3l-cli/src/flow/load.ts` uses in production.
 */
function renderAndParseBack(
  document: M3LFlowYamlDocument,
  headerComments: readonly string[] = [],
): ParsedFlow {
  const rendered = renderFlowYaml(document, headerComments);
  const filePath = writeTempYaml(rendered);
  const provider = new Core.M3LYAMLConfigProvider(filePath);
  return {
    name: provider.getRawValue("name"),
    description: provider.getRawValue("description"),
    steps: provider.getRawValue("steps"),
  };
}

/** One ordinary, non-adversarial step fixture. */
function plainStep(overrides: Partial<M3LFlowYamlStep> = {}): M3LFlowYamlStep {
  return {
    id: "step-1",
    script: "sqs-etl",
    parameters: { command: "dump" },
    onSuccess: "continue",
    onFailure: "stop",
    ...overrides,
  };
}

describe("renderFlowYaml — happy path round-trip", () => {
  test("a document with one step round-trips name/description/steps exactly", () => {
    const document: M3LFlowYamlDocument = {
      name: "dlq-reconcile",
      description: "Drain a DLQ, reshape, land.",
      steps: [plainStep()],
    };

    const parsed = renderAndParseBack(document);

    expect(parsed.name).toBe("dlq-reconcile");
    expect(parsed.description).toBe("Drain a DLQ, reshape, land.");
    expect(parsed.steps).toEqual([
      {
        id: "step-1",
        script: "sqs-etl",
        parameters: { command: "dump" },
        onSuccess: "continue",
        onFailure: "stop",
      },
    ]);
  });

  test("a document with two steps round-trips both, in order", () => {
    const document: M3LFlowYamlDocument = {
      name: "two-step",
      steps: [
        plainStep({ id: "step-1", script: "sqs-etl" }),
        plainStep({
          id: "step-2",
          script: "json-etl",
          parameters: { input: "a", output: "b" },
        }),
      ],
    };

    const parsed = renderAndParseBack(document);
    const steps = parsed.steps as readonly { readonly id: string }[];

    expect(steps).toHaveLength(2);
    expect(steps[0]?.id).toBe("step-1");
    expect(steps[1]?.id).toBe("step-2");
  });

  test("omits the description key entirely when the document has none", () => {
    const document: M3LFlowYamlDocument = {
      name: "no-description",
      steps: [plainStep()],
    };

    const parsed = renderAndParseBack(document);

    expect(parsed.name).toBe("no-description");
    expect(parsed.description).toBeUndefined();
  });
});

describe("renderFlowYaml — adversarial scalar values round-trip via JSON.stringify quoting", () => {
  test.each<[string, string]>([
    [
      "a hash that would start a YAML comment unquoted",
      "value # not a comment",
    ],
    ["a colon-space sequence that would end a mapping key unquoted", "a: b"],
    ["an embedded newline", "line one\nline two"],
    ["leading and trailing whitespace", "  padded value  "],
    ["a double quote and a backslash", 'has "quotes" and \\backslash'],
    ["a leading asterisk (YAML alias sigil)", "*not-an-alias"],
    ["a leading percent sign (YAML directive sigil)", "%not-a-directive"],
  ])("round-trips a parameter VALUE containing %s", (_label, value) => {
    const document: M3LFlowYamlDocument = {
      name: "adversarial-value",
      steps: [plainStep({ parameters: { payload: value } })],
    };

    const parsed = renderAndParseBack(document);
    const steps = parsed.steps as readonly {
      readonly parameters: Readonly<Record<string, unknown>>;
    }[];

    expect(steps[0]?.parameters["payload"]).toBe(value);
  });

  test("round-trips a parameter KEY containing hazardous characters, not just a value", () => {
    const hazardousKey = 'weird: key # "with" *sigils';
    const document: M3LFlowYamlDocument = {
      name: "adversarial-key",
      steps: [plainStep({ parameters: { [hazardousKey]: "value" } })],
    };

    const parsed = renderAndParseBack(document);
    const steps = parsed.steps as readonly {
      readonly parameters: Readonly<Record<string, unknown>>;
    }[];

    expect(steps[0]?.parameters[hazardousKey]).toBe("value");
  });
});

describe("renderFlowYaml — headerComments", () => {
  test("prefixes each header comment with '# ', in order, preceding the document", () => {
    const document: M3LFlowYamlDocument = {
      name: "with-header",
      steps: [plainStep()],
    };

    const rendered = renderFlowYaml(document, [
      "Generated by X13 session-flow-export",
      "session abc-123",
    ]);
    const lines = rendered.split("\n");

    expect(lines[0]).toBe("# Generated by X13 session-flow-export");
    expect(lines[1]).toBe("# session abc-123");
  });

  test("a header-commented document still round-trips (comments don't corrupt the document)", () => {
    const document: M3LFlowYamlDocument = {
      name: "with-header-roundtrip",
      steps: [plainStep()],
    };

    const rendered = renderFlowYaml(document, ["a plain header comment"]);
    const filePath = writeTempYaml(rendered);
    const provider = new Core.M3LYAMLConfigProvider(filePath);

    expect(provider.getRawValue("name")).toBe("with-header-roundtrip");
  });

  test("splitting the header block by newlines yields exactly one line per headerComments entry, each starting with '# ' — an embedded newline cannot inject a second, un-prefixed line", () => {
    const entries = [
      "safe leading comment",
      "line one\nFAKE_KEY: injected-via-newline",
      "safe trailing comment",
    ];
    const document: M3LFlowYamlDocument = {
      name: "header-injection-guard",
      steps: [plainStep()],
    };

    const rendered = renderFlowYaml(document, entries);
    const lines = rendered.split("\n");

    // Collect the contiguous run of '#'-prefixed lines from the top: if the
    // embedded '\n' in the second entry were NOT stripped/neutralized, it
    // would end that comment early and let "FAKE_KEY: injected-via-newline"
    // appear as its own, un-prefixed line — breaking this contiguous run
    // short of `entries.length`.
    const headerBlock: string[] = [];
    for (const line of lines) {
      if (line.startsWith("# ")) {
        headerBlock.push(line);
      } else {
        break;
      }
    }

    expect(headerBlock).toHaveLength(entries.length);
    for (const line of headerBlock) {
      expect(line.startsWith("# ")).toBe(true);
      expect(line).not.toContain("\n");
    }
  });

  test("an empty headerComments array renders no header lines", () => {
    const document: M3LFlowYamlDocument = {
      name: "no-header",
      steps: [plainStep()],
    };

    const rendered = renderFlowYaml(document, []);

    expect(rendered.startsWith("#")).toBe(false);
  });
});
