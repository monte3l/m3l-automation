import { describe, expect, expectTypeOf, it } from "vitest";

import { M3LAgentOperatorCliError } from "../../src/lib/errors.js";
import {
  AGENT_OPERATOR_FLOW_NAME_RE,
  type AgentOperatorFlowName,
  assertAllowedFlowName,
} from "../../src/lib/flow-names.js";

/**
 * Contract: PR B1 slice 5 `src/lib/flow-names.ts`, mirroring
 * `src/lib/preset-names.ts` and `src/lib/cli-names.ts`. Unlike the preset-name
 * check, `assertAllowedFlowName` takes the operator-declared `allowlist`
 * directly (there is no separate `isAllowedFlowName` predicate layer in the
 * contract) and refuses in three ordered stages, all coded
 * `ERR_AGENT_OPERATOR_CONFIG`:
 *
 * 1. not a string / empty
 * 2. fails `AGENT_OPERATOR_FLOW_NAME_RE` (`/^[a-z0-9]+(?:-[a-z0-9]+)*$/`)
 * 3. not a member of `allowlist`
 *
 * The regex enforces a dash-separated slug: one or more lowercase
 * alphanumeric segments joined by single hyphens — no leading `-`, no
 * trailing `-`, no doubled `--`, no bare `-`. This is deliberately
 * STRICTER than the CLI's own `FLOW_NAME_RE` (see `src/lib/cli-names.ts`,
 * used by `m3l flow`), which would happily run a flow file literally named
 * `-weird-.yaml`. `assertAllowedFlowName` refuses that shape outright: the
 * name reaching it has already been read from model-supplied config, so
 * shape rejection here is written to be un-spoofable rather than merely
 * permissive-and-then-allowlisted — a flag-shaped or hyphen-edge name never
 * gets far enough to be judged against the allowlist at all.
 */

const ALLOWLIST = new Set(["sqs-roundtrip", "log-triage"]);

describe("AGENT_OPERATOR_FLOW_NAME_RE", () => {
  it("is the documented dash-separated-slug pattern", () => {
    expect(AGENT_OPERATOR_FLOW_NAME_RE.source).toBe(
      "^[a-z0-9]+(?:-[a-z0-9]+)*$",
    );
  });

  it.each([
    ["--dry-run", false],
    ["--json", false],
    ["-x", false],
    ["trailing-", false],
    ["a--b", false],
    ["dlq-reconcile", true],
    ["sqs-roundtrip", true],
  ] as const)("test(%j) is %s", (name, expected) => {
    expect(AGENT_OPERATOR_FLOW_NAME_RE.test(name)).toBe(expected);
  });
});

describe("assertAllowedFlowName", () => {
  it("mints and returns the same string value for a name in the allowlist", () => {
    expect(assertAllowedFlowName("sqs-roundtrip", ALLOWLIST)).toBe(
      "sqs-roundtrip",
    );
  });

  it("stage 1: refuses the empty string", () => {
    let thrown: unknown;
    try {
      assertAllowedFlowName("", ALLOWLIST);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
    const cliError = thrown as M3LAgentOperatorCliError;
    expect(cliError.code).toBe("ERR_AGENT_OPERATOR_CONFIG");
  });

  it("stage 1: refuses a non-string value arriving through a cast — the realistic path, since the value originates in model-supplied JSON", () => {
    // `JSON.parse(text) as SomeShape` typechecks with zero errors, so the
    // runtime call site is exactly this: an `unknown` decoded value handed to
    // `assertAllowedFlowName` through a `string`-typed parameter position via
    // an upstream cast, never a value TypeScript itself would accept here.
    const modelSuppliedNumber = 42 as unknown as string;
    let thrown: unknown;
    try {
      assertAllowedFlowName(modelSuppliedNumber, ALLOWLIST);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
    const cliError = thrown as M3LAgentOperatorCliError;
    expect(cliError.code).toBe("ERR_AGENT_OPERATOR_CONFIG");
  });

  describe("stage 2: shape refusals — each an individual attack on the positional argv slot", () => {
    it.each([
      [
        "--dry-run",
        "a leading `-` would let this be read as the dry-run flag rather than a name — the kebab-case rule is what makes the positional un-spoofable",
      ],
      [
        "--json",
        "a leading `-` would let this be read as the --json flag rather than a name",
      ],
      ["-x", "a single-dash flag-shaped token"],
      ["-", "a bare dash — no alphanumeric segment at all"],
      ["trailing-", "a trailing `-` with no following segment"],
      ["a--b", "a doubled hyphen — no segment between them"],
      ["a/b", "a path separator, outside the slug alphabet"],
      ["../escape", "a path-traversal attempt, outside the slug alphabet"],
      ["Upper", "uppercase, outside the slug alphabet"],
      ["has space", "an embedded space, outside the slug alphabet"],
    ] as const)("refuses %j (%s)", (name, _reason) => {
      // Confirm this fixture is actually refused by the REGEX (stage 2), not
      // coincidentally by allowlist membership (stage 3) — none of these
      // names is a member of ALLOWLIST either, so the discriminating check is
      // that the regex itself rejects the shape.
      expect(AGENT_OPERATOR_FLOW_NAME_RE.test(name)).toBe(false);

      let thrown: unknown;
      try {
        assertAllowedFlowName(name, ALLOWLIST);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
      const cliError = thrown as M3LAgentOperatorCliError;
      expect(cliError.code).toBe("ERR_AGENT_OPERATOR_CONFIG");
    });
  });

  it("stage 3: refuses a shape-valid name that is NOT a member of the allowlist — proves the guard is not shape-only", () => {
    const shapeValidButNotAllowed = "some-unlisted-flow";
    // Confirm the discriminating precondition: this name clears the regex
    // (stage 2) so any refusal below can only be attributed to stage 3, not
    // to shape. Both facts are asserted explicitly so this case cannot be
    // vacuous — without the first assertion, a shape-invalid fixture here
    // would still throw, but the throw would prove nothing about stage 3.
    expect(AGENT_OPERATOR_FLOW_NAME_RE.test(shapeValidButNotAllowed)).toBe(
      true,
    );
    expect(ALLOWLIST.has(shapeValidButNotAllowed)).toBe(false);

    let thrown: unknown;
    try {
      assertAllowedFlowName(shapeValidButNotAllowed, ALLOWLIST);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
    const cliError = thrown as M3LAgentOperatorCliError;
    expect(cliError.code).toBe("ERR_AGENT_OPERATOR_CONFIG");
  });

  describe("no rejection message may contain the rejected value", () => {
    it.each([
      ["--dry-run", "--dry-run"],
      ["--json", "--json"],
      ["-x", "-x"],
      ["- (bare dash)", "-"],
      ["trailing- (trailing hyphen, now shape-invalid)", "trailing-"],
      ["a--b (doubled hyphen)", "a--b"],
      ["a/b", "a/b"],
      ["../escape", "../escape"],
      ["Upper", "Upper"],
      ["has space", "has space"],
      [
        "some-unlisted-flow (shape-valid, not on allowlist)",
        "some-unlisted-flow",
      ],
    ] as const)("never echoes %s in the thrown message", (_label, name) => {
      let thrown: unknown;
      try {
        assertAllowedFlowName(name, ALLOWLIST);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
      const cliError = thrown as M3LAgentOperatorCliError;
      expect(cliError.message).not.toContain(name);
    });

    it("never echoes a non-string rejected value either", () => {
      let thrown: unknown;
      try {
        assertAllowedFlowName(
          { toString: () => "secret-marker" } as unknown as string,
          ALLOWLIST,
        );
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
      const cliError = thrown as M3LAgentOperatorCliError;
      expect(cliError.message).not.toContain("secret-marker");
    });
  });
});

describe("AgentOperatorFlowName — the brand is the contract", () => {
  it("does not accept a bare string where the branded type is required", () => {
    expectTypeOf<string>().not.toExtend<AgentOperatorFlowName>();
  });

  it("returns the branded type, and the returned value is assignable to it", () => {
    expectTypeOf(
      assertAllowedFlowName,
    ).returns.toEqualTypeOf<AgentOperatorFlowName>();
  });
});
