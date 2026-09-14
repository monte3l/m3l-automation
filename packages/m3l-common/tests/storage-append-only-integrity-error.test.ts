/**
 * Tests for `M3LAppendOnlyStreamIntegrityError` (X8b slice 4d, unit 2a) — the
 * dedicated error class for a sealed segment whose bytes no longer digest to
 * the `sha256` the seal recorded, raised inline by
 * `M3LAppendOnlyStream.read()` once unit 2b wires the reader.
 *
 * This unit ships the class and its code ONLY: the reader wiring is unit 2b,
 * so nothing here exercises `read()`.
 *
 * Why a new class rather than reusing X8b4c's
 * `M3LAppendOnlyStreamManifestError`: that class's `code` is fixed at
 * `"ERR_APPEND_ONLY_STREAM_MANIFEST"` and cannot be overridden, and its
 * `context` is an untyped `Record<string, unknown>` — so "this date was
 * archived per ADR-0070's sanctioned procedure" (a compliance escalation over
 * a segment that is legitimately gone) and "these bytes are not the bytes
 * that were sealed" (tampering or corruption over a segment that is still
 * there) would be distinguishable only by message text. `instanceof` is the
 * discriminator, so this file pins it in BOTH directions rather than assuming
 * two distinct classes are distinct by construction.
 *
 * This file mirrors `storage-append-only-manifest-error.test.ts`'s register
 * section for section: (A) the class contract, (B) the code + catalog
 * registration including sorted tuple position. It adds (C) the `context`
 * payload shape unit 2b must carry, so that payload cannot quietly change.
 *
 * @packageDocumentation
 */

import { describe, expect, expectTypeOf, test } from "vitest";

import { M3LError, M3L_ERROR_CODES } from "../src/core/errors/index.js";
import {
  classifyErrorCode,
  isM3LErrorCode,
} from "../src/core/errors/catalog.js";
import {
  M3LAppendOnlyStreamError,
  M3LAppendOnlyStreamIntegrityError,
  M3LAppendOnlyStreamManifestError,
  M3LAppendOnlyStreamReadError,
} from "../src/core/storage/index.js";
import type {
  M3LAppendOnlySealedSegment,
  M3LAppendOnlySegmentMeasurement,
} from "../src/core/storage/index.js";

// ---------------------------------------------------------------------------
// A — The error class contract
// ---------------------------------------------------------------------------

describe("M3LAppendOnlyStreamIntegrityError — class contract", () => {
  test("is an instance of Error, M3LError, and itself", () => {
    const error = new M3LAppendOnlyStreamIntegrityError("digest mismatch");
    // The `M3LError` arm is the load-bearing one: a caller's existing
    // `catch (e) { if (e instanceof M3LError) … }` must keep seeing this
    // failure once unit 2b starts throwing it out of `read()`.
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(M3LError);
    expect(error).toBeInstanceOf(M3LAppendOnlyStreamIntegrityError);
  });

  test("code is ERR_APPEND_ONLY_STREAM_INTEGRITY at runtime", () => {
    const error = new M3LAppendOnlyStreamIntegrityError("digest mismatch");
    expect(error.code).toBe("ERR_APPEND_ONLY_STREAM_INTEGRITY");
  });

  test("code narrows to the exact literal type, not string and not the wide M3LErrorCode union", () => {
    // `toEqualTypeOf` is an EXACT equality check, so this single assertion
    // already proves the narrower claim too: if `code` were the wide
    // `string` type, or the wide `M3LErrorCode` union, it would not be
    // exactly equal to the single literal below and this line would fail.
    expectTypeOf<
      M3LAppendOnlyStreamIntegrityError["code"]
    >().toEqualTypeOf<"ERR_APPEND_ONLY_STREAM_INTEGRITY">();
  });

  test("name is the subclass name, so a log sink that reports `name` names this incident", () => {
    const error = new M3LAppendOnlyStreamIntegrityError("digest mismatch");
    expect(error.name).toBe("M3LAppendOnlyStreamIntegrityError");
  });

  test("message passes through verbatim", () => {
    const error = new M3LAppendOnlyStreamIntegrityError(
      "append-only stream: a sealed segment no longer matches its recorded digest",
    );
    expect(error.message).toBe(
      "append-only stream: a sealed segment no longer matches its recorded digest",
    );
  });

  test("context passes through when given", () => {
    const error = new M3LAppendOnlyStreamIntegrityError("digest mismatch", {
      context: { sealedByteLength: 4_096 },
    });
    expect(error.context).toEqual({ sealedByteLength: 4_096 });
  });

  test("context defaults to an empty object when not given", () => {
    const error = new M3LAppendOnlyStreamIntegrityError("digest mismatch");
    expect(error.context).toEqual({});
  });

  test("cause chains when given", () => {
    const underlying = new Error("EIO");
    const error = new M3LAppendOnlyStreamIntegrityError("digest mismatch", {
      cause: underlying,
    });
    expect(error.cause).toBe(underlying);
  });

  test("cause is undefined when not given", () => {
    const error = new M3LAppendOnlyStreamIntegrityError("digest mismatch");
    expect(error.cause).toBeUndefined();
  });

  test("cause is an OWN property, never inherited from the prototype", () => {
    // `packages/m3l-console-server/src/boot/audit-rebuild.ts` walks a cause
    // chain with `Object.hasOwn(link, "cause")`, so a class that exposed
    // `cause` through an accessor on its prototype would silently terminate
    // that walk one link early — the wrapped filesystem/digest failure would
    // never reach the rebuild's report. `Core.M3LError` installs it with an
    // unconditional `this.cause = options.cause`, so a subclass gets the own
    // property for free; this asserts the subclass did not undo that.
    const underlying = new Error("EIO");
    const error = new M3LAppendOnlyStreamIntegrityError("digest mismatch", {
      cause: underlying,
    });
    expect(Object.hasOwn(error, "cause")).toBe(true);
    // Every prototype in the chain, not just the immediate one: an accessor
    // installed anywhere above the instance would answer reads while leaving
    // `Object.hasOwn(link, "cause")` false on the instance itself.
    for (const prototype of [
      M3LAppendOnlyStreamIntegrityError.prototype,
      M3LError.prototype,
      Error.prototype,
    ]) {
      expect(Object.hasOwn(prototype, "cause")).toBe(false);
    }
  });

  test("the options bag cannot carry a code — it is set automatically and cannot be overridden", () => {
    // Constructed through an `unknown` seam (mirrors
    // `storage-append-only-manifest-error.test.ts`'s equivalent test) so an
    // options bag carrying a field the static type does not declare
    // (`code`) can reach the constructor at runtime without a
    // `@ts-expect-error` directive — a directive here would need to flip
    // between RED (the class does not exist, so nothing type-errors) and
    // GREEN (the real, `code`-less options type rejects it), which a
    // suppression comment cannot straddle.
    const attemptedOverride: unknown = {
      code: "ERR_APPEND_ONLY_STREAM_MANIFEST",
    };
    const withAttemptedOverride = new M3LAppendOnlyStreamIntegrityError(
      "digest mismatch",
      attemptedOverride as ConstructorParameters<
        typeof M3LAppendOnlyStreamIntegrityError
      >[1],
    );
    expect(withAttemptedOverride.code).toBe("ERR_APPEND_ONLY_STREAM_INTEGRITY");
  });

  test("toJSON carries the class's own name, code, context and cause projection", () => {
    const underlying = new Error("EIO");
    const error = new M3LAppendOnlyStreamIntegrityError("digest mismatch", {
      context: { sealedByteLength: 4_096 },
      cause: underlying,
    });
    const json = error.toJSON();
    expect(json.name).toBe("M3LAppendOnlyStreamIntegrityError");
    expect(json.code).toBe("ERR_APPEND_ONLY_STREAM_INTEGRITY");
    expect(json.message).toBe("digest mismatch");
    expect(json.context).toEqual({ sealedByteLength: 4_096 });
    // Name-only, and `toEqual` rather than `toMatchObject`, on purpose — this
    // is NOT an oversight to "improve" by adding `message` back. `M3LError`'s
    // `resolveCauseForJSON` allowlists a FOREIGN (non-`M3LError`) cause down
    // to `{ name }`, because a foreign error's `message` routinely embeds the
    // path it failed on — the very leak this class's own message and
    // `context` are kept clear of. The exact-equality form is what pins that:
    // `toMatchObject` would keep passing if a future change started emitting
    // `message` alongside `name`, i.e. it cannot fail in the only direction
    // worth guarding. Matches `errors.test.ts`'s two equivalent assertions.
    expect(json.cause).toEqual({ name: "Error" });
  });

  test("toJSON resolves origin:external and retryable:false from the catalog", () => {
    // A mismatched digest is never fixed by trying again — the same bytes
    // hash to the same value — so the classification must not advertise a
    // retry, and it is external (the trail's directory) rather than a caller
    // mistake. This asserts the class's `code` actually resolves through the
    // catalog, which a code registered in the tuple but omitted from
    // `M3L_ERROR_CATALOG` would fail with `undefined` on both fields.
    const error = new M3LAppendOnlyStreamIntegrityError("digest mismatch");
    const json = error.toJSON();
    expect(json.origin).toBe("external");
    expect(json.retryable).toBe(false);
  });

  test("instanceof discriminates from M3LAppendOnlyStreamManifestError in BOTH directions", () => {
    // The whole point of this unit: X8b4c's archival escalation and this
    // slice's digest mismatch both surface out of `read()`, and a caller
    // must be able to tell "this date was archived per the sanctioned
    // procedure" from "these bytes are not the bytes that were sealed"
    // without parsing a message string. Asserting only one direction would
    // still pass if one class were made a subclass of the other.
    const integrity = new M3LAppendOnlyStreamIntegrityError("digest mismatch");
    const manifest = new M3LAppendOnlyStreamManifestError("manifest failed");

    expect(integrity).not.toBeInstanceOf(M3LAppendOnlyStreamManifestError);
    expect(manifest).not.toBeInstanceOf(M3LAppendOnlyStreamIntegrityError);

    expect(integrity.code).toBe("ERR_APPEND_ONLY_STREAM_INTEGRITY");
    expect(manifest.code).toBe("ERR_APPEND_ONLY_STREAM_MANIFEST");
  });

  test("is a DISTINCT class from M3LAppendOnlyStreamReadError and M3LAppendOnlyStreamError", () => {
    const error = new M3LAppendOnlyStreamIntegrityError("digest mismatch");
    expect(error).not.toBeInstanceOf(M3LAppendOnlyStreamReadError);
    expect(error).not.toBeInstanceOf(M3LAppendOnlyStreamError);
  });
});

// ---------------------------------------------------------------------------
// B — Code and catalog registration
// ---------------------------------------------------------------------------

/**
 * The four `ERR_APPEND_ONLY_STREAM_*` codes, declared as an `as const` tuple
 * by hand so the classification assertion below has one side pinned
 * independently of the tuple under test.
 */
const APPEND_ONLY_STREAM_CODES = [
  "ERR_APPEND_ONLY_STREAM_INTEGRITY",
  "ERR_APPEND_ONLY_STREAM_MANIFEST",
  "ERR_APPEND_ONLY_STREAM_READ",
  "ERR_APPEND_ONLY_STREAM_WRITE",
] as const;

describe("ERR_APPEND_ONLY_STREAM_INTEGRITY — registration", () => {
  test("is a member of M3L_ERROR_CODES", () => {
    expect(M3L_ERROR_CODES).toContain("ERR_APPEND_ONLY_STREAM_INTEGRITY");
  });

  test("isM3LErrorCode recognizes it", () => {
    expect(isM3LErrorCode("ERR_APPEND_ONLY_STREAM_INTEGRITY")).toBe(true);
  });

  test("catalog entry is exactly { origin: 'external', retryable: false }", () => {
    expect(classifyErrorCode("ERR_APPEND_ONLY_STREAM_INTEGRITY")).toEqual({
      origin: "external",
      retryable: false,
    });
  });

  test.each(APPEND_ONLY_STREAM_CODES)(
    "%s classifies identically to its append-only siblings",
    (code) => {
      // The new code must not become the one member of this family that
      // classifies differently — enumerated rather than asserted once, so
      // the claim "matching its three siblings" is actually exercised over
      // all four.
      expect(classifyErrorCode(code)).toEqual({
        origin: "external",
        retryable: false,
      });
    },
  );

  test("sorts immediately before ERR_APPEND_ONLY_STREAM_MANIFEST in the tuple (I before M)", () => {
    // Nothing else in the repo enforces that `M3L_ERROR_CODES` is
    // alphabetically sorted — there is no `bin/check-*` gate for it and
    // `errors.test.ts`'s source-scan guard compares SETS, so it is blind to
    // order. This adjacency pin is the only thing that notices a code
    // appended to the end of the tuple instead of inserted in place.
    const codes: readonly string[] = M3L_ERROR_CODES;
    const integrityIndex = codes.indexOf("ERR_APPEND_ONLY_STREAM_INTEGRITY");
    const manifestIndex = codes.indexOf("ERR_APPEND_ONLY_STREAM_MANIFEST");
    expect(integrityIndex).toBeGreaterThanOrEqual(0);
    expect(manifestIndex).toBeGreaterThanOrEqual(0);
    expect(integrityIndex).toBe(manifestIndex - 1);
  });
});

// ---------------------------------------------------------------------------
// C — The `context` payload unit 2b will carry
//
// The pair a mismatch is expressed in is already fixed by `verify()`'s
// `"mismatched"` verdict: `sealed: M3LAppendOnlySealedSegment` (what the seal
// claimed) and `observed: M3LAppendOnlySegmentMeasurement` (what re-digesting
// the bytes actually found). Pinning that the same pair survives this class's
// `context` intact is what stops unit 2b quietly choosing a different — or
// lossier — payload.
// ---------------------------------------------------------------------------

/** What the seal recorded. 64 lowercase hex characters, per the contract. */
const SEALED: M3LAppendOnlySealedSegment = {
  segment: "2026-09-11-0001.jsonl",
  at: "2026-09-11T01:00:00.000Z",
  entryCount: 3,
  byteLength: 128,
  sha256: "a".repeat(64),
};

/** What re-digesting the segment actually found — a different digest. */
const OBSERVED: M3LAppendOnlySegmentMeasurement = {
  entryCount: 3,
  byteLength: 128,
  sha256: "b".repeat(64),
};

describe("M3LAppendOnlyStreamIntegrityError — the mismatch payload in context", () => {
  test("a { sealed, observed } context survives intact, field for field", () => {
    const error = new M3LAppendOnlyStreamIntegrityError("digest mismatch", {
      context: { sealed: SEALED, observed: OBSERVED },
    });
    expect(error.context).toEqual({ sealed: SEALED, observed: OBSERVED });
  });

  test("BOTH digests are readable back, against hand-written literals", () => {
    // The `toEqual` above compares the context to the same fixture objects
    // that built it, so one side of that check is not independent. These
    // expected values are written out by hand instead — the two digests are
    // what an operator acts on, so "which value disagreed" has to be
    // recoverable from the error, not just "something disagreed".
    const error = new M3LAppendOnlyStreamIntegrityError("digest mismatch", {
      context: { sealed: SEALED, observed: OBSERVED },
    });
    expect(error.context).toMatchObject({
      sealed: {
        segment: "2026-09-11-0001.jsonl",
        at: "2026-09-11T01:00:00.000Z",
        entryCount: 3,
        byteLength: 128,
        // Built at runtime rather than written as one 64-character source
        // literal (gitleaks scans source text), but still an expectation
        // written independently of the `SEALED` fixture above.
        sha256: "a".repeat(64),
      },
      observed: {
        entryCount: 3,
        byteLength: 128,
        sha256: "b".repeat(64),
      },
    });
  });

  test("the payload survives toJSON, which is what a log sink actually reports", () => {
    // `context` is carried through `toJSON` verbatim (unlike `cause`, which
    // is allowlisted), so the pair is still recoverable from the serialized
    // record a diagnostics sink or the console server's audit rebuild
    // persists — not only from the live instance.
    const error = new M3LAppendOnlyStreamIntegrityError(
      "append-only stream: a sealed segment no longer matches its recorded digest",
      { context: { sealed: SEALED, observed: OBSERVED } },
    );
    const roundTripped: unknown = JSON.parse(JSON.stringify(error.toJSON()));
    expect(roundTripped).toMatchObject({
      code: "ERR_APPEND_ONLY_STREAM_INTEGRITY",
      context: { sealed: SEALED, observed: OBSERVED },
    });
  });
});
