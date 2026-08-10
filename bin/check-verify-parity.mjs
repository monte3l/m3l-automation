#!/usr/bin/env node
// Asserts bin/lib/verify-steps.mjs (the `pnpm verify` aggregate gate's step
// list) matches the CI `verify` job in .github/workflows/ci.yml exactly, in
// both directions — no step in CI missing from the list, and no listed step
// that no longer exists in CI. Without this, `pnpm verify` silently drifts
// from what CI actually gates, the same failure mode check:cadence guards
// for the lefthook/CLAUDE.md pair.
//
// Canonical rule: ci.yml's `verify` job drives the set; VERIFY_STEPS must
// track it exactly, joined on the `name:` field (`ciStepName`), not on the
// command string — command strings drift in harmless ways (flags, wrapper
// choice) that would otherwise read as false-positive drift.
//
// Usage:
//   node bin/check-verify-parity.mjs   # exits 0 on match, 1 on drift
import process from "node:process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  parseCiVerifyStepNames,
  diffVerifySteps,
} from "./lib/verify-steps.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

let ciStepNames;
try {
  ciStepNames = parseCiVerifyStepNames(
    readFileSync(join(root, ".github/workflows/ci.yml"), "utf8"),
  );
} catch (error) {
  console.error(`✗  ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}

const { missingFromList, staleInList } = diffVerifySteps(ciStepNames);

if (missingFromList.length > 0 || staleInList.length > 0) {
  console.error(
    "✗  bin/lib/verify-steps.mjs drifted from ci.yml's verify job:",
  );
  for (const name of missingFromList) {
    console.error(
      `   - ci.yml runs "${name}" but VERIFY_STEPS has no matching entry.`,
    );
  }
  for (const name of staleInList) {
    console.error(
      `   - VERIFY_STEPS lists "${name}" but ci.yml's verify job no longer runs it.`,
    );
  }
  process.exit(1);
}

console.log(
  `✓  bin/lib/verify-steps.mjs matches ci.yml's verify job (${ciStepNames.length} step(s)).`,
);
