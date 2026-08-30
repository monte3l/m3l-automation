/**
 * Filesystem-hardening tests for `core/storage`'s public append-only stream.
 *
 * These cover the three filesystem-facing findings the X7 slice 2 security
 * review raised against the shipped `M3LAppendOnlyStream` — each of them
 * verified by executing a probe, not by reading the source:
 *
 *   1. `O_NOFOLLOW` refuses a SYMLINK at the final path component and does
 *      nothing about a HARDLINK, so an attacker holding the module's own
 *      adopted threat precondition (being able to create a file in the
 *      stream directory) can plant the next segment name as a hardlink to a
 *      file they own and receive the audit records in it, silently;
 *   2. the stream directory and its segments are created with no explicit
 *      mode, yielding a world-readable audit trail under a default umask;
 *   3. the line ceiling is enforced only after a full projection and
 *      serialization, so a single oversized string value is paid for in full
 *      before it is refused — and, past the engine's maximum string length,
 *      escapes as a raw `RangeError` rather than the documented error.
 *
 * They live beside `storage-append-only-stream.test.ts` rather than inside it
 * only because that file is close to the repository's 60 000-byte per-file
 * budget; the conventions are the sibling's — a REAL temporary directory per
 * test, no `node:fs` mocking, and the wall clock pinned whenever a test has
 * to predict a segment file NAME.
 *
 * @packageDocumentation
 */

import {
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { M3LError } from "../src/core/errors/index.js";
import {
  M3LAppendOnlyStream,
  M3LAppendOnlyStreamError,
} from "../src/core/storage/index.js";
import type { M3LAppendOnlyEntry } from "../src/core/storage/index.js";

// ---------------------------------------------------------------------------
// Fixture helpers (deliberately the sibling file's, so both read alike)
// ---------------------------------------------------------------------------

/** A fixed, mid-day UTC instant used whenever a test pins the wall clock. */
const FIXED_CLOCK = Date.UTC(2026, 5, 15, 12, 0, 0);

/**
 * Pins the wall clock and returns the UTC date prefix (`YYYY-MM-DD`) the
 * stream derives its segment names from.
 *
 * A test that predicts a segment file NAME must sample the date from the same
 * instant the stream does: sampling `new Date()` independently makes the
 * expected and produced names disagree on a run that straddles UTC midnight.
 */
function pinClock(atMs: number = FIXED_CLOCK): string {
  vi.useFakeTimers();
  vi.setSystemTime(atMs);
  return new Date(atMs).toISOString().slice(0, 10);
}

/** Builds the segment file name the stream uses for a date and sequence. */
function segmentName(datePrefix: string, sequence: number): string {
  return `${datePrefix}-${String(sequence).padStart(4, "0")}.jsonl`;
}

/** Lists directory entries, sorted so "highest-numbered" ordering holds. */
async function listSegments(dir: string): Promise<string[]> {
  const names = await readdir(dir);
  return [...names].sort();
}

/** Returns `value`, or throws — used in place of a forbidden `!` assertion. */
function definedOrThrow<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`expected ${label} to be defined`);
  }
  return value;
}

/** Awaits `run` and returns whatever it rejected with, or `undefined`. */
async function catchRejected(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** Asserts the append-failure vocabulary and returns the typed error. */
function expectStreamWriteError(thrown: unknown): M3LAppendOnlyStreamError {
  expect(thrown).toBeInstanceOf(M3LAppendOnlyStreamError);
  expect(thrown).toBeInstanceOf(M3LError);
  const error = thrown as M3LAppendOnlyStreamError;
  expect(error.code).toBe("ERR_APPEND_ONLY_STREAM_WRITE");
  return error;
}

/** Asserts the directory is absent, or holds nothing but empty files. */
async function expectNothingWritten(dir: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    // ENOENT is the strongest possible outcome: nothing was ever created.
    return;
  }
  for (const name of names) {
    expect(await readFile(path.join(dir, name), "utf8")).toBe("");
  }
}

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "m3l-append-only-hardening-"));
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(workDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// A planted link at the next segment path is refused, whichever kind it is
// ---------------------------------------------------------------------------

describe("planted-link refusal", () => {
  test("refuses to append into a hardlink planted at the next segment path and leaves the linked file byte-for-byte unchanged", async () => {
    const today = pinClock();
    const dir = path.join(workDir, "audit");
    const outsideDir = path.join(workDir, "outside");
    await mkdir(dir, { recursive: true });
    await mkdir(outsideDir, { recursive: true });

    // A file the attacker owns, OUTSIDE the stream's directory. Non-empty on
    // purpose: a "still byte-for-byte identical" assertion over an empty file
    // would also hold if the stream had truncated it.
    const victim = path.join(outsideDir, "attacker-owned.jsonl");
    const seeded = '{"owner":"attacker"}\n';
    await writeFile(victim, seeded, "utf8");

    // The stream's very next segment on a cold start of an empty directory —
    // planted as a second directory entry for the attacker's inode. `stat`
    // reports the target's real size, and `open` succeeds: one inode, two
    // names, no symlink for `O_NOFOLLOW` to refuse.
    const planted = path.join(dir, segmentName(today, 1));
    await link(victim, planted);
    // Guards the fixture itself: without this, a `link` that silently
    // degraded (a filesystem refusing cross-directory links) would leave the
    // test asserting nothing about hardlinks at all.
    expect((await stat(planted)).nlink).toBe(2);
    const before = await readFile(victim);

    const stream = new M3LAppendOnlyStream({ directory: dir });
    const thrown = await catchRejected(() =>
      stream.append({
        event: "approval.granted",
        secret: "TENANT-ACME-PAYLOAD",
      }),
    );

    // The whole finding: today this append RESOLVES and the record lands in
    // the attacker's file. The trail must fail loudly instead — a segment
    // path with more than one name is not a segment this stream owns.
    expectStreamWriteError(thrown);
    expect(await readFile(victim)).toEqual(before);
    expect(await readFile(victim, "utf8")).toBe(seeded);
  });

  test("refuses to append through a symlink planted at the next segment path and leaves its target untouched", async () => {
    // Companion to the hardlink test above and to the sibling file's fuller
    // version: the fix for the hardlink case replaces the one-shot
    // `appendFile` with an `open`-and-write, which is exactly the call the
    // existing `O_NOFOLLOW` refusal rides on. Both refusals are asserted
    // here so a regression in either shows up in one place.
    const today = pinClock();
    const dir = path.join(workDir, "audit");
    const outsideDir = path.join(workDir, "outside");
    await mkdir(dir, { recursive: true });
    await mkdir(outsideDir, { recursive: true });

    const target = path.join(outsideDir, "victim.jsonl");
    await writeFile(target, "", "utf8");
    await symlink(target, path.join(dir, segmentName(today, 1)));

    const stream = new M3LAppendOnlyStream({ directory: dir });
    const thrown = await catchRejected(() =>
      stream.append({ event: "must-not-follow" }),
    );

    expectStreamWriteError(thrown);
    expect(await readFile(target, "utf8")).toBe("");
    expect((await stat(target)).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Restrictive creation modes
// ---------------------------------------------------------------------------

describe("restrictive creation modes", () => {
  // Skipped on Windows, where the POSIX permission bits `mode` reports are
  // not the access control that is actually in force.
  test.skipIf(process.platform === "win32")(
    "creates the stream directory 0o700 and every segment 0o600",
    async () => {
      const dir = path.join(workDir, "audit");
      const stream = new M3LAppendOnlyStream({ directory: dir });

      await stream.append({ event: "run.started" });

      // An audit trail is the same class of data as a console session
      // artifact, which this repo already creates 0o700/0o600
      // (`m3l-console-server/src/sessions/artifacts.ts`). The process umask
      // can only REMOVE bits from a mode that is passed explicitly, so
      // asserting the exact value is right once it is; today, with no mode
      // passed at all, this reads 0o755/0o644 under a default umask — a
      // world-readable audit trail.
      expect((await stat(dir)).mode & 0o777).toBe(0o700);

      const names = await listSegments(dir);
      const only = definedOrThrow(names[0], "the only segment");
      expect((await stat(path.join(dir, only))).mode & 0o777).toBe(0o600);
    },
  );
});

// ---------------------------------------------------------------------------
// The line ceiling refuses an oversized value in the documented vocabulary
// ---------------------------------------------------------------------------

describe("oversize values", () => {
  test("refuses an entry whose single string value exceeds maxLineBytes with the documented typed error, never a raw RangeError", async () => {
    // REGRESSION LOCK, not a proof of the fix: at this fixture size the
    // shipped code already reaches the post-serialization ceiling check and
    // raises the right error, so this test passes before the pre-check lands.
    // Its job is to pin the VOCABULARY across that change — the cheap
    // pre-check must refuse an oversized string in the same terms the
    // expensive path does, rather than inventing a new error or letting the
    // engine's own `RangeError: Invalid string length` escape unwrapped
    // (`code: undefined`, neither `M3LError` nor `M3LAppendOnlyStreamError`,
    // and absent from `append`'s `@throws`). Discriminating the escape
    // directly would need a value past the engine's maximum string length —
    // hundreds of megabytes of fixture for one assertion, which is not worth
    // its cost in the suite.
    const dir = path.join(workDir, "audit");
    const maxLineBytes = 4096;
    const stream = new M3LAppendOnlyStream({ directory: dir, maxLineBytes });
    const oversized: M3LAppendOnlyEntry = {
      event: "approval.granted",
      payload: "x".repeat(400_000),
    };

    const thrown = await catchRejected(() => stream.append(oversized));

    expectStreamWriteError(thrown);
    expect(thrown).not.toBeInstanceOf(RangeError);
    // Refused before any filesystem call: nothing was created at all.
    await expectNothingWritten(dir);

    // And the stream is still usable afterwards — one refused entry is not a
    // failure of the trail.
    await stream.append({ event: "run.finished" });
    const names = await listSegments(dir);
    const only = definedOrThrow(names[0], "the only segment");
    const lines = (await readFile(path.join(dir, only), "utf8"))
      .split("\n")
      .filter((line) => line.length > 0);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(definedOrThrow(lines[0], "the only line"))).toEqual({
      event: "run.finished",
    });
  });
});
