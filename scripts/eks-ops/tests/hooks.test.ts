import { describe, expect, test } from "vitest";

import type { Core } from "@m3l-automation/m3l-common";

import { hooks } from "../src/hooks.js";

/**
 * Contract: `src/hooks.ts` — the currently-scaffolded stub declares no
 * lifecycle hooks (`{}` is a valid `Core.M3LScriptLifecycleHooks`, per
 * `docs/reference/core/script.md`). This is deliberately a thin smoke test:
 * `run-eks-ops.ts`'s own deps signature (`{ config, paths, logger,
 * operations, prompt }`, per `docs/reference/scripts/eks-ops.md`) carries no
 * `correlationId`, so — unlike `codepipeline-ops` — there is no
 * `getCorrelationId()`-style capture surface here to test. Extend this file
 * the moment `hooks.ts` grows an actual hook body.
 */
describe("eks-ops hooks declaration", () => {
  test("declares a valid (possibly empty) M3LScriptLifecycleHooks object", () => {
    const declared: Core.M3LScriptLifecycleHooks = hooks;
    expect(declared).toBeTypeOf("object");
  });
});
