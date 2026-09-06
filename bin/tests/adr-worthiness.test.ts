import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { deriveWorthinessCandidates } from "../lib/adr-worthiness.mjs";

// bin/check-adr-worthiness.mjs computes `root` via repoRoot(import.meta.url)
// from its own location (bin/check-adr-worthiness.mjs), i.e. the repo root.
// This test file lives one directory deeper (bin/tests/), so the same repo
// root needs one extra dirname() hop from here — mirrors
// bin/tests/adr-claims.test.ts's pattern.
const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

// ---------------------------------------------------------------------------
// deriveWorthinessCandidates
// ---------------------------------------------------------------------------
//
// The old (removed) design flagged any no-semver-impact ADR unless it
// mentioned a "worthy" phrase from a finite list. That mechanism no longer
// exists. The new design flags narrowly: a Consequences section declaring
// `Semver impact: none` AND a title/Consequences match against a small,
// literal set of low-value shapes (retitle; rename ... label|milestone;
// widen ... zone ... module). See bin/lib/adr-worthiness.mjs's header
// comment for the full rationale.

describe("deriveWorthinessCandidates", () => {
  test("flags an ADR whose title matches the retitle shape with no semver impact", () => {
    const candidates = [
      {
        filename: "0099-retitle-a-label.md",
        content:
          "# 0099. Retitle a label\n\n## Consequences\n\n- **Semver impact:** none\n",
      },
    ];
    expect(deriveWorthinessCandidates(candidates)).toEqual([
      "0099-retitle-a-label.md",
    ]);
  });

  test("flags an ADR whose Consequences text (not the title) matches the rename+milestone shape", () => {
    const candidates = [
      {
        filename: "0100-milestone-rename.md",
        content:
          "# 0100. Adjust the milestone identifier\n\n## Consequences\n\nThis is just renaming a milestone label used in status reports.\n\n- **Semver impact:** none\n",
      },
    ];
    expect(deriveWorthinessCandidates(candidates)).toEqual([
      "0100-milestone-rename.md",
    ]);
  });

  test("flags an ADR whose Consequences text matches the widen-zone-module shape", () => {
    const candidates = [
      {
        filename: "0101-widen-lint-zone.md",
        content:
          "# 0101. Adjust lint coverage\n\n## Consequences\n\nThis widens the lint zone to admit a single module previously excluded.\n\n- **Semver impact:** none\n",
      },
    ];
    expect(deriveWorthinessCandidates(candidates)).toEqual([
      "0101-widen-lint-zone.md",
    ]);
  });

  test("does not flag a no-semver-impact ADR whose text matches no low-value shape anywhere (precision over recall — no worthy-phrase exemption exists anymore)", () => {
    const candidates = [
      {
        filename: "0102-mundane-no-shape.md",
        content:
          "# 0102. Document the retry backoff\n\n## Consequences\n\nThis clarifies existing behavior with no structural change of any kind.\n\n- **Semver impact:** none\n",
      },
    ];
    expect(deriveWorthinessCandidates(candidates)).toEqual([]);
  });

  test("does not flag an ADR matching a low-value shape whose Consequences declares a non-none semver impact", () => {
    const candidates = [
      {
        filename: "0103-retitle-but-minor.md",
        content:
          "# 0103. Retitle a label\n\n## Consequences\n\n- **Semver impact:** minor\n",
      },
    ];
    expect(deriveWorthinessCandidates(candidates)).toEqual([]);
  });

  test("does not flag an ADR with no Consequences section at all", () => {
    const candidates = [
      {
        filename: "0104-no-consequences.md",
        content:
          "# 0104. Retitle a label\n\n## Context\n\nSome context text with no Consequences heading anywhere in the document.\n",
      },
    ];
    expect(deriveWorthinessCandidates(candidates)).toEqual([]);
  });

  // Regression test for the section-scoping bug: SEMVER_NONE_RE must only
  // match within the ADR's OWN `## Consequences` section, never a quoted or
  // discussed `- **Semver impact:** none` line appearing in some other
  // section (e.g. `## Context`, quoting/discussing a different ADR). This
  // guards against the `/m`-flag regex class of bug that made an earlier
  // draft of section() always return "" (and, before that, against a
  // whole-document regex scan that would match the quoted text instead of
  // the ADR's own real field) — see bin/lib/adr-index.mjs's headerBlock()
  // for the sibling fix this mirrors. The Context section here quotes
  // another ADR's none-impact line, and the candidate's OWN Consequences
  // section declares a real, non-none impact and doesn't match a low-value
  // shape — if SEMVER_NONE_RE were scanning the whole document instead of
  // just Consequences, this candidate would be wrongly flagged.
  test("[section-scoping regression] does not flag when a quoted 'Semver impact: none' line appears only in Context, not in the ADR's own Consequences", () => {
    const candidates = [
      {
        filename: "0105-quotes-another-adr.md",
        content:
          "# 0105. Retitle a label for consistency\n\n" +
          "## Context\n\n" +
          "ADR-0074 previously declared - **Semver impact:** none for a similar rename.\n\n" +
          "## Consequences\n\n" +
          "- **Semver impact:** minor\n",
      },
    ];
    expect(deriveWorthinessCandidates(candidates)).toEqual([]);
  });

  test("is case-insensitive on the semver-none phrase when paired with a matching shape", () => {
    const candidates = [
      {
        filename: "0106-shouty-case.md",
        content:
          "# 0106. Retitle a label\n\n## Consequences\n\n- **semver impact:** NONE\n",
      },
    ];
    expect(deriveWorthinessCandidates(candidates)).toEqual([
      "0106-shouty-case.md",
    ]);
  });

  test("returns exactly the flagged filenames from a mixed batch, in input order", () => {
    const candidates = [
      {
        filename: "0201-flagged-first.md",
        content:
          "# 0201. Retitle a label\n\n## Consequences\n\n- **Semver impact:** none\n",
      },
      {
        filename: "0202-not-flagged-no-shape.md",
        content:
          "# 0202. Something else entirely\n\n## Consequences\n\nA mundane sentence with no matching shape.\n\n- **Semver impact:** none\n",
      },
      {
        filename: "0203-not-flagged-non-none.md",
        content:
          "# 0203. Retitle a label\n\n## Consequences\n\n- **Semver impact:** major\n",
      },
      {
        filename: "0204-flagged-second.md",
        content:
          "# 0204. Adjust naming\n\n## Consequences\n\nThis is renaming a milestone label.\n\n- **Semver impact:** none\n",
      },
    ];
    expect(deriveWorthinessCandidates(candidates)).toEqual([
      "0201-flagged-first.md",
      "0204-flagged-second.md",
    ]);
  });

  test("returns [] for an empty candidate list", () => {
    expect(deriveWorthinessCandidates([])).toEqual([]);
  });

  // Live-corpus sanity check: the redesign's whole point is precision — flag
  // only the real cases ADR-0095's own Context section cited as audit
  // examples, with zero noise elsewhere in the 95-ADR corpus. This is
  // deliberately a corpus-state assertion, not a property of the heuristic
  // alone — a named allowlist, not an inline literal, so it self-documents
  // WHY each entry is there and doesn't read as an arbitrary snapshot when
  // it next has to change. Two events legitimately grow this list without
  // anything being wrong: the maintainer accepts a new ADR that genuinely
  // matches a low-blast-radius shape (ADR-0095's own design: the gate is
  // advisory, "the maintainer's judgment is final", never a veto), or the
  // shape list itself grows to cover a pattern it doesn't yet enumerate
  // (ADR-0095's Negative/trade-offs bullet names this as expected). Neither
  // case requires editing ADR-0074 or any other accepted ADR — retroactively
  // downgrading an already-Accepted low-value ADR was ADR-0095's own
  // rejected option 3 (ADRs are immutable once accepted, ADR-0094); this
  // list only ever grows to describe the corpus as it stands.
  const KNOWN_ACCEPTED_MATCHES = [
    // A milestone/tier title rename (ADR-0095's own cited audit example).
    // Permanent — see the comment above for why this is never "fixed" by
    // editing ADR-0074 itself.
    "0074-milestone-major-tier-title.md",
  ];

  test("flags exactly the known accepted matches across the live docs/adr/ corpus, nothing else", () => {
    const adrDir = join(root, "docs", "adr");
    const files = readdirSync(adrDir).filter(
      (name) =>
        name.endsWith(".md") && name !== "README.md" && name !== "template.md",
    );
    const candidates = files.map((filename) => ({
      filename,
      content: readFileSync(join(adrDir, filename), "utf8"),
    }));

    expect(deriveWorthinessCandidates(candidates)).toEqual(
      KNOWN_ACCEPTED_MATCHES,
    );
  });
});
