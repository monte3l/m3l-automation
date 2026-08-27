/**
 * The ADR-0069 `node:sqlite` ExperimentalWarning determination.
 *
 * Every test here spawns a FRESH child `process.execPath`, with
 * `NODE_OPTIONS: ""` in its environment, so an ambient setting on this
 * machine or in CI cannot mask the result — the whole point of this file is
 * to observe what a real, unmodified Node process does, not what this repo's
 * own test runner does.
 *
 * The conclusion this file settles: **the console server's code does nothing
 * either way, and that is correct.**
 *  - If a fresh Node process does not warn (true on Node v26.7.0, observed
 *    below), test 1 is a regression lock — it stays green until some future
 *    Node release changes that, and should go red loudly if it ever does.
 *  - If it DOES warn (a real possibility on the Node 24 CI floor, which is
 *    older than this machine's Node 26), test 1 goes red in this PR. That is
 *    the checkpoint working, not a defect — see the test's own body for why
 *    its failure message is legible on its own.
 *  - Either way, there is still no case for a global `process.on("warning")`
 *    filter in the console server: test 3 proves such a listener cannot
 *    suppress Node's own default stderr print (so it would buy nothing), and
 *    in a long-running server (ADR-0064) it would ALSO swallow every other
 *    experimental/deprecation warning — exactly the signal such a process
 *    most needs surfaced, not hidden.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);

/** Matches Node's default warning line naming `sqlite` as experimental. Reused by tests 1 and 2 so a typo here cannot make test 1 vacuously green. */
const SQLITE_EXPERIMENTAL_WARNING_PATTERN = /ExperimentalWarning:.*sqlite/i;

/**
 * Runs `script` as `node -e <script>` in a brand-new child process with a
 * blanked `NODE_OPTIONS`, and returns its captured stderr (where Node prints
 * process warnings by default).
 */
async function runFreshNodeScript(script: string): Promise<string> {
  const { stderr } = await execFileAsync(process.execPath, ["-e", script], {
    env: { ...process.env, NODE_OPTIONS: "" },
  });
  return stderr;
}

describe("node:sqlite ExperimentalWarning — a fresh child process", () => {
  test("a fresh Node process importing node:sqlite prints no ExperimentalWarning naming sqlite", async () => {
    const stderr = await runFreshNodeScript(
      'import("node:sqlite").then(() => { process.stderr.write("__import-ok__\\n"); });',
    );

    // If this assertion goes red, it means the CI floor's Node (the version
    // that matters, not necessarily this machine's) DOES print an
    // ExperimentalWarning naming sqlite on a plain import — read the actual
    // `stderr` value in the failure diff below; it is Node's own warning
    // text, not a bug in this test.
    expect(stderr).not.toMatch(SQLITE_EXPERIMENTAL_WARNING_PATTERN);
    expect(stderr).toContain("__import-ok__");
  });
});

describe("node:sqlite ExperimentalWarning — guard the guard", () => {
  test("the probe sees an ExperimentalWarning that Node does emit", async () => {
    // Without this test, a typo in SQLITE_EXPERIMENTAL_WARNING_PATTERN (or an
    // overly narrow one) would make the test above pass vacuously forever,
    // regardless of what Node actually prints. This proves the SAME matcher
    // used above genuinely detects a real ExperimentalWarning that names
    // sqlite, using Node's own public `process.emitWarning` API rather than
    // depending on node:sqlite itself ever warning.
    const stderr = await runFreshNodeScript(
      'process.emitWarning("node:sqlite is an experimental feature", "ExperimentalWarning");',
    );

    expect(stderr).toMatch(SQLITE_EXPERIMENTAL_WARNING_PATTERN);
  });
});

describe("node:sqlite ExperimentalWarning — the design lever", () => {
  test("attaching a process 'warning' listener does not suppress Node's default stderr print", async () => {
    // Settles empirically, rather than by assumption, whether the console
    // server could install a `process.on("warning", ...)` filter to hide
    // this specific warning. It cannot: Node prints the default warning line
    // regardless of whether a listener is attached (only `--no-warnings`
    // suppresses the default print, which this repo does not set).
    const stderr = await runFreshNodeScript(
      'process.on("warning", () => {}); process.emitWarning("node:sqlite is an experimental feature", "ExperimentalWarning");',
    );

    expect(stderr).toMatch(SQLITE_EXPERIMENTAL_WARNING_PATTERN);
  });
});
