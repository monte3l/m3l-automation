#!/usr/bin/env node
// Asserts every GitHub Actions workflow step that invokes a bin/**/*.mjs
// script requiring packages/m3l-cli/dist to be built is preceded, in the
// same job, by a step that builds @m3l-automation/m3l-cli. Derives the
// "requires the CLI built" set from bin/**'s actual import graph
// (bin/lib/workflow-build-order.mjs) instead of a hand-maintained list —
// ci.yml's own comment enumerating four consumers was already stale (it
// never named bin/gen-project-hub.mjs), which is exactly how pages.yml broke
// on every push from 2026-08-26 to 2026-08-27. A derived, re-walked cone
// cannot go stale the same way.
//
// Usage:
//   node bin/check-workflow-build-order.mjs   # exits 0 on success, 1 on any violation
import process from "node:process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  resolveCliDistCone,
  findBuildOrderViolations,
} from "./lib/workflow-build-order.mjs";
import { parseJsonFlag, createReporter, repoRoot } from "./lib/report.mjs";

const root = repoRoot(import.meta.url);
const { json } = parseJsonFlag();
const reporter = createReporter(json);

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const packageScripts = pkg.scripts ?? {};

const cliDistCone = resolveCliDistCone(root);

const workflowsDir = join(root, ".github/workflows");
const workflowFiles = readdirSync(workflowsDir).filter(
  (name) => name.endsWith(".yml") || name.endsWith(".yaml"),
);

const violations = [];
for (const name of workflowFiles) {
  const rel = `.github/workflows/${name}`;
  const text = readFileSync(join(workflowsDir, name), "utf8");
  violations.push(
    ...findBuildOrderViolations(rel, text, cliDistCone, packageScripts),
  );
}

if (violations.length > 0) {
  for (const v of violations) {
    reporter.error(
      `${v.workflow} job "${v.job}" step "${v.step}" invokes ${v.script} (requires packages/m3l-cli built) with no prior build step in the same job.`,
      { file: v.workflow },
    );
  }
  reporter.finish();
  process.exit(1);
}

reporter.succeed(
  `No workflow step invokes an unbuilt packages/m3l-cli/dist-dependent script (${cliDistCone.size} bin/**/*.mjs script(s) in the dependency cone).`,
);
reporter.finish();
