import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import { commandModule, consoleOutput, toOutcome } from "../src/command.js";
import { configParameters } from "../src/config.js";

/**
 * This package's own manifest, read at runtime rather than imported: the
 * shared tsconfig does not enable `resolveJsonModule`, and turning it on for
 * one assertion would widen the compiler surface for every script. Resolved
 * from this file's own URL, so it does not depend on the runner's working
 * directory.
 */
interface PackageManifest {
  readonly name: string;
  readonly version: string;
  readonly description: string;
}

const manifest: PackageManifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as PackageManifest;

/**
 * Contract: `docs/reference/core/cli-contract.md` (ADR-0054) plus
 * `docs/reference/scripts/dynamodb-crud.md`.
 *
 * This file is the anti-drift guard for the command-module seam: `command.ts`
 * and `main.ts` are two independent composition sites until the CLI's
 * in-process host unifies them, so the properties that must hold across both
 * are asserted here.
 *
 * Deliberately NOT tested: a live `commandModule.execute(...)` call. Even a
 * dry run runs pipeline stages 1-5 — config resolution, plus AWS provisioning
 * where `aws.profile` is declared — so it would need real inputs (and
 * credentials) and would write a run report into the data tree. The
 * composition is asserted mechanically instead, by `pnpm
 * check:script-scaffold`, whose optional-but-verified tier requires an adopted
 * `src/command.ts` to compose `Core.runScript` and to source its schema from
 * `./config.js`.
 */
describe("dynamodb-crud command module descriptor", () => {
  it("names itself with the script's own kebab-case name", () => {
    // The name is the CLI's dispatch key (ADR-0042 `m3l <script>`), so it must
    // match the package directory exactly.
    expect(commandModule.name).toBe("dynamodb-crud");
  });

  // Asserted against package.json rather than a bare "0.0.0" literal, so the
  // manifest is the single source of truth and a bumped package version that
  // never reached the descriptor is caught. `main.ts` holds a third copy that
  // no test can reach without parsing it — a residual drift the CLI's
  // in-process host retires when it unifies the two composition roots.
  it("carries the same version as package.json", () => {
    expect(commandModule.version).toBe(manifest.version);
  });

  // Drift guard, not a tautology: a host renders `description` in help output,
  // and package.json's is what every other surface (the reference index, the
  // command catalog) already shows. Two hand-written copies of the same
  // sentence is exactly the kind of thing that silently diverges.
  it("carries the same one-line description as package.json", () => {
    expect(commandModule.description).toBe(manifest.description);
  });

  it("agrees with the package manifest on the script's name", () => {
    expect(manifest.name).toBe(`@m3l-automation/${commandModule.name}`);
  });

  it("exposes execute as a function of two arguments", () => {
    // `typeof`, not `expect(fn).toBeTypeOf(...)`: passing the method as a
    // value trips `@typescript-eslint/unbound-method`, and the point here is
    // the shape, not a callable reference.
    expect(typeof commandModule.execute).toBe("function");
    expect(commandModule.execute.length).toBe(2);
  });

  // Identity, not deep equality: a second parameter literal inside command.ts
  // would be a second source of truth for the schema and could drift from
  // config.ts silently, giving the in-process and spawn paths different
  // configuration contracts.
  it("reuses config.ts's declared schema by identity", () => {
    expect(commandModule.configParameters).toBe(configParameters);
  });

  // This assignment is the whole reason `M3LCommandModule` keeps `name` and
  // `version` flat rather than nested under an `identity` object: the
  // descriptor IS an `M3LScriptMetadata`, so `execute` passes it straight into
  // `new M3LScript({ metadata })` with no adapter and no second literal.
  it("is structurally an M3LScriptMetadata", () => {
    const metadata: Core.M3LScriptMetadata = commandModule;
    expect(metadata.name).toBe(commandModule.name);
    expect(metadata.version).toBe(commandModule.version);
  });
});

describe("dynamodb-crud outcome derivation", () => {
  /** A run that absorbed nothing. */
  const clean = { recovery: [], recoveryTotal: 0 };

  /** One absorbed per-item failure — the minimum that makes a run `partial`. */
  const absorbed = {
    recovery: [
      { item: "record-1", error: [], recordedAt: "2026-01-01T00:00:00.000Z" },
    ],
    recoveryTotal: 1,
  };

  it("reports a clean run as success", () => {
    expect(toOutcome(clean, [], false)).toEqual({ status: "success" });
  });

  it("reports a clean dry run as dry-run", () => {
    expect(toOutcome(clean, [], true)).toEqual({ status: "dry-run" });
  });

  it("reports an absorbed per-item failure as partial", () => {
    expect(toOutcome(absorbed, [], false)).toEqual({
      status: "partial",
      recovered: 1,
    });
  });

  // `recoveryTotal`, not `recovery.length`: the buffer is a ring truncated at
  // `M3L_RECOVERY_LIMIT`, so `.length` under-reports a large batch. This
  // simulates the truncated state directly.
  it("reports the honest recovered count when the ring buffer truncated", () => {
    expect(toOutcome({ ...absorbed, recoveryTotal: 4096 }, [], false)).toEqual({
      status: "partial",
      recovered: 4096,
    });
  });

  it("reports a thrown error as failure, carrying the error", () => {
    const error = new Core.M3LError("boom", { code: "ERR_CONFIG_MISSING" });
    expect(toOutcome(clean, [error], false)).toEqual({
      status: "failure",
      error,
    });
  });

  // Classified by CODE, never by class (ADR-0049) — and it must NOT come out
  // as `failure`, because `mapErrorToExitCode` is typed never to return
  // INTERRUPTED (see the parity block below).
  it("reports a cooperative abort as interrupted, not failure", () => {
    const abort = new Core.M3LOperationAbortedError("cancelled");
    expect(toOutcome(clean, [abort], false)).toEqual({
      status: "interrupted",
    });
  });

  it("lets a failure win over both absorbed recovery and dry-run", () => {
    const error = new Core.M3LError("boom", { code: "ERR_CONFIG_MISSING" });
    // Mirrors runScript: its `catch` skips the PARTIAL assignment entirely,
    // and a dry run that threw is still a failure.
    expect(toOutcome(absorbed, [error], true)).toEqual({
      status: "failure",
      error,
    });
  });

  // A thrown `undefined` is representable, which is exactly why the capture is
  // an array rather than a `let captured: unknown` — the two would otherwise
  // be indistinguishable from "nothing was captured".
  it("treats a thrown undefined as a failure, not as no failure", () => {
    expect(toOutcome(clean, [undefined], false)).toEqual({
      status: "failure",
      error: undefined,
    });
  });
});

describe("dynamodb-crud outcome-to-exit-code parity", () => {
  /**
   * The parity property: for every outcome `toOutcome` can produce, the mapped
   * exit code equals the one `Core.runScript` already assigned to
   * `process.exitCode` on the spawn path. A disagreement means a scheduler
   * sees two different results for the same run depending on how it was
   * invoked — the exact thing ADR-0054's parity clause forbids.
   */
  it("maps a clean run and a dry run to SUCCESS, as runScript leaves it", () => {
    expect(Core.mapCommandOutcomeToExitCode({ status: "success" })).toBe(
      Core.M3L_EXIT_CODES.SUCCESS,
    );
    expect(Core.mapCommandOutcomeToExitCode({ status: "dry-run" })).toBe(
      Core.M3L_EXIT_CODES.SUCCESS,
    );
  });

  it("maps an absorbed-recovery run to PARTIAL, as runScript sets it", () => {
    expect(
      Core.mapCommandOutcomeToExitCode({ status: "partial", recovered: 3 }),
    ).toBe(Core.M3L_EXIT_CODES.PARTIAL);
  });

  it("maps a failure through the same classifier runScript uses", () => {
    const error = new Core.M3LError("boom", { code: "ERR_CONFIG_MISSING" });
    expect(Core.mapCommandOutcomeToExitCode({ status: "failure", error })).toBe(
      Core.mapErrorToExitCode(error),
    );
  });

  it("maps an interrupted run to INTERRUPTED, as runScript sets it", () => {
    expect(Core.mapCommandOutcomeToExitCode({ status: "interrupted" })).toBe(
      Core.M3L_EXIT_CODES.INTERRUPTED,
    );
  });

  // Why the `interrupted` arm is load-bearing rather than decorative:
  // `mapErrorToExitCode` is TYPED never to return INTERRUPTED, so routing an
  // abort through the failure arm would map it to 1-4 while runScript set 5.
  it("cannot express an abort as a failure without disagreeing with runScript", () => {
    const abort = new Core.M3LOperationAbortedError("cancelled");
    expect(
      Core.mapCommandOutcomeToExitCode({ status: "failure", error: abort }),
    ).not.toBe(Core.M3L_EXIT_CODES.INTERRUPTED);
  });
});

describe("dynamodb-crud fallback command output port", () => {
  // The port exists so a caller with no host (this test today, a local
  // invocation before the CLI's in-process renderer ships) can build an
  // `M3LCommandContext`. `colorEnabled` is false by construction, not by
  // configuration: a script cannot resolve colour, because per-stream TTY
  // detection needs `process.env`, which the scripts ESLint zone bans.
  it("satisfies M3LCommandOutput and never claims colour support", () => {
    const output: Core.M3LCommandOutput = consoleOutput;
    expect(output.colorEnabled).toBe(false);
    expect(typeof output.info).toBe("function");
    expect(typeof output.error).toBe("function");
    expect(typeof output.heading).toBe("function");
  });
});
