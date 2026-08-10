#!/usr/bin/env node
// Verifies every consumer-script package under scripts/ against the ADR-0022
// scaffold shape — the scripts-side sibling of check-scaffold.mjs /
// check-scaffold-seam.mjs. The required shape comes from the shared manifest
// (bin/lib/script-scaffold.mjs) that the generator also emits from, so the
// two cannot drift apart. Deterministic backstop for the scaffolding-scripts
// skill.
//
// Per script package (a scripts/<name>/ dir containing a package.json;
// artifact-only ghosts are ignored):
//   - every required file exists (main.ts/config.ts/hooks.ts, tsconfigs,
//     README) plus at least one steps/ module and at least one test file
//   - README.md's "### Examples" section is populated: no leftover scaffold
//     placeholder, at least one runnable `node dist/main.js` invocation
//   - package.json satisfies the fleet package contract (including the
//     scripts.{build,typecheck,start} command VALUES, not just presence)
//   - tsconfig.json and tsconfig.build.json each `extends` the base config
//     and carry the project reference back to m3l-common
//   - the root tsconfig.json carries the project reference
//   - the contract page docs/reference/scripts/<name>.md exists
// Reverse direction:
//   - every docs/reference/scripts/*.md page maps to an existing script
//   - every ./scripts/* root tsconfig reference maps to an existing package
//
// Passes vacuously when no script package exists.
//
// Usage:
//   node bin/check-script-scaffold.mjs   # exits 0 on success, 1 on any mismatch
import process from "node:process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname, join } from "node:path";
import {
  REQUIRED_EXACT_FILES,
  REQUIRED_GLOBS,
  SCRIPT_DOCS_DIR,
  docPagePath,
  packageManifestErrors,
  readmeExamplesErrors,
  rootTsconfigRef,
  scriptPackageDirs,
  serviceNameErrors,
  tsconfigShapeErrors,
} from "./lib/script-scaffold.mjs";
import { parseJsonFlag, createReporter } from "./lib/report.mjs";

const { json } = parseJsonFlag();
const reporter = createReporter(json);

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

let errors = 0;
function report(message, file) {
  reporter.error(message, file ? { file } : undefined);
  errors++;
}

const scriptNames = scriptPackageDirs(root);
const rootTsconfig = JSON.parse(
  readFileSync(join(root, "tsconfig.json"), "utf8"),
);
const rootRefs = (rootTsconfig.references ?? []).map((entry) => entry.path);

// --- Forward: each script package conforms to the manifest -------------------
for (const name of scriptNames) {
  const packageDir = join(root, "scripts", name);
  const packageDirRel = `scripts/${name}`;

  for (const problem of serviceNameErrors(name)) {
    report(`scripts/${name}: ${problem}`, packageDirRel);
  }

  for (const file of REQUIRED_EXACT_FILES) {
    if (!existsSync(join(packageDir, file))) {
      report(
        `scripts/${name}/${file} is missing (required by ADR-0022).`,
        `${packageDirRel}/${file}`,
      );
    }
  }

  const readmeRel = `${packageDirRel}/README.md`;
  const readmePath = join(packageDir, "README.md");
  if (existsSync(readmePath)) {
    for (const problem of readmeExamplesErrors(
      readFileSync(readmePath, "utf8"),
    )) {
      report(`scripts/${name}/README.md: ${problem}`, readmeRel);
    }
  }

  for (const { dir, suffix, what } of REQUIRED_GLOBS) {
    let matches = [];
    try {
      matches = readdirSync(join(packageDir, dir)).filter((file) =>
        file.endsWith(suffix),
      );
    } catch {
      // Missing directory → handled by the empty-matches report below.
    }
    if (matches.length === 0) {
      report(
        `scripts/${name}/${dir}/ has no ${suffix} file — ${what} is required (ADR-0022 §8).`,
        `${packageDirRel}/${dir}`,
      );
    }
  }

  const manifestRel = `${packageDirRel}/package.json`;
  const manifestPath = join(packageDir, "package.json");
  if (existsSync(manifestPath)) {
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch (cause) {
      report(
        `scripts/${name}/package.json is not valid JSON: ${cause}`,
        manifestRel,
      );
    }
    if (pkg) {
      for (const problem of packageManifestErrors(pkg, name)) {
        report(`scripts/${name}/package.json: ${problem}`, manifestRel);
      }
    }
  }

  for (const [tsconfigFile, templateName] of [
    ["tsconfig.json", "tsconfig.json.tmpl"],
    ["tsconfig.build.json", "tsconfig.build.json.tmpl"],
  ]) {
    const tsconfigRel = `${packageDirRel}/${tsconfigFile}`;
    const tsconfigPath = join(packageDir, tsconfigFile);
    if (!existsSync(tsconfigPath)) continue; // reported above via REQUIRED_EXACT_FILES
    let parsedTsconfig;
    try {
      parsedTsconfig = JSON.parse(readFileSync(tsconfigPath, "utf8"));
    } catch (cause) {
      report(
        `scripts/${name}/${tsconfigFile} is not valid JSON: ${cause}`,
        tsconfigRel,
      );
      continue;
    }
    for (const problem of tsconfigShapeErrors(parsedTsconfig, templateName)) {
      report(`scripts/${name}/${tsconfigFile}: ${problem}`, tsconfigRel);
    }
  }

  const ref = rootTsconfigRef(name);
  if (!rootRefs.includes(ref)) {
    report(
      `tsconfig.json is missing the project reference { "path": "${ref}" } — tsc -b will not build scripts/${name}.`,
      "tsconfig.json",
    );
  }

  const pageRel = docPagePath(name);
  if (!existsSync(join(root, pageRel))) {
    report(
      `${pageRel} is missing — every script ships a contract page (run pnpm scaffold:script or add it).`,
      pageRel,
    );
  }
}

// --- Reverse: no orphan doc pages or root tsconfig references ----------------
const docsDir = join(root, SCRIPT_DOCS_DIR);
if (existsSync(docsDir)) {
  const pages = readdirSync(docsDir).filter(
    (file) => file.endsWith(".md") && file !== "README.md",
  );
  for (const page of pages) {
    const name = basename(page, ".md");
    if (!scriptNames.includes(name)) {
      report(
        `${SCRIPT_DOCS_DIR}/${page} documents "${name}" but scripts/${name}/ does not exist (orphan contract page).`,
        `${SCRIPT_DOCS_DIR}/${page}`,
      );
    }
  }
}

for (const ref of rootRefs.filter((path) => path.startsWith("./scripts/"))) {
  const name = ref.split("/")[2];
  if (!scriptNames.includes(name)) {
    report(
      `tsconfig.json references "${ref}" but scripts/${name}/ is not a script package (stale reference).`,
      "tsconfig.json",
    );
  }
}

if (errors > 0) {
  if (!json) {
    console.error(
      `\n✗  ${errors} script-scaffold mismatch(es). The shape is defined in bin/lib/script-scaffold.mjs (ADR-0022).`,
    );
  }
  reporter.finish();
  process.exit(1);
}

reporter.succeed(
  scriptNames.length === 0
    ? "No script packages under scripts/ — nothing to check."
    : `${scriptNames.length} script package(s) conform to the ADR-0022 scaffold shape.`,
);
reporter.finish();
