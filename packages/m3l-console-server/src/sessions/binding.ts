/**
 * `sessions/binding` — thin re-export over the promoted
 * `Core.orchestration` step-binding shape (X6 workbench-sessions module,
 * slice 2, ADR-0068).
 *
 * `validateBindingValue` never throws, so — unlike `sessions/reference.ts`
 * — this file needs no error-translating wrapper, just a re-export plus the
 * console-local alias `M3LSessionBinding` (the promoted surface renamed the
 * type `M3LStepBinding`, since "session" is a console concept).
 *
 * @packageDocumentation
 */

import type { Core } from "@m3l-automation/m3l-common";

export type { M3LBindingExpectedType } from "@m3l-automation/m3l-common/core";
export { validateBindingValue } from "@m3l-automation/m3l-common/core";

/** Console-local alias for the promoted `Core.M3LStepBinding` shape. */
export type M3LSessionBinding = Core.M3LStepBinding;
