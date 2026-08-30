/**
 * Tests for `src/command.ts`'s module-evaluation-time manifest read
 * (`scriptDescription()`), split out of `tests/command.test.ts` on purpose:
 * that file reads the REAL, committed `package.json` unmocked as a drift guard
 * (`.claude/rules/tests.md` — "when the subject IS a committed artifact, read
 * the real filesystem unmocked"), so it must never mock `node:fs`. This file
 * owns the failure paths, which can only be reached with a mocked read.
 *
 * Contract under test (PR #769 finding 1). `scriptDescription()` runs at module
 * evaluation, i.e. BEFORE `Core.runScript` installs its process guards, so a
 * raw `Error`/`SyntaxError` escaping from it never reaches a run report and
 * never maps to a documented exit code. Every failure mode must therefore
 * surface as `M3LAgentOperatorCliError` coded `ERR_AGENT_OPERATOR_CONFIG`:
 *
 * - the read itself fails (ENOENT, EACCES, ...) — `cause` chained to it;
 * - the bytes are not JSON — `cause` chained to the `SyntaxError`;
 * - the parse result is not an object (`null`, an array, a scalar);
 * - `description` is missing, blank, or not a string. The current
 *   `as { readonly description: string }` cast asserts a field it never
 *   checks, so a manifest without one yields `description: undefined` typed
 *   as `string` and a host renders `undefined` in its help output.
 */

import type * as NodeFs from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import type * as AgentOperatorErrors from "../src/lib/errors.js";

/**
 * The `node:fs` mock's backing function, hoisted so it survives
 * `vi.resetModules()`: resetting the registry re-runs the factory below, and a
 * plain module-scope `const` would both be initialised too late for the
 * hoisted `vi.mock` call and hand out a fresh function on every re-run,
 * silently detaching the per-test `mockReturnValue`/`mockImplementation`.
 */
const readFileSyncMock = vi.hoisted(() =>
  vi.fn<(path: unknown, encoding?: unknown) => string>(),
);

/**
 * The async-factory form that preserves every real export
 * (`.claude/rules/tests.md`), replacing only `readFileSync` — `command.ts`
 * imports that one named binding, and the rest of `node:fs` must keep working
 * for anything else in the import graph.
 */
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  return { ...actual, readFileSync: readFileSyncMock };
});

/** The `src/lib/errors.js` module shape, for typing a per-generation import. */
type AgentOperatorErrorsModule = typeof AgentOperatorErrors;

/** The outcome of one fresh evaluation of `src/command.ts`. */
interface CommandModuleLoad {
  /** Whatever module evaluation threw, or `undefined` when it succeeded. */
  readonly thrown: unknown;
  /** The descriptor's `description`, or `undefined` when evaluation threw. */
  readonly description: string | undefined;
  /**
   * The `M3LAgentOperatorCliError` class from the SAME module generation the
   * loaded `command.ts` used. `vi.resetModules()` rebuilds the whole graph, so
   * the statically-imported class object is a different identity and
   * `instanceof` against it would fail for reasons that have nothing to do
   * with the behaviour under test.
   */
  readonly cliError: AgentOperatorErrorsModule["M3LAgentOperatorCliError"];
}

/**
 * Re-evaluates `src/command.ts` from a clean module registry — the only way to
 * observe `scriptDescription()`, which runs once when the `commandModule`
 * object literal is built.
 *
 * @param manifestBytes - What the mocked `readFileSync` returns for
 *   `package.json`. Omit to leave a caller-installed `mockImplementation`
 *   (e.g. one that throws) in place.
 */
async function loadCommandModule(
  manifestBytes?: string,
): Promise<CommandModuleLoad> {
  if (manifestBytes !== undefined) {
    readFileSyncMock.mockReturnValue(manifestBytes);
  }
  vi.resetModules();
  const errors: AgentOperatorErrorsModule =
    await import("../src/lib/errors.js");
  const cliError = errors.M3LAgentOperatorCliError;
  try {
    const command = await import("../src/command.js");
    return {
      thrown: undefined,
      description: command.commandModule.description,
      cliError,
    };
  } catch (error) {
    return { thrown: error, description: undefined, cliError };
  }
}

afterEach(() => {
  // `vi.restoreAllMocks()` would NOT clear this one: it only undoes `vi.spyOn`
  // spies, never a plain `vi.fn()` created in a `vi.mock` factory, so a stale
  // `mockImplementation` would leak into the next test.
  readFileSyncMock.mockReset();
});

describe("agent-operator command descriptor — package.json read", () => {
  it("uses the manifest description when the manifest is well-formed", async () => {
    const load = await loadCommandModule(
      JSON.stringify({ description: "a valid one-line description" }),
    );

    expect(load.thrown).toBeUndefined();
    expect(load.description).toBe("a valid one-line description");
  });

  it("reads the description from this package's own package.json", async () => {
    await loadCommandModule(JSON.stringify({ description: "anything" }));

    const [path] = readFileSyncMock.mock.calls[0] ?? [];
    expect(String(path)).toContain("package.json");
  });

  // The read failure a raw `readFileSync` propagates verbatim today: an
  // ENOENT `Error` thrown out of module evaluation, before `Core.runScript`
  // exists to classify it.
  it("wraps a failed read in ERR_AGENT_OPERATOR_CONFIG, chaining the cause", async () => {
    const enoent = Object.assign(
      new Error("ENOENT: no such file or directory"),
      { code: "ENOENT" },
    );
    readFileSyncMock.mockImplementation(() => {
      throw enoent;
    });

    const load = await loadCommandModule();

    expect(load.thrown).toBeInstanceOf(load.cliError);
    const error = load.thrown as AgentOperatorErrors.M3LAgentOperatorCliError;
    expect(error.code).toBe("ERR_AGENT_OPERATOR_CONFIG");
    expect(error.cause).toBe(enoent);
  });

  it("chains the SyntaxError as the cause when the manifest is not JSON", async () => {
    const load = await loadCommandModule("not json at all");

    expect(load.thrown).toBeInstanceOf(load.cliError);
    const error = load.thrown as AgentOperatorErrors.M3LAgentOperatorCliError;
    expect(error.code).toBe("ERR_AGENT_OPERATOR_CONFIG");
    expect(error.cause).toBeInstanceOf(SyntaxError);
  });

  /**
   * Every manifest shape that must be rejected rather than silently yielding
   * `description: undefined` (or a non-string) typed as `string`. Table-driven
   * so a future manifest-shape rule joins the list instead of the assertions.
   */
  it.each([
    ["no description field at all", "{}"],
    ["an empty description", '{"description": ""}'],
    ["a whitespace-only description", '{"description": "   "}'],
    ["a numeric description", '{"description": 42}'],
    ["a null description", '{"description": null}'],
    ["a JSON array rather than an object", "[]"],
    ["a JSON null rather than an object", "null"],
    ["bytes that are not JSON at all", "not json at all"],
  ])("rejects a manifest with %s", async (_label, manifestBytes) => {
    const load = await loadCommandModule(manifestBytes);

    expect(load.thrown).toBeInstanceOf(load.cliError);
    expect(
      (load.thrown as AgentOperatorErrors.M3LAgentOperatorCliError).code,
    ).toBe("ERR_AGENT_OPERATOR_CONFIG");
  });

  // The specific defect the `as { readonly description: string }` cast hides:
  // the descriptor is BUILT, `description` is `undefined` at runtime while
  // typed `string`, and a host renders the literal text "undefined" in help
  // output instead of anything failing.
  it("never builds a descriptor whose description is not a non-blank string", async () => {
    const load = await loadCommandModule('{"name": "@m3l-automation/x"}');

    expect(load.description).toBeUndefined();
    expect(load.thrown).toBeInstanceOf(load.cliError);
  });
});
