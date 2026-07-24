/**
 * Tests for core/prompt submodule.
 *
 * Contract source: docs/reference/core/prompt.md
 * Exports: M3LPrompt, M3LMultiSpinner, M3LLoadingBar, M3LPromptValidationError,
 *   confirmDestructive, and types M3LMultiSpinnerOptions, M3LLoadingBarOptions,
 *   M3LPromptOptions, M3LPromptAdapter, M3LChoice, M3LChoices,
 *   M3LNumberPromptOptions, M3LSuggestFn, M3LConfirmDestructiveOptions
 *   (14 symbols total).
 *
 * Key behavioral contracts under test:
 *  - confirmDestructive: promoted from an identical script-local step
 *    duplicated across 5 consumer scripts (see e.g.
 *    scripts/lambda-ops/src/steps/destructive-gate.ts). Bypass (`yes:true`)
 *    logs a warning and never calls `prompt.confirm`; a decline throws
 *    `M3LError` with the caller-supplied `code` (not a hardcoded literal); an
 *    adapter rejection propagates unchanged, never converted to the
 *    `aborted` error.
 *  - B1/D-env: mode selection — live-ANSI iff M3LExecutionEnvironment.isInteractive()
 *    AND stream.isTTY; the `interactive` option overrides auto-detection.
 *  - B2: plain-mode output contains no ANSI escapes.
 *  - B3/D7: number() re-validates min/max inside M3LPrompt regardless of the
 *    adapter, guarding Number.isFinite (NaN is not finite).
 *  - B4: LoadingBar.update clamps percentage to [0,100] and renders the right
 *    fill counts.
 *  - B5: numeric guards — LoadingBar width<=0 and number min>max both throw
 *    M3LPromptValidationError.
 *  - B6: password value never leaks into streams/errors.
 *  - B7/D10: adapter rejections propagate, not swallowed.
 *  - B8/D11: multi-spinner id isolation; unknown-id terminal call is a no-op.
 *  - B8-single/D5: single-spinner methods are callable and don't throw when
 *    interleaved with multi-spinner calls.
 *  - B10: no import-time or construction-time side effects.
 *  - D3: autocomplete suggest fn signature is (term) => ... (no signal arg).
 *  - D8: LoadingBar.update(NaN)/update(Infinity) clamp to 0, don't throw.
 */

import { PassThrough } from "node:stream";

import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

// Hoisted mock fns for @inquirer/prompts so createInquirerAdapter (a thin
// pass-through) can be tested without touching a real terminal. vi.hoisted
// makes these available inside the vi.mock factory below, which itself is
// hoisted above the imports by Vitest's transform.
const inquirerMocks = vi.hoisted(() => ({
  input: vi.fn(),
  password: vi.fn(),
  number: vi.fn(),
  confirm: vi.fn(),
  select: vi.fn(),
  checkbox: vi.fn(),
  search: vi.fn(),
}));

vi.mock("@inquirer/prompts", () => inquirerMocks);

import { M3LError } from "../src/core/errors/index.js";
import { M3LLogger } from "../src/core/logging/index.js";
import {
  confirmDestructive,
  M3LLoadingBar,
  M3LMultiSpinner,
  M3LPrompt,
  M3LPromptValidationError,
} from "../src/core/prompt/index.js";
import { createInquirerAdapter } from "../src/internal/prompt/inquirerAdapter.js";
import {
  resolveInteractive,
  resolveRenderTarget,
} from "../src/internal/prompt/ansi.js";

import type {
  M3LChoice,
  M3LChoices,
  M3LLoadingBarOptions,
  M3LMultiSpinnerOptions,
  M3LNumberPromptOptions,
  M3LPromptAdapter,
  M3LPromptOptions,
  M3LSuggestFn,
} from "../src/core/prompt/index.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Strips a captured writable stream's chunks into a single string. */
function makeCaptureStream(): {
  stream: PassThrough;
  output: () => string;
} {
  const chunks: string[] = [];
  const stream = new PassThrough();
  // Intercept writes without letting them reach a real sink.
  vi.spyOn(stream, "write").mockImplementation(
    (chunk: unknown, ...rest: unknown[]) => {
      chunks.push(typeof chunk === "string" ? chunk : String(chunk));
      // Preserve real EventEmitter/Writable semantics for callers awaiting drain.
      const cb = rest.find((r) => typeof r === "function") as
        (() => void) | undefined;
      cb?.();
      return true;
    },
  );
  return {
    stream,
    output: () => chunks.join(""),
  };
}

/**
 * Builds a mock `M3LPromptAdapter` as an object of `vi.fn()`s.
 *
 * The return type is intentionally left to inference (not annotated as
 * `M3LPromptAdapter`): several adapter methods (`select`, `checkbox`,
 * `search`) are generic over `Value`, and a non-generic `vi.fn()` mock is not
 * a valid override of a generic method signature under an explicit
 * interface/annotation. Left inferred, each property is a `Mock` — callers
 * still get `.mockResolvedValue`/`.mockRejectedValue`/etc. — and the whole
 * object structurally satisfies `M3LPromptAdapter` when passed to
 * `new M3LPrompt({ adapter })` because untyped mock functions are assignable
 * to any call signature, generic or not.
 */
function makeMockAdapter() {
  return {
    input: vi.fn(),
    password: vi.fn(),
    number: vi.fn(),
    confirm: vi.fn(),
    select: vi.fn(),
    checkbox: vi.fn(),
    search: vi.fn(),
  };
}

// ANSI CSI escape, built via fromCharCode to avoid a bare control character in
// a regex literal (no-control-regex).
const ESC = String.fromCharCode(0x1b);
const NO_ANSI = new RegExp(`^[^${ESC}]*$`, "u");

// ---------------------------------------------------------------------------
// M3LPromptValidationError
// ---------------------------------------------------------------------------
describe("M3LPromptValidationError", () => {
  test("is an instance of M3LError", () => {
    const error = new M3LPromptValidationError("out of range");
    expect(error).toBeInstanceOf(M3LError);
  });

  test("code is the narrow literal ERR_PROMPT_VALIDATION", () => {
    const error = new M3LPromptValidationError("out of range");
    expect(error.code).toBe("ERR_PROMPT_VALIDATION");
  });

  test("carries value/min/max in context for a number range violation", () => {
    const error = new M3LPromptValidationError("value out of range", {
      context: { value: 42, min: 0, max: 10 },
    });
    expect(error.context).toEqual({ value: 42, min: 0, max: 10 });
  });

  test("chains an underlying cause when provided", () => {
    const cause = new TypeError("root cause");
    const error = new M3LPromptValidationError("bad width", { cause });
    expect(error.cause).toBe(cause);
  });

  test("toJSON() (inherited) includes name, message, and code", () => {
    const error = new M3LPromptValidationError("bad width");
    const json = error.toJSON();
    expect(json.name).toBe("M3LPromptValidationError");
    expect(json.message).toBe("bad width");
    expect(json.code).toBe("ERR_PROMPT_VALIDATION");
  });

  describe("type-level contract", () => {
    test("code narrows to the literal 'ERR_PROMPT_VALIDATION'", () => {
      expectTypeOf<
        M3LPromptValidationError["code"]
      >().toEqualTypeOf<"ERR_PROMPT_VALIDATION">();
    });

    test("is assignable to M3LError", () => {
      expectTypeOf<M3LPromptValidationError>().toMatchTypeOf<M3LError>();
    });
  });
});

// ---------------------------------------------------------------------------
// M3LLoadingBar
// ---------------------------------------------------------------------------
describe("M3LLoadingBar", () => {
  test("update(50) renders half complete/incomplete fill counts summing to width", () => {
    const { stream, output } = makeCaptureStream();
    const bar = new M3LLoadingBar({
      width: 10,
      completeChar: "#",
      incompleteChar: "-",
      stream,
      interactive: false,
    });
    bar.update(50, "Halfway");
    const rendered = output();
    const completeCount = (rendered.match(/#/g) ?? []).length;
    const incompleteCount = (rendered.match(/-/g) ?? []).length;
    expect(completeCount + incompleteCount).toBe(10);
    expect(completeCount).toBe(5);
    expect(rendered).toContain("Halfway");
  });

  test.each([
    [0, 0, 10],
    [100, 10, 0],
  ])(
    "update(%i) renders %i complete and %i incomplete cells (boundary)",
    (pct, expectedComplete, expectedIncomplete) => {
      const { stream, output } = makeCaptureStream();
      const bar = new M3LLoadingBar({
        width: 10,
        completeChar: "#",
        incompleteChar: "-",
        stream,
        interactive: false,
      });
      bar.update(pct);
      const rendered = output();
      const completeCount = (rendered.match(/#/g) ?? []).length;
      const incompleteCount = (rendered.match(/-/g) ?? []).length;
      expect(completeCount).toBe(expectedComplete);
      expect(incompleteCount).toBe(expectedIncomplete);
    },
  );

  test("clamps a negative percentage to 0%", () => {
    const { stream, output } = makeCaptureStream();
    const bar = new M3LLoadingBar({
      width: 10,
      completeChar: "#",
      incompleteChar: "-",
      stream,
      interactive: false,
    });
    bar.update(-10);
    const rendered = output();
    expect((rendered.match(/#/g) ?? []).length).toBe(0);
    expect((rendered.match(/-/g) ?? []).length).toBe(10);
  });

  test("clamps a percentage above 100 to 100%", () => {
    const { stream, output } = makeCaptureStream();
    const bar = new M3LLoadingBar({
      width: 10,
      completeChar: "#",
      incompleteChar: "-",
      stream,
      interactive: false,
    });
    bar.update(150);
    const rendered = output();
    expect((rendered.match(/#/g) ?? []).length).toBe(10);
    expect((rendered.match(/-/g) ?? []).length).toBe(0);
  });

  test("D8: update(NaN) clamps to 0% instead of throwing", () => {
    const { stream, output } = makeCaptureStream();
    const bar = new M3LLoadingBar({
      width: 10,
      completeChar: "#",
      incompleteChar: "-",
      stream,
      interactive: false,
    });
    expect(() => {
      bar.update(Number.NaN);
    }).not.toThrow();
    const rendered = output();
    expect((rendered.match(/#/g) ?? []).length).toBe(0);
  });

  test("D8: update(Infinity) clamps to 0% instead of throwing", () => {
    const { stream, output } = makeCaptureStream();
    const bar = new M3LLoadingBar({
      width: 10,
      completeChar: "#",
      incompleteChar: "-",
      stream,
      interactive: false,
    });
    expect(() => {
      bar.update(Number.POSITIVE_INFINITY);
    }).not.toThrow();
    const rendered = output();
    expect((rendered.match(/#/g) ?? []).length).toBe(0);
  });

  test("B5: throws M3LPromptValidationError when constructed with width <= 0", () => {
    expect(() => new M3LLoadingBar({ width: 0 })).toThrowError(
      M3LPromptValidationError,
    );
    expect(() => new M3LLoadingBar({ width: -5 })).toThrowError(
      M3LPromptValidationError,
    );
  });

  test("B5: throws M3LPromptValidationError for a non-finite width (NaN / Infinity)", () => {
    // NaN <= 0 is false and Infinity <= 0 is false, so a bare `<= 0` guard would
    // store them: NaN renders an invisible bar, Infinity throws RangeError from
    // String.prototype.repeat in update(). Both must be rejected at construction.
    expect(() => new M3LLoadingBar({ width: Number.NaN })).toThrowError(
      M3LPromptValidationError,
    );
    expect(
      () => new M3LLoadingBar({ width: Number.POSITIVE_INFINITY }),
    ).toThrowError(M3LPromptValidationError);
  });

  test("B2: plain-mode output contains no ANSI escape sequences", () => {
    const { stream, output } = makeCaptureStream();
    const bar = new M3LLoadingBar({ stream, interactive: false });
    bar.update(50, "Halfway");
    expect(output()).toMatch(NO_ANSI);
  });

  test("B10: construction alone writes nothing to the injected stream", () => {
    const { stream, output } = makeCaptureStream();
    const bar = new M3LLoadingBar({ stream, interactive: false });
    expect(bar).toBeInstanceOf(M3LLoadingBar);
    expect(output()).toBe("");
  });
});

// ---------------------------------------------------------------------------
// M3LMultiSpinner
// ---------------------------------------------------------------------------
describe("M3LMultiSpinner", () => {
  test("B2: plain-mode spin/spinSucceed output contains no ANSI escape sequences", () => {
    const { stream, output } = makeCaptureStream();
    const spinner = new M3LMultiSpinner({ stream, interactive: false });
    spinner.spin("upload", "Uploading…");
    spinner.spinSucceed("upload", "Uploaded");
    expect(output()).toMatch(NO_ANSI);
  });

  test("B8/D11: spinFail on one id does not affect another concurrent id", () => {
    const { stream, output } = makeCaptureStream();
    const spinner = new M3LMultiSpinner({ stream, interactive: false });
    spinner.spin("upload", "Uploading…");
    spinner.spin("index", "Indexing…");
    spinner.spinFail("index", "Index failed");
    const rendered = output();
    expect(rendered).toContain("Index failed");
    expect(rendered).not.toContain("Upload failed");
  });

  test("B8/D11: terminal call on an unknown id is a no-op, not a throw", () => {
    const { stream } = makeCaptureStream();
    const spinner = new M3LMultiSpinner({ stream, interactive: false });
    expect(() => {
      spinner.spinSucceed("nonexistent-id", "done");
    }).not.toThrow();
    expect(() => {
      spinner.spinFail("nonexistent-id", "failed");
    }).not.toThrow();
    expect(() => {
      spinner.spinWarn("nonexistent-id", "warned");
    }).not.toThrow();
  });

  test("B8-single/D5: single-spinner methods are callable and interleave with multi calls without throwing", () => {
    const { stream } = makeCaptureStream();
    const spinner = new M3LMultiSpinner({ stream, interactive: false });
    expect(() => {
      spinner.startSpinner("Working…");
      spinner.spin("task-a", "Task A running");
      spinner.updateSpinner("Still working…");
      spinner.spinSucceed("task-a", "Task A done");
      spinner.spinnerStop("Done");
    }).not.toThrow();
  });

  test("B8-single/D5: spinnerFail is callable and does not throw", () => {
    const { stream } = makeCaptureStream();
    const spinner = new M3LMultiSpinner({ stream, interactive: false });
    expect(() => {
      spinner.startSpinner("Working…");
      spinner.spinnerFail("Failed");
    }).not.toThrow();
  });

  test("B10: construction alone writes nothing to the injected stream", () => {
    const { stream, output } = makeCaptureStream();
    const spinner = new M3LMultiSpinner({ stream, interactive: false });
    expect(spinner).toBeInstanceOf(M3LMultiSpinner);
    expect(output()).toBe("");
  });

  test("B1: interactive:false with a non-TTY stream forces plain-text mode regardless of environment", () => {
    const { stream, output } = makeCaptureStream();
    const spinner = new M3LMultiSpinner({ stream, interactive: false });
    spinner.spin("task", "Running");
    expect(output()).toMatch(NO_ANSI);
  });
});

// ---------------------------------------------------------------------------
// M3LPrompt — construction and composition
// ---------------------------------------------------------------------------
describe("M3LPrompt construction", () => {
  test("zero-arg construction succeeds and exposes spinner + loadingBar", () => {
    const prompt = new M3LPrompt();
    expect(prompt.spinner).toBeInstanceOf(M3LMultiSpinner);
    expect(prompt.loadingBar).toBeInstanceOf(M3LLoadingBar);
  });

  test("B10: construction alone performs no adapter calls", () => {
    const adapter = makeMockAdapter();
    const prompt = new M3LPrompt({ adapter });
    expect(prompt).toBeInstanceOf(M3LPrompt);
    expect(adapter.input).not.toHaveBeenCalled();
    expect(adapter.password).not.toHaveBeenCalled();
    expect(adapter.number).not.toHaveBeenCalled();
    expect(adapter.confirm).not.toHaveBeenCalled();
    expect(adapter.select).not.toHaveBeenCalled();
    expect(adapter.checkbox).not.toHaveBeenCalled();
    expect(adapter.search).not.toHaveBeenCalled();
  });

  test("accepts a pre-built M3LMultiSpinner instance for the spinner option", () => {
    const spinner = new M3LMultiSpinner({ interactive: false });
    const prompt = new M3LPrompt({ spinner });
    expect(prompt.spinner).toBe(spinner);
  });

  test("accepts a pre-built M3LLoadingBar instance for the loadingBar option", () => {
    const loadingBar = new M3LLoadingBar({ interactive: false });
    const prompt = new M3LPrompt({ loadingBar });
    expect(prompt.loadingBar).toBe(loadingBar);
  });
});

// ---------------------------------------------------------------------------
// M3LPrompt.text
// ---------------------------------------------------------------------------
describe("M3LPrompt.text", () => {
  test("resolves with the adapter's returned value (happy path)", async () => {
    const adapter = makeMockAdapter();
    adapter.input.mockResolvedValue("my-project");
    const prompt = new M3LPrompt({ adapter });
    await expect(prompt.text("Project name?")).resolves.toBe("my-project");
    expect(adapter.input).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Project name?" }),
    );
  });

  test("B7/D10: propagates an adapter rejection instead of swallowing it", async () => {
    const adapter = makeMockAdapter();
    const cancellation = new Error("User force closed the prompt");
    adapter.input.mockRejectedValue(cancellation);
    const prompt = new M3LPrompt({ adapter });
    await expect(prompt.text("Project name?")).rejects.toBe(cancellation);
  });

  test("passes through the default option to the adapter", async () => {
    const adapter = makeMockAdapter();
    adapter.input.mockResolvedValue("default-value");
    const prompt = new M3LPrompt({ adapter });
    await prompt.text("Project name?", { default: "default-value" });
    expect(adapter.input).toHaveBeenCalledWith(
      expect.objectContaining({ default: "default-value" }),
    );
  });
});

// ---------------------------------------------------------------------------
// Optional-`default`/`required` spread branches — the true-arm forwards the
// key; omitting `options` (or the field) must NOT forward a `default`/
// `required` key at all (under exactOptionalPropertyTypes, forwarding an
// explicit `undefined` is a distinct, rejected shape from omitting the key).
// ---------------------------------------------------------------------------
describe("M3LPrompt optional default/required forwarding", () => {
  test("number() forwards options.default to the adapter when provided", async () => {
    const adapter = makeMockAdapter();
    adapter.number.mockResolvedValue(5);
    const prompt = new M3LPrompt({ adapter });
    await prompt.number("Retries?", { min: 0, max: 10, default: 5 });
    expect(adapter.number).toHaveBeenCalledWith(
      expect.objectContaining({ default: 5 }),
    );
  });

  test("number() omits the default key entirely when not provided", async () => {
    const adapter = makeMockAdapter();
    adapter.number.mockResolvedValue(5);
    const prompt = new M3LPrompt({ adapter });
    await prompt.number("Retries?", { min: 0, max: 10 });
    const [config] = adapter.number.mock.calls[0] as [Record<string, unknown>];
    expect(config).not.toHaveProperty("default");
  });

  test("confirm() forwards options.default to the adapter when provided", async () => {
    const adapter = makeMockAdapter();
    adapter.confirm.mockResolvedValue(true);
    const prompt = new M3LPrompt({ adapter });
    await prompt.confirm("Continue?", { default: true });
    expect(adapter.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ default: true }),
    );
  });

  test("confirm() omits the default key entirely when no options are passed", async () => {
    const adapter = makeMockAdapter();
    adapter.confirm.mockResolvedValue(true);
    const prompt = new M3LPrompt({ adapter });
    await prompt.confirm("Continue?");
    const [config] = adapter.confirm.mock.calls[0] as [Record<string, unknown>];
    expect(config).not.toHaveProperty("default");
  });

  test("select() forwards options.default to the adapter when provided", async () => {
    const adapter = makeMockAdapter();
    adapter.select.mockResolvedValue("eu-south-1");
    const prompt = new M3LPrompt({ adapter });
    await prompt.select("Region?", ["eu-south-1", "us-east-1"], {
      default: "eu-south-1",
    });
    expect(adapter.select).toHaveBeenCalledWith(
      expect.objectContaining({ default: "eu-south-1" }),
    );
  });

  test("select() omits the default key entirely when no options are passed", async () => {
    const adapter = makeMockAdapter();
    adapter.select.mockResolvedValue("eu-south-1");
    const prompt = new M3LPrompt({ adapter });
    await prompt.select("Region?", ["eu-south-1", "us-east-1"]);
    const [config] = adapter.select.mock.calls[0] as [Record<string, unknown>];
    expect(config).not.toHaveProperty("default");
  });

  test("multiselect() forwards options.required to the adapter when provided", async () => {
    const adapter = makeMockAdapter();
    adapter.checkbox.mockResolvedValue(["dev"]);
    const prompt = new M3LPrompt({ adapter });
    await prompt.multiselect("Targets?", ["dev", "staging"], {
      required: true,
    });
    expect(adapter.checkbox).toHaveBeenCalledWith(
      expect.objectContaining({ required: true }),
    );
  });

  test("multiselect() omits the required key entirely when no options are passed", async () => {
    const adapter = makeMockAdapter();
    adapter.checkbox.mockResolvedValue(["dev"]);
    const prompt = new M3LPrompt({ adapter });
    await prompt.multiselect("Targets?", ["dev", "staging"]);
    const [config] = adapter.checkbox.mock.calls[0] as [
      Record<string, unknown>,
    ];
    expect(config).not.toHaveProperty("required");
  });

  test("autocomplete() forwards options.default to the adapter when provided", async () => {
    const adapter = makeMockAdapter();
    adapter.search.mockResolvedValue("eu-south-1");
    const suggest: M3LSuggestFn<string> = () => ["eu-south-1"];
    const prompt = new M3LPrompt({ adapter });
    await prompt.autocomplete("Region?", suggest, { default: "eu-south-1" });
    expect(adapter.search).toHaveBeenCalledWith(
      expect.objectContaining({ default: "eu-south-1" }),
    );
  });

  test("autocomplete() omits the default key entirely when no options are passed", async () => {
    const adapter = makeMockAdapter();
    adapter.search.mockResolvedValue("eu-south-1");
    const suggest: M3LSuggestFn<string> = () => ["eu-south-1"];
    const prompt = new M3LPrompt({ adapter });
    await prompt.autocomplete("Region?", suggest);
    const [config] = adapter.search.mock.calls[0] as [Record<string, unknown>];
    expect(config).not.toHaveProperty("default");
  });
});

// ---------------------------------------------------------------------------
// M3LPrompt.password — B6 secret-leak guard
// ---------------------------------------------------------------------------
describe("M3LPrompt.password", () => {
  const SECRET = "sekrit-token-9f3a";

  test("resolves with the adapter's returned secret (happy path)", async () => {
    const adapter = makeMockAdapter();
    adapter.password.mockResolvedValue(SECRET);
    const prompt = new M3LPrompt({ adapter });
    await expect(prompt.password("API token?")).resolves.toBe(SECRET);
  });

  test("B6: the secret is never written to the injected stream", async () => {
    const { stream, output } = makeCaptureStream();
    const adapter = makeMockAdapter();
    adapter.password.mockResolvedValue(SECRET);
    const prompt = new M3LPrompt({
      adapter,
      spinner: { stream, interactive: false },
      loadingBar: { stream, interactive: false },
    });
    await prompt.password("API token?");
    prompt.spinner.spin("task", "still going");
    prompt.loadingBar.update(50, "halfway");
    expect(output()).not.toContain(SECRET);
  });

  test("B7/D10: propagates an adapter rejection instead of swallowing it", async () => {
    const adapter = makeMockAdapter();
    const cancellation = new Error("User force closed the prompt");
    adapter.password.mockRejectedValue(cancellation);
    const prompt = new M3LPrompt({ adapter });
    await expect(prompt.password("API token?")).rejects.toBe(cancellation);
  });
});

// ---------------------------------------------------------------------------
// M3LPrompt.number — B3/D7 in-facade validation, B5 min>max guard
// ---------------------------------------------------------------------------
describe("M3LPrompt.number", () => {
  test("resolves with the value when within [min,max] (happy path)", async () => {
    const adapter = makeMockAdapter();
    adapter.number.mockResolvedValue(5);
    const prompt = new M3LPrompt({ adapter });
    await expect(prompt.number("Retries?", { min: 0, max: 10 })).resolves.toBe(
      5,
    );
  });

  test("B3/D7: re-validates the adapter's returned value even though the adapter received min/max", async () => {
    const adapter = makeMockAdapter();
    // Simulate an adapter that misbehaves and returns an out-of-range value.
    adapter.number.mockResolvedValue(999);
    const prompt = new M3LPrompt({ adapter });
    await expect(
      prompt.number("Retries?", { min: 0, max: 10 }),
    ).rejects.toThrowError(M3LPromptValidationError);
    expect(adapter.number).toHaveBeenCalledWith(
      expect.objectContaining({ min: 0, max: 10 }),
    );
  });

  test("B3/D7: throws M3LPromptValidationError with context {value,min,max} on out-of-range value", async () => {
    const adapter = makeMockAdapter();
    adapter.number.mockResolvedValue(999);
    const prompt = new M3LPrompt({ adapter });
    let thrown: unknown;
    try {
      await prompt.number("Retries?", { min: 0, max: 10 });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(M3LPromptValidationError);
    expect((thrown as M3LPromptValidationError).context).toEqual({
      value: 999,
      min: 0,
      max: 10,
    });
  });

  test("B3: guards Number.isFinite — a NaN resolved value throws M3LPromptValidationError", async () => {
    const adapter = makeMockAdapter();
    adapter.number.mockResolvedValue(Number.NaN);
    const prompt = new M3LPrompt({ adapter });
    await expect(
      prompt.number("Retries?", { min: 0, max: 10 }),
    ).rejects.toThrowError(M3LPromptValidationError);
  });

  test("B5: min>max throws M3LPromptValidationError at call time before invoking the adapter", async () => {
    const adapter = makeMockAdapter();
    const prompt = new M3LPrompt({ adapter });
    await expect(
      prompt.number("Retries?", { min: 10, max: 0 }),
    ).rejects.toThrowError(M3LPromptValidationError);
  });

  test("B7/D10: propagates an adapter rejection instead of swallowing it", async () => {
    const adapter = makeMockAdapter();
    const cancellation = new Error("User force closed the prompt");
    adapter.number.mockRejectedValue(cancellation);
    const prompt = new M3LPrompt({ adapter });
    await expect(prompt.number("Retries?", { min: 0, max: 10 })).rejects.toBe(
      cancellation,
    );
  });
});

// ---------------------------------------------------------------------------
// M3LPrompt.confirm
// ---------------------------------------------------------------------------
describe("M3LPrompt.confirm", () => {
  test("resolves with the adapter's boolean answer (happy path)", async () => {
    const adapter = makeMockAdapter();
    adapter.confirm.mockResolvedValue(true);
    const prompt = new M3LPrompt({ adapter });
    await expect(prompt.confirm("Continue?")).resolves.toBe(true);
  });

  test("B7/D10: propagates an adapter rejection instead of swallowing it", async () => {
    const adapter = makeMockAdapter();
    const cancellation = new Error("User force closed the prompt");
    adapter.confirm.mockRejectedValue(cancellation);
    const prompt = new M3LPrompt({ adapter });
    await expect(prompt.confirm("Continue?")).rejects.toBe(cancellation);
  });
});

// ---------------------------------------------------------------------------
// M3LPrompt.select / multiselect
// ---------------------------------------------------------------------------
describe("M3LPrompt.select", () => {
  test("resolves with the adapter's selected value from a plain string[] choices list", async () => {
    const adapter = makeMockAdapter();
    adapter.select.mockResolvedValue("eu-south-1");
    const prompt = new M3LPrompt({ adapter });
    await expect(
      prompt.select("Region?", ["eu-south-1", "us-east-1"]),
    ).resolves.toBe("eu-south-1");
  });

  test("resolves with the adapter's selected value from an M3LChoice[] object list", async () => {
    const adapter = makeMockAdapter();
    adapter.select.mockResolvedValue("eu-south-1");
    const prompt = new M3LPrompt({ adapter });
    const choices: M3LChoices<string> = [
      { name: "Europe (South)", value: "eu-south-1" },
      { name: "US East", value: "us-east-1" },
    ];
    await expect(prompt.select("Region?", choices)).resolves.toBe("eu-south-1");
  });

  test("B7/D10: propagates an adapter rejection instead of swallowing it", async () => {
    const adapter = makeMockAdapter();
    const cancellation = new Error("User force closed the prompt");
    adapter.select.mockRejectedValue(cancellation);
    const prompt = new M3LPrompt({ adapter });
    await expect(
      prompt.select("Region?", ["eu-south-1", "us-east-1"]),
    ).rejects.toBe(cancellation);
  });
});

describe("M3LPrompt.multiselect", () => {
  test("resolves with the adapter's selected values (happy path)", async () => {
    const adapter = makeMockAdapter();
    adapter.checkbox.mockResolvedValue(["dev", "staging"]);
    const prompt = new M3LPrompt({ adapter });
    await expect(
      prompt.multiselect("Targets?", ["dev", "staging", "prod"]),
    ).resolves.toEqual(["dev", "staging"]);
  });

  test("B7/D10: propagates an adapter rejection instead of swallowing it", async () => {
    const adapter = makeMockAdapter();
    const cancellation = new Error("User force closed the prompt");
    adapter.checkbox.mockRejectedValue(cancellation);
    const prompt = new M3LPrompt({ adapter });
    await expect(
      prompt.multiselect("Targets?", ["dev", "staging", "prod"]),
    ).rejects.toBe(cancellation);
  });
});

// ---------------------------------------------------------------------------
// M3LPrompt.autocomplete — D3 suggest fn signature
// ---------------------------------------------------------------------------
describe("M3LPrompt.autocomplete", () => {
  /** Narrowed shape of the `search` config so the bridged `source` is callable without an `any`/unsafe cast. */
  interface SearchConfig {
    source: (term: string | undefined, opt: { signal: AbortSignal }) => unknown;
  }

  test("D3: bridges the suggest fn (term only, no signal arg) through adapter.search", async () => {
    const adapter = makeMockAdapter();
    const suggest: M3LSuggestFn<string> = (term) =>
      term === undefined ? ["eu-south-1", "us-east-1"] : [term];
    adapter.search.mockImplementation((config: SearchConfig) =>
      config.source(undefined, { signal: new AbortController().signal }),
    );
    const prompt = new M3LPrompt({ adapter });
    await prompt.autocomplete("Region?", suggest);
    expect(adapter.search).toHaveBeenCalled();
  });

  test("resolves with the adapter's selected value (happy path)", async () => {
    const adapter = makeMockAdapter();
    adapter.search.mockResolvedValue("eu-south-1");
    const suggest: M3LSuggestFn<string> = () => ["eu-south-1", "us-east-1"];
    const prompt = new M3LPrompt({ adapter });
    await expect(prompt.autocomplete("Region?", suggest)).resolves.toBe(
      "eu-south-1",
    );
  });

  test("D3: suggest receives an initial undefined term", async () => {
    const adapter = makeMockAdapter();
    adapter.search.mockImplementation((config: SearchConfig) =>
      config.source(undefined, { signal: new AbortController().signal }),
    );
    const receivedTerms: (string | undefined)[] = [];
    const suggest: M3LSuggestFn<string> = (term) => {
      receivedTerms.push(term);
      return ["eu-south-1"];
    };
    const prompt = new M3LPrompt({ adapter });
    await prompt.autocomplete("Region?", suggest);
    expect(receivedTerms).toContain(undefined);
  });

  test("B7/D10: propagates an adapter rejection instead of swallowing it", async () => {
    const adapter = makeMockAdapter();
    const cancellation = new Error("User force closed the prompt");
    adapter.search.mockRejectedValue(cancellation);
    const suggest: M3LSuggestFn<string> = () => ["eu-south-1"];
    const prompt = new M3LPrompt({ adapter });
    await expect(prompt.autocomplete("Region?", suggest)).rejects.toBe(
      cancellation,
    );
  });
});

// ---------------------------------------------------------------------------
// confirmDestructive — promoted from the identical script-local step
// duplicated across 5 consumer scripts (e.g.
// scripts/lambda-ops/src/steps/destructive-gate.ts). M3LPrompt/M3LLogger are
// real classes with private (`#`) fields, so a plain object literal cannot
// structurally satisfy either type — real instances are constructed and
// their public methods are `vi.spyOn`-wrapped, mirroring the pattern already
// established at the script-step-test layer this function is promoted from.
// ---------------------------------------------------------------------------
describe("confirmDestructive", () => {
  test("bypass (yes:true): logs a single warning with the bypass message and never calls prompt.confirm", async () => {
    const prompt = new M3LPrompt();
    const confirm = vi.spyOn(prompt, "confirm");
    const logger = new M3LLogger([]);
    const warning = vi.spyOn(logger, "warning");

    await expect(
      confirmDestructive({
        prompt,
        logger,
        description: "delete bucket my-bucket",
        yes: true,
        code: "ERR_TEST_ABORTED",
      }),
    ).resolves.toBeUndefined();

    expect(confirm).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning.mock.calls[0]).toHaveLength(1);
    expect(warning.mock.calls[0]?.[0]).toBe(
      "destructive confirmation bypassed (yes=true): delete bucket my-bucket",
    );
  });

  test("confirmed (yes:false, confirm resolves true): prompts with the exact message and resolves", async () => {
    const prompt = new M3LPrompt();
    const confirm = vi.spyOn(prompt, "confirm").mockResolvedValue(true);
    const logger = new M3LLogger([]);

    await expect(
      confirmDestructive({
        prompt,
        logger,
        description: "delete bucket my-bucket",
        yes: false,
        code: "ERR_TEST_ABORTED",
      }),
    ).resolves.toBeUndefined();

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]).toHaveLength(1);
    expect(confirm.mock.calls[0]?.[0]).toBe(
      "Confirm: delete bucket my-bucket?",
    );
  });

  test("declined (yes:false, confirm resolves false): throws M3LError with the caller-supplied code", async () => {
    const prompt = new M3LPrompt();
    vi.spyOn(prompt, "confirm").mockResolvedValue(false);
    const logger = new M3LLogger([]);

    let thrown: unknown;
    try {
      await confirmDestructive({
        prompt,
        logger,
        description: "delete bucket my-bucket",
        yes: false,
        code: "ERR_TEST_ABORTED",
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LError);
    expect((thrown as M3LError).message).toBe(
      "aborted: delete bucket my-bucket",
    );
    // A distinctive, non-hardcoded test code proves the caller-supplied
    // `code` flows through verbatim rather than a literal baked into the
    // implementation.
    expect((thrown as M3LError).code).toBe("ERR_TEST_ABORTED");
  });

  test("rejection passthrough: an adapter rejection propagates unchanged, not converted into the aborted M3LError", async () => {
    const prompt = new M3LPrompt();
    const cancellation = new Error("User force closed the prompt");
    vi.spyOn(prompt, "confirm").mockRejectedValue(cancellation);
    const logger = new M3LLogger([]);

    await expect(
      confirmDestructive({
        prompt,
        logger,
        description: "delete bucket my-bucket",
        yes: false,
        code: "ERR_TEST_ABORTED",
      }),
    ).rejects.toBe(cancellation);
  });

  describe("type-level contract", () => {
    test("deps.code accepts an arbitrary string, not a narrowed literal union", () => {
      expectTypeOf(confirmDestructive).parameter(0).toMatchTypeOf<{
        readonly prompt: M3LPrompt;
        readonly logger: M3LLogger;
        readonly description: string;
        readonly yes: boolean;
        readonly code: string;
      }>();
    });

    test("returns Promise<void>", () => {
      expectTypeOf(confirmDestructive).returns.toEqualTypeOf<Promise<void>>();
    });
  });
});

// ---------------------------------------------------------------------------
// B1 — mode-selection conjunction (interactive option + stream.isTTY)
// ---------------------------------------------------------------------------
describe("B1: interactive mode selection", () => {
  test("interactive:false with a non-TTY injected stream forces plain-text output", () => {
    const { stream, output } = makeCaptureStream();
    const bar = new M3LLoadingBar({ stream, interactive: false });
    bar.update(50, "Halfway");
    expect(output()).toMatch(NO_ANSI);
  });

  test("plain mode is selected without needing to touch process.stdout", () => {
    // This test asserts the injected-stream seam is sufficient — no spy on
    // process.stdout is required for a deterministic plain-mode assertion.
    const { stream, output } = makeCaptureStream();
    const spinner = new M3LMultiSpinner({ stream, interactive: false });
    spinner.spin("task", "Running");
    spinner.spinSucceed("task", "Done");
    expect(output()).toMatch(NO_ANSI);
    expect(output().length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Type-level contract (expectTypeOf)
// ---------------------------------------------------------------------------
describe("type-level contract", () => {
  test("select() with no explicit type arg infers Promise<string> from a string[] choices list", () => {
    const adapter = makeMockAdapter();
    const prompt = new M3LPrompt({ adapter });
    const result = prompt.select("Region?", ["eu-south-1", "us-east-1"]);
    expectTypeOf(result).toEqualTypeOf<Promise<string>>();
  });

  test("multiselect() with no explicit type arg infers Promise<string[]>", () => {
    const adapter = makeMockAdapter();
    const prompt = new M3LPrompt({ adapter });
    const result = prompt.multiselect("Targets?", ["dev", "staging"]);
    expectTypeOf(result).toEqualTypeOf<Promise<string[]>>();
  });

  test("autocomplete() with no explicit type arg infers Promise<string>", () => {
    const adapter = makeMockAdapter();
    const prompt = new M3LPrompt({ adapter });
    const suggest: M3LSuggestFn<string> = () => ["eu-south-1"];
    const result = prompt.autocomplete("Region?", suggest);
    expectTypeOf(result).toEqualTypeOf<Promise<string>>();
  });

  test("number() return type is Promise<number>, never undefined, at the M3LPrompt boundary", () => {
    const adapter = makeMockAdapter();
    // Resolve in-range so the returned promise fulfills rather than rejects —
    // this is a type-level assertion only; a floating rejection here would
    // surface as an unhandled rejection since the result is never awaited.
    adapter.number.mockResolvedValue(5);
    const prompt = new M3LPrompt({ adapter });
    const result = prompt.number("Retries?", { min: 0, max: 10 });
    expectTypeOf(result).toEqualTypeOf<Promise<number>>();
  });

  test("new M3LPrompt() zero-arg constructor compiles", () => {
    expectTypeOf(M3LPrompt).instance.toHaveProperty("spinner");
    const prompt = new M3LPrompt();
    expectTypeOf(prompt.spinner).toEqualTypeOf<M3LMultiSpinner>();
    expectTypeOf(prompt.loadingBar).toEqualTypeOf<M3LLoadingBar>();
  });

  test("M3LPromptValidationError is assignable to M3LError; code is the literal", () => {
    expectTypeOf<M3LPromptValidationError>().toMatchTypeOf<M3LError>();
    expectTypeOf<
      M3LPromptValidationError["code"]
    >().toEqualTypeOf<"ERR_PROMPT_VALIDATION">();
  });

  test("M3LChoices<string> accepts both string[] and M3LChoice<string>[]", () => {
    expectTypeOf<string[]>().toMatchTypeOf<M3LChoices<string>>();
    expectTypeOf<M3LChoice<string>[]>().toMatchTypeOf<M3LChoices<string>>();
  });

  test("M3LPromptOptions shape accepts adapter/spinner/loadingBar", () => {
    expectTypeOf<M3LPromptOptions>().toExtend<{
      adapter?: M3LPromptAdapter;
      spinner?: M3LMultiSpinner | M3LMultiSpinnerOptions;
      loadingBar?: M3LLoadingBar | M3LLoadingBarOptions;
    }>();
  });

  test("M3LNumberPromptOptions shape is {min?,max?,default?}", () => {
    expectTypeOf<M3LNumberPromptOptions>().toExtend<{
      min?: number;
      max?: number;
      default?: number;
    }>();
  });
});

// ---------------------------------------------------------------------------
// internal/prompt/inquirerAdapter — createInquirerAdapter()
//
// The production M3LPromptAdapter: a thin pass-through over each
// @inquirer/prompts function. Covered here via the hoisted module mock so no
// real terminal is touched.
// ---------------------------------------------------------------------------
describe("internal: createInquirerAdapter", () => {
  afterEach(() => {
    for (const mockFn of Object.values(inquirerMocks)) {
      mockFn.mockReset();
    }
  });

  test("input() delegates to @inquirer/prompts input with the given config", async () => {
    inquirerMocks.input.mockResolvedValue("my-project");
    const adapter = createInquirerAdapter();
    const config = { message: "Project name?" };
    await expect(adapter.input(config)).resolves.toBe("my-project");
    expect(inquirerMocks.input).toHaveBeenCalledWith(config);
  });

  test("password() delegates to @inquirer/prompts password with the given config", async () => {
    inquirerMocks.password.mockResolvedValue("secret");
    const adapter = createInquirerAdapter();
    const config = { message: "API token?" };
    await expect(adapter.password(config)).resolves.toBe("secret");
    expect(inquirerMocks.password).toHaveBeenCalledWith(config);
  });

  test("number() delegates to @inquirer/prompts number with the given config", async () => {
    inquirerMocks.number.mockResolvedValue(5);
    const adapter = createInquirerAdapter();
    const config = { message: "Retries?", min: 0, max: 10 };
    await expect(adapter.number(config)).resolves.toBe(5);
    expect(inquirerMocks.number).toHaveBeenCalledWith(config);
  });

  test("confirm() delegates to @inquirer/prompts confirm with the given config", async () => {
    inquirerMocks.confirm.mockResolvedValue(true);
    const adapter = createInquirerAdapter();
    const config = { message: "Continue?" };
    await expect(adapter.confirm(config)).resolves.toBe(true);
    expect(inquirerMocks.confirm).toHaveBeenCalledWith(config);
  });

  test("select() delegates to @inquirer/prompts select with the given config", async () => {
    inquirerMocks.select.mockResolvedValue("eu-south-1");
    const adapter = createInquirerAdapter();
    const config = { message: "Region?", choices: ["eu-south-1", "us-east-1"] };
    await expect(adapter.select(config)).resolves.toBe("eu-south-1");
    expect(inquirerMocks.select).toHaveBeenCalledWith(config);
  });

  test("checkbox() delegates to @inquirer/prompts checkbox with the given config", async () => {
    inquirerMocks.checkbox.mockResolvedValue(["dev", "staging"]);
    const adapter = createInquirerAdapter();
    const config = { message: "Targets?", choices: ["dev", "staging", "prod"] };
    await expect(adapter.checkbox(config)).resolves.toEqual(["dev", "staging"]);
    expect(inquirerMocks.checkbox).toHaveBeenCalledWith(config);
  });

  test("search() delegates to @inquirer/prompts search with the given config", async () => {
    inquirerMocks.search.mockResolvedValue("eu-south-1");
    const adapter = createInquirerAdapter();
    const source = (): string[] => ["eu-south-1"];
    const config = { message: "Region?", source };
    await expect(adapter.search(config)).resolves.toBe("eu-south-1");
    expect(inquirerMocks.search).toHaveBeenCalledWith(config);
  });
});

// ---------------------------------------------------------------------------
// internal/prompt/ansi — resolveInteractive() truth table
// ---------------------------------------------------------------------------
describe("internal: resolveInteractive", () => {
  test("interactiveOption:true overrides auto-detection to true", () => {
    expect(
      resolveInteractive({
        interactiveOption: true,
        isEnvironmentInteractive: false,
        isStreamTTY: false,
      }),
    ).toBe(true);
  });

  test("interactiveOption:false overrides auto-detection to false", () => {
    expect(
      resolveInteractive({
        interactiveOption: false,
        isEnvironmentInteractive: true,
        isStreamTTY: true,
      }),
    ).toBe(false);
  });

  test("interactiveOption:undefined with both signals true falls through to auto-detect true", () => {
    expect(
      resolveInteractive({
        interactiveOption: undefined,
        isEnvironmentInteractive: true,
        isStreamTTY: true,
      }),
    ).toBe(true);
  });

  test("interactiveOption:undefined with isEnvironmentInteractive false falls through to auto-detect false", () => {
    expect(
      resolveInteractive({
        interactiveOption: undefined,
        isEnvironmentInteractive: false,
        isStreamTTY: true,
      }),
    ).toBe(false);
  });

  test("interactiveOption:undefined with isStreamTTY false falls through to auto-detect false", () => {
    expect(
      resolveInteractive({
        interactiveOption: undefined,
        isEnvironmentInteractive: true,
        isStreamTTY: false,
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// internal/prompt/ansi — resolveRenderTarget() stream + live resolution
//
// resolveRenderTarget centralizes "default the stream to process.stdout,
// read lazily" plus the resolveInteractive pairing shared by M3LMultiSpinner
// and M3LLoadingBar. These two tests hit the branches the higher-level
// M3LMultiSpinner/M3LLoadingBar tests never exercise: the `stream ??
// process.stdout` fallback (they always inject an explicit stream) and the
// `isTTY === true` true-arm (their injected PassThrough streams have no
// `isTTY` property at all).
// ---------------------------------------------------------------------------
describe("internal: resolveRenderTarget", () => {
  test("stream:undefined falls back to process.stdout, with interactiveOption:false overriding live to false", () => {
    const result = resolveRenderTarget(undefined, false);
    expect(result.stream).toBe(process.stdout);
    expect(result.live).toBe(false);
  });

  test("a stream with isTTY:true is passed through, with interactiveOption:true overriding live to true", () => {
    const ttyStream = Object.assign(new PassThrough(), { isTTY: true });
    const result = resolveRenderTarget(ttyStream, true);
    expect(result.stream).toBe(ttyStream);
    expect(result.live).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// M3LMultiSpinner — live/interactive ANSI-redraw branch (interactive: true)
//
// The B2/B8/B10 blocks above force interactive:false to assert the plain-text
// branch deterministically. These tests assert the opposite branch: with
// interactive:true (and no TTY needed — the option overrides auto-detection),
// M3LMultiSpinner renders the live ANSI redraw sequence.
// ---------------------------------------------------------------------------
describe("M3LMultiSpinner — interactive (live ANSI) mode", () => {
  test("spin() writes a carriage-return + CSI clear-line ANSI redraw sequence", () => {
    const { stream, output } = makeCaptureStream();
    const spinner = new M3LMultiSpinner({ stream, interactive: true });
    spinner.spin("upload", "Uploading…");
    const rendered = output();
    expect(rendered).toContain("\r");
    expect(rendered).toContain(`${ESC}[K`);
    expect(rendered).toContain("Uploading…");
  });

  test("spinSucceed()/spinFail()/spinWarn() each write the live ANSI redraw sequence", () => {
    const { stream, output } = makeCaptureStream();
    const spinner = new M3LMultiSpinner({ stream, interactive: true });
    spinner.spin("upload", "Uploading…");
    spinner.spinSucceed("upload", "Uploaded");
    spinner.spin("index", "Indexing…");
    spinner.spinFail("index", "Index failed");
    spinner.spin("verify", "Verifying…");
    spinner.spinWarn("verify", "Verify warned");
    const rendered = output();
    expect(rendered).toContain(`${ESC}[K`);
    expect(rendered).toContain("Uploaded");
    expect(rendered).toContain("Index failed");
    expect(rendered).toContain("Verify warned");
  });

  test("single-spinner methods (startSpinner/updateSpinner/spinnerStop/spinnerFail) also render live ANSI", () => {
    const { stream, output } = makeCaptureStream();
    const spinner = new M3LMultiSpinner({ stream, interactive: true });
    spinner.startSpinner("Working…");
    spinner.updateSpinner("Still working…");
    spinner.spinnerStop("Done");
    const rendered = output();
    expect(rendered).toContain(`${ESC}[K`);
    expect(rendered).toContain("Done");
  });

  test("spinnerFail() renders live ANSI for the single-spinner failure path", () => {
    const { stream, output } = makeCaptureStream();
    const spinner = new M3LMultiSpinner({ stream, interactive: true });
    spinner.startSpinner("Working…");
    spinner.spinnerFail("Failed");
    const rendered = output();
    expect(rendered).toContain(`${ESC}[K`);
    expect(rendered).toContain("Failed");
  });
});
