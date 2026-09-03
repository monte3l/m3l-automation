import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, expectTypeOf, test, vi } from "vitest";

import type {
  M3LScriptDetail,
  M3LScriptParameter,
} from "../../src/api/scripts.js";
import type { M3LParameterFormSubmission } from "../../src/components/ParameterForm.js";
import { ParameterForm } from "../../src/components/ParameterForm.js";
import type { M3LParameterBinding } from "../../src/internal/parameter-bindings.js";

/**
 * Shape emitted by {@link ParameterForm}'s `onLaunch` callback. Not
 * imported from `src/api/runs.js`'s `M3LRunLaunchRequest` on purpose: that
 * request also carries `scriptName`, which `ParameterForm` does not know
 * about (its parent, `ScriptDetail`, adds it before calling `launchRun`).
 */
interface ParameterFormSubmission {
  readonly parameters: Record<string, string>;
  readonly dryRun: boolean;
  readonly confirmed: boolean;
}

function buildParameter(
  overrides: Partial<M3LScriptParameter> & { readonly name: string },
): M3LScriptParameter {
  return {
    aliases: [],
    type: "STRING",
    required: false,
    defaultValue: null,
    description: "",
    secret: false,
    operations: [],
    ...overrides,
  };
}

function buildDetail(
  parameters: readonly M3LScriptParameter[],
  operations: M3LScriptDetail["operations"] = [],
): M3LScriptDetail {
  return {
    name: "demo-script",
    description: "Runs the demo pipeline",
    hasCommandModule: false,
    executionMode: "spawn",
    parameters,
    operations,
  };
}

function renderForm(
  detail: M3LScriptDetail,
  onLaunch: (submission: ParameterFormSubmission) => void = vi.fn(),
  submitting = false,
  bindings?: readonly M3LParameterBinding[],
): { readonly onLaunch: (submission: ParameterFormSubmission) => void } {
  render(
    <ParameterForm
      detail={detail}
      onLaunch={onLaunch}
      submitting={submitting}
      {...(bindings !== undefined && { bindings })}
    />,
  );
  return { onLaunch };
}

function clickLaunch(): void {
  fireEvent.click(screen.getByRole("button", { name: /launch/i }));
}

describe("ParameterForm — operation-scoping visibility", () => {
  test("a required: true parameter is always shown, regardless of operation scoping", () => {
    const alwaysRequired = buildParameter({
      name: "alwaysRequired",
      required: true,
      operations: [
        { name: "opOther", description: "", requiredParameters: [] },
      ],
    });
    renderForm(
      buildDetail(
        [alwaysRequired],
        [
          { name: "opSelected", description: "", requiredParameters: [] },
          { name: "opOther", description: "", requiredParameters: [] },
        ],
      ),
    );

    expect(screen.getByLabelText("alwaysRequired")).toBeInTheDocument();
  });

  test("a parameter with an empty operations array is always shown", () => {
    const unscopedOptional = buildParameter({
      name: "unscopedOptional",
      required: false,
      operations: [],
    });
    renderForm(buildDetail([unscopedOptional]));

    expect(screen.getByLabelText("unscopedOptional")).toBeInTheDocument();
  });

  test("a parameter scoped to operations is hidden when a different operation is selected", () => {
    const scopedHidden = buildParameter({
      name: "scopedHidden",
      required: false,
      operations: [
        { name: "opOther", description: "", requiredParameters: [] },
      ],
    });
    renderForm(
      buildDetail(
        [scopedHidden],
        [
          { name: "opSelected", description: "", requiredParameters: [] },
          { name: "opOther", description: "", requiredParameters: [] },
        ],
      ),
    );

    fireEvent.change(screen.getByLabelText("Operation"), {
      target: { value: "opSelected" },
    });

    expect(screen.queryByLabelText("scopedHidden")).not.toBeInTheDocument();
  });

  test("a parameter the selected operation lists in requiredParameters is shown AND enforced-required, even when its own required is false and it is scoped to a different operation", () => {
    const crossRequired = buildParameter({
      name: "crossRequired",
      required: false,
      operations: [
        { name: "opOther", description: "", requiredParameters: [] },
      ],
    });
    renderForm(
      buildDetail(
        [crossRequired],
        [
          {
            name: "opSelected",
            description: "",
            requiredParameters: ["crossRequired"],
          },
          { name: "opOther", description: "", requiredParameters: [] },
        ],
      ),
    );

    fireEvent.change(screen.getByLabelText("Operation"), {
      target: { value: "opSelected" },
    });

    const input = screen.getByLabelText("crossRequired");
    expect(input).toBeInTheDocument();
    expect(input).toBeRequired();
  });
});

describe("ParameterForm — controls by type", () => {
  test('BOOL renders a checkbox submitted as "true"/"false"', () => {
    const boolParam = buildParameter({ name: "enableFeature", type: "BOOL" });
    const { onLaunch } = renderForm(buildDetail([boolParam]), vi.fn());

    const checkbox = screen.getByLabelText("enableFeature");
    expect(checkbox).toHaveAttribute("type", "checkbox");

    clickLaunch();
    expect(onLaunch).toHaveBeenLastCalledWith(
      expect.objectContaining({ parameters: { enableFeature: "false" } }),
    );

    fireEvent.click(checkbox);
    clickLaunch();
    expect(onLaunch).toHaveBeenLastCalledWith(
      expect.objectContaining({ parameters: { enableFeature: "true" } }),
    );
  });

  test.each([
    ["INT", "retries"],
    ["DOUBLE", "threshold"],
  ])("%s renders a number input", (type, name) => {
    const param = buildParameter({ name, type });
    renderForm(buildDetail([param]));

    expect(screen.getByLabelText(name)).toHaveAttribute("type", "number");
  });

  test.each([
    ["STRING", "region"],
    ["STRING_ARRAY", "tags"],
    ["INT_ARRAY", "counts"],
    ["DOUBLE_ARRAY", "ratios"],
    ["BUFFER", "payload"],
  ])("%s renders a text input", (type, name) => {
    const param = buildParameter({ name, type });
    renderForm(buildDetail([param]));

    expect(screen.getByLabelText(name)).toHaveAttribute("type", "text");
  });

  // Maintainer decision (X10d security review): the console server persists
  // a run's `parameters` verbatim to SQLite and echoes them back in
  // cleartext (RunDetail renders that echo as-is; see
  // docs/reference/console.md's "do not pass secrets as run parameters"
  // warning). A `type="password"` control signals the opposite of the
  // truth, so this REPLACES the previous password-input requirement: a
  // `secret: true` parameter gets no editable control of any kind,
  // regardless of its declared type.
  test("secret: true renders no editable control, regardless of type", () => {
    const secretInt = buildParameter({
      name: "secretCount",
      type: "INT",
      secret: true,
    });
    renderForm(buildDetail([secretInt]));

    expect(screen.queryByLabelText("secretCount")).not.toBeInTheDocument();
    expect(
      document.querySelector(
        "input#secretCount, select#secretCount, textarea#secretCount",
      ),
    ).toBeNull();
  });

  test("secret: true shows an explanation in place of a control", () => {
    const secretParam = buildParameter({ name: "apiKey", secret: true });
    renderForm(buildDetail([secretParam]));

    const form = screen.getByTestId("parameter-form");
    expect(form.textContent).toContain("apiKey");
    expect(form.textContent).toMatch(/secret/i);
  });

  test("a secret parameter never appears in the submitted parameters, even alongside filled-in non-secret parameters", () => {
    const secretParam = buildParameter({
      name: "apiKey",
      secret: true,
      required: false,
    });
    const region = buildParameter({ name: "region", required: false });
    const onLaunch = vi.fn();
    renderForm(buildDetail([secretParam, region]), onLaunch);

    // A secret parameter has no editable control at all (see the two tests
    // above), so there is nothing to type into for `apiKey` — the fix under
    // test is that its key is omitted from `parameters` unconditionally, not
    // merely because it was left empty. Fill in the co-present non-secret
    // parameter to prove the omission is specific to `apiKey` and not an
    // artifact of an otherwise-empty submission.
    fireEvent.change(screen.getByLabelText("region"), {
      target: { value: "us-east-1" },
    });
    clickLaunch();

    const submission = onLaunch.mock.calls[0]?.[0] as
      ParameterFormSubmission | undefined;
    expect(submission?.parameters).not.toHaveProperty("apiKey");
    expect(submission?.parameters).toMatchObject({ region: "us-east-1" });
  });
});

describe("ParameterForm — default value prefill", () => {
  // Superseded by "secret: true renders no editable control, regardless of
  // type" above (a secret parameter has no control at all, so there is
  // nothing to prefill) — kept here to also pin that the server's mask
  // default value specifically never leaks into a rendered control.
  test("a secret parameter's server-mask defaultValue is never exposed via an editable control", () => {
    const secretParam = buildParameter({
      name: "apiKey",
      secret: true,
      defaultValue: "********",
    });
    renderForm(buildDetail([secretParam]));

    expect(screen.queryByLabelText("apiKey")).not.toBeInTheDocument();
    expect(document.querySelector("input#apiKey")).toBeNull();
  });

  test("a non-secret parameter with a defaultValue is prefilled", () => {
    const stringParam = buildParameter({
      name: "region",
      defaultValue: "us-east-1",
    });
    renderForm(buildDetail([stringParam]));

    const input = screen.getByLabelText<HTMLInputElement>("region");
    expect(input.value).toBe("us-east-1");
  });
});

describe("ParameterForm — optional-left-empty omission", () => {
  test('an optional parameter left empty is omitted from submitted parameters, not sent as ""', () => {
    const optionalString = buildParameter({
      name: "region",
      required: false,
      defaultValue: null,
    });
    const onLaunch = vi.fn();
    renderForm(buildDetail([optionalString]), onLaunch);

    clickLaunch();

    const submission = onLaunch.mock.calls[0]?.[0] as
      ParameterFormSubmission | undefined;
    expect(submission).not.toHaveProperty("parameters.region");
    expect(submission?.parameters).not.toHaveProperty("region");
  });
});

describe("ParameterForm — launch gating", () => {
  test("dryRun starts checked", () => {
    const param = buildParameter({ name: "region" });
    renderForm(buildDetail([param]));

    expect(screen.getByLabelText("Dry run")).toBeChecked();
  });

  test("submit is enabled by default (dryRun on exempts confirmation)", () => {
    const param = buildParameter({ name: "region" });
    renderForm(buildDetail([param]));

    expect(screen.getByRole("button", { name: /launch/i })).not.toBeDisabled();
  });

  test("unchecking dryRun reveals a confirm control and disables submit until confirmed", () => {
    const param = buildParameter({ name: "region" });
    renderForm(buildDetail([param]));

    fireEvent.click(screen.getByLabelText("Dry run"));

    const confirmControl = screen.getByLabelText("Confirm real run");
    expect(confirmControl).not.toBeChecked();
    expect(screen.getByRole("button", { name: /launch/i })).toBeDisabled();
  });

  test("checking confirm enables submit and produces confirmed: true on launch", () => {
    const param = buildParameter({ name: "region" });
    const onLaunch = vi.fn();
    renderForm(buildDetail([param]), onLaunch);

    fireEvent.click(screen.getByLabelText("Dry run"));
    fireEvent.click(screen.getByLabelText("Confirm real run"));

    expect(screen.getByRole("button", { name: /launch/i })).not.toBeDisabled();

    clickLaunch();
    expect(onLaunch).toHaveBeenLastCalledWith(
      expect.objectContaining({ dryRun: false, confirmed: true }),
    );
  });

  test("re-checking dryRun resets confirmed back to false — a stale confirmation cannot survive a toggle round-trip", () => {
    const param = buildParameter({ name: "region" });
    renderForm(buildDetail([param]));

    const dryRunCheckbox = screen.getByLabelText("Dry run");

    // Turn dryRun off, confirm the real run — confirmed becomes true and
    // submit is enabled.
    fireEvent.click(dryRunCheckbox);
    fireEvent.click(screen.getByLabelText("Confirm real run"));
    expect(screen.getByRole("button", { name: /launch/i })).not.toBeDisabled();

    // Re-check dryRun (back on), then uncheck it again (back off) without
    // ever touching the confirm control directly. If the stale `confirmed`
    // survived the round-trip, the confirm control would still read
    // checked and submit would still be enabled here.
    fireEvent.click(dryRunCheckbox);
    fireEvent.click(dryRunCheckbox);

    expect(screen.getByLabelText("Confirm real run")).not.toBeChecked();
    expect(screen.getByRole("button", { name: /launch/i })).toBeDisabled();
  });
});

describe("ParameterForm — submitting flag", () => {
  test("submit is disabled while submitting, even when otherwise launchable", () => {
    const param = buildParameter({ name: "region" });
    renderForm(buildDetail([param]), vi.fn(), true);

    expect(screen.getByRole("button", { name: /launch/i })).toBeDisabled();
  });
});

describe("ParameterForm — __proto__-named parameter", () => {
  // buildInitialValues/buildSubmissionParameters both build the value map
  // with `values[parameter.name] = ...`. When `parameter.name` is literally
  // "__proto__", plain-assignment syntax invokes Object.prototype's
  // `__proto__` accessor setter instead of creating an own property — since
  // the assigned value is a string (not an object/null), the ECMAScript
  // spec's setter silently no-ops, so the key is dropped without error.
  // Object.prototype itself is NOT polluted (the no-op cuts both ways) —
  // this is a correctness/data-loss edge, not a pollution hole. Checked via
  // an explicit own-property descriptor (not `toHaveProperty`, whose
  // path-based lookup is unreliable for a literal "__proto__" segment) and
  // via a JSON round-trip, since that is the shape actually sent as the
  // launch request body.
  test("a parameter literally named __proto__ round-trips its value into submitted parameters", () => {
    const protoParam = buildParameter({
      name: "__proto__",
      required: false,
      defaultValue: null,
    });
    const onLaunch = vi.fn();
    renderForm(buildDetail([protoParam]), onLaunch);

    fireEvent.change(screen.getByLabelText("__proto__"), {
      target: { value: "polluted-value" },
    });
    clickLaunch();

    const submission = onLaunch.mock.calls[0]?.[0] as
      ParameterFormSubmission | undefined;
    const parameters = submission?.parameters;
    expect(Object.prototype.hasOwnProperty.call(parameters, "__proto__")).toBe(
      true,
    );
    expect(
      Object.getOwnPropertyDescriptor(parameters, "__proto__")?.value,
    ).toBe("polluted-value");
    expect(
      JSON.parse(JSON.stringify(parameters)) as Record<string, unknown>,
    ).toHaveProperty("__proto__", "polluted-value");
  });
});

// X10d type-design review: `M3LParameterFormSubmission.parameters` is
// declared as a mutable `Record<string, string>` while the request field it
// feeds (`M3LRunLaunchRequest.parameters` in src/api/runs.ts) is
// `Readonly<Record<string, string>>`. `expectTypeOf` is a compile-time-only
// assertion — `vitest run` reports this green regardless of the pin's
// outcome; the actual signal is `pnpm typecheck`.
describe("M3LParameterFormSubmission — parameters readonly shape (type-level)", () => {
  test("[KNOWN BUG] parameters is declared readonly", () => {
    expectTypeOf<M3LParameterFormSubmission["parameters"]>().toEqualTypeOf<
      Readonly<Record<string, string>>
    >();
  });
});

describe("ParameterForm — bindings prefill", () => {
  test("a binding matching a non-secret parameter overrides that parameter's own defaultValue", () => {
    const region = buildParameter({
      name: "region",
      defaultValue: "us-east-1",
    });
    const bindings: readonly M3LParameterBinding[] = [
      { parameterName: "region", value: "eu-west-1", multiSelect: false },
    ];
    renderForm(buildDetail([region]), vi.fn(), false, bindings);

    const input = screen.getByLabelText<HTMLInputElement>("region");
    expect(input.value).toBe("eu-west-1");
  });

  test("a binding matching a secret parameter is ignored — no control renders, and its value never leaks into the submission", () => {
    const secretParam = buildParameter({
      name: "apiKey",
      secret: true,
      required: false,
    });
    const region = buildParameter({ name: "region", required: false });
    const bindings: readonly M3LParameterBinding[] = [
      { parameterName: "apiKey", value: "leaked-secret", multiSelect: false },
    ];
    const onLaunch = vi.fn();
    renderForm(buildDetail([secretParam, region]), onLaunch, false, bindings);

    expect(screen.queryByLabelText("apiKey")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("region"), {
      target: { value: "us-east-1" },
    });
    clickLaunch();

    const submission = onLaunch.mock.calls[0]?.[0] as
      ParameterFormSubmission | undefined;
    expect(submission?.parameters).not.toHaveProperty("apiKey");
    expect(submission?.parameters).toMatchObject({ region: "us-east-1" });
  });

  test("a binding matching no declared parameter is a harmless no-op — form renders as if the prop were absent", () => {
    const region = buildParameter({
      name: "region",
      defaultValue: "us-east-1",
    });
    const bindings: readonly M3LParameterBinding[] = [
      { parameterName: "nonExistent", value: "whatever", multiSelect: false },
    ];
    renderForm(buildDetail([region]), vi.fn(), false, bindings);

    const input = screen.getByLabelText<HTMLInputElement>("region");
    expect(input.value).toBe("us-east-1");
    expect(screen.queryByLabelText("nonExistent")).not.toBeInTheDocument();
  });

  test("a multiSelect: true binding on a visible non-secret STRING parameter submits the comma-joined value", () => {
    const queueUrls = buildParameter({ name: "queueUrls", required: false });
    const bindings: readonly M3LParameterBinding[] = [
      {
        parameterName: "queueUrls",
        value: ["url-a", "url-b"],
        multiSelect: true,
      },
    ];
    const onLaunch = vi.fn();
    renderForm(buildDetail([queueUrls]), onLaunch, false, bindings);

    clickLaunch();

    const submission = onLaunch.mock.calls[0]?.[0] as
      ParameterFormSubmission | undefined;
    expect(submission?.parameters).toMatchObject({
      queueUrls: "url-a,url-b",
    });
  });

  test("a binding prefilling a BOOL parameter with value: true starts the checkbox checked", () => {
    const boolParam = buildParameter({ name: "enableFeature", type: "BOOL" });
    const bindings: readonly M3LParameterBinding[] = [
      { parameterName: "enableFeature", value: true, multiSelect: false },
    ];
    renderForm(buildDetail([boolParam]), vi.fn(), false, bindings);

    const checkbox = screen.getByLabelText("enableFeature");
    expect(checkbox).toBeChecked();
  });
});
