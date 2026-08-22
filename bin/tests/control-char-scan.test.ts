import { describe, expect, test } from "vitest";
import {
  BINARY_EXTENSIONS,
  scanControlChars,
} from "../lib/control-char-scan.mjs";
import {
  readCandidates,
  runControlCharCheck,
} from "../check-control-chars.mjs";

// The scanner is pure, so it is driven with synthetic byte payloads rather than
// the live repo — `.claude/rules/tests.md` requires exactly this of a `bin/`
// checker, because a gate exercised only against today's tree cannot be shown
// to fire on the input that will exist tomorrow. The whole reason this gate
// exists is that four NUL bytes passed every other check for three pushes.

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

interface FakeReporter {
  errors: string[];
  warnings: string[];
  infos: string[];
  changes: { kind: string; file: string }[];
  succeeded: string[];
  finishedWith: Record<string, unknown>;
  error: (message: string) => void;
  warn: (message: string) => void;
  info: (message: string) => void;
  change: (
    kind: "updated" | "created" | "removed",
    file: string,
    note?: string,
  ) => void;
  succeed: (message: string) => void;
  finish: (extra?: Record<string, unknown>) => Record<string, unknown>;
}

function createFakeReporter(): FakeReporter {
  const reporter: FakeReporter = {
    errors: [],
    warnings: [],
    infos: [],
    changes: [],
    succeeded: [],
    finishedWith: {},
    error(message) {
      reporter.errors.push(message);
    },
    warn(message) {
      reporter.warnings.push(message);
    },
    info(message) {
      reporter.infos.push(message);
    },
    change(kind, file) {
      reporter.changes.push({ kind, file });
    },
    succeed(message) {
      reporter.succeeded.push(message);
    },
    finish(extra = {}) {
      reporter.finishedWith = extra;
      return { ...extra };
    },
  };
  return reporter;
}

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(`control-char-scan.test.ts: expected ${what}`);
  }
  return value;
}

describe("scanControlChars", () => {
  test("ordinary source with tabs and newlines reports nothing", () => {
    expect(
      scanControlChars([
        { path: "a.ts", bytes: bytes('const x = 1;\n\tconst y = "ok";\n') },
      ]),
    ).toEqual([]);
  });

  test("a literal NUL is reported with its line, column and the escape to use", () => {
    // The exact incident: a NUL inside a string literal, in a file that
    // otherwise looks completely normal.
    const finding = required(
      scanControlChars([
        { path: "hub-view-drift.mjs", bytes: bytes('a.join("\x00")') },
      ])[0],
      "finding",
    );

    expect(finding).toContain("hub-view-drift.mjs");
    expect(finding).toContain("line 1, column 9");
    expect(finding).toContain("0x00");
    // The remedy is mechanical and must be stated, not left to be re-derived.
    expect(finding).toContain("`\\x00`");
    // And the reason it matters at all.
    expect(finding).toMatch(/binary to git/);
  });

  test.each([
    ["NUL", "\x00", "0x00", "\\x00"],
    ["DEL", "\x7f", "0x7f", "\\x7f"],
    ["ESC", "\x1b", "0x1b", "\\x1b"],
    ["vertical tab", "\x0b", "0x0b", "\\x0b"],
    ["form feed", "\x0c", "0x0c", "\\x0c"],
    ["carriage return", "\r", "0x0d", "\\x0d"],
  ])("a literal %s is caught and named", (_label, char, hex, escape) => {
    const finding = required(
      scanControlChars([{ path: "f.ts", bytes: bytes(`x = "${char}"`) }])[0],
      "finding",
    );
    expect(finding).toContain(hex);
    expect(finding).toContain(`\`${escape}\``);
  });

  test("an ESCAPED control character is not a finding — that is the whole point", () => {
    // `"\x00"` is six ASCII characters and byte-identical at runtime. If this
    // were flagged the gate would have no legitimate spelling to offer, and
    // would need an allowlist that rots.
    expect(
      scanControlChars([
        { path: "f.ts", bytes: bytes(String.raw`const s = "\x00\x1b\x7f";`) },
      ]),
    ).toEqual([]);
  });

  test("line and column count correctly across multiple lines", () => {
    const finding = required(
      scanControlChars([
        { path: "f.ts", bytes: bytes("line one\nline two\nab\x00cd\n") },
      ])[0],
      "finding",
    );
    expect(finding).toContain("line 3, column 3");
  });

  test("one finding per FILE, not per byte, and the detail list is capped", () => {
    const many = "x\x00".repeat(40);
    const findings = scanControlChars([{ path: "f.ts", bytes: bytes(many) }]);

    expect(findings).toHaveLength(1);
    const finding = required(findings[0], "finding");
    expect(finding).toContain("40 literal control byte(s)");
    // Five enumerated, the rest summarised — a hundred coordinates help nobody.
    expect(finding).toContain("(+35 more)");
  });

  test("multiple offending files each get their own finding", () => {
    expect(
      scanControlChars([
        { path: "a.ts", bytes: bytes("a\x00") },
        { path: "b.ts", bytes: bytes("b") },
        { path: "c.ts", bytes: bytes("c\x07") },
      ]),
    ).toHaveLength(2);
  });

  test("an empty file is clean, not an error", () => {
    expect(
      scanControlChars([{ path: "empty.ts", bytes: new Uint8Array() }]),
    ).toEqual([]);
  });

  test("multi-byte UTF-8 above 0x7f is never flagged", () => {
    // Continuation bytes are >= 0x80; flagging them would make every accented
    // character or emoji a finding.
    expect(
      scanControlChars([
        { path: "f.md", bytes: bytes("— naïve café 🚀 日本語") },
      ]),
    ).toEqual([]);
  });
});

describe("readCandidates", () => {
  test("skips binary extensions case-insensitively and keeps everything else", () => {
    const { files, errors } = readCandidates(
      ["a.ts", "img.PNG", "sheet.xlsx", "doc.md", "f.woff2"],
      () => bytes("ok"),
    );

    expect(files.map((file) => file.path)).toEqual(["a.ts", "doc.md"]);
    expect(errors).toEqual([]);
  });

  test("an unreadable file is REPORTED, never skipped silently", () => {
    const { files, errors } = readCandidates(["good.ts", "bad.ts"], (path) => {
      if (path === "bad.ts") throw new Error("EACCES: permission denied");
      return bytes("ok");
    });

    expect(files.map((file) => file.path)).toEqual(["good.ts"]);
    expect(errors).toHaveLength(1);
    expect(required(errors[0], "error")).toMatch(/EACCES/);
    // A gate that quietly stops covering a file is the failure mode this whole
    // change set is about.
    expect(required(errors[0], "error")).toMatch(/Not skipping silently/);
  });

  test("BINARY_EXTENSIONS covers the fixture formats actually committed here", () => {
    // packages/m3l-common/tests/fixtures/text/ carries real .xlsx and .docx
    // office documents; without these entries the gate is permanently red.
    for (const extension of [".xlsx", ".docx", ".png"]) {
      expect(BINARY_EXTENSIONS.has(extension)).toBe(true);
    }
  });
});

describe("runControlCharCheck", () => {
  const clean = { "a.ts": "const a = 1;\n", "b.md": "# ok\n" };

  function seams(contents: Record<string, string>) {
    const paths = Object.keys(contents);
    return {
      runGit: () => paths.join("\0"),
      readFile: (path: string) =>
        bytes(required(contents[path], `contents for ${path}`)),
    };
  }

  test("a clean tree passes and reports the scanned/binary split", () => {
    const reporter = createFakeReporter();
    const outcome = runControlCharCheck({ ...seams(clean), reporter });

    expect(outcome).toMatchObject({ ok: true, findings: [], scanned: 2 });
    expect(reporter.errors).toEqual([]);
    expect(required(reporter.succeeded[0], "success")).toContain(
      "2 tracked text file(s)",
    );
  });

  test("a literal control byte fails the gate and returns the finding", () => {
    const reporter = createFakeReporter();
    const outcome = runControlCharCheck({
      ...seams({ "a.ts": 'x = "\x00";\n' }),
      reporter,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.findings).toHaveLength(1);
    expect(reporter.errors).toHaveLength(1);
    expect(reporter.finishedWith).toMatchObject({ scanned: 1 });
  });

  test("NUL-delimited parsing survives a filename containing a newline", () => {
    // `git ls-files -z` exists precisely for this; splitting on \n would turn
    // one path into two unreadable ones.
    const reporter = createFakeReporter();
    const weird = "dir/we\nird.ts";
    const outcome = runControlCharCheck({
      runGit: () => `a.ts\0${weird}\0`,
      readFile: () => bytes("clean\n"),
      reporter,
    });

    expect(outcome).toMatchObject({ ok: true, scanned: 2 });
  });

  test("an empty tracked list fails rather than reporting a clean scan of nothing", () => {
    // The vacuous-pass shape: zero files scanned would otherwise read as green.
    const reporter = createFakeReporter();
    const outcome = runControlCharCheck({
      runGit: () => "",
      readFile: () => bytes(""),
      reporter,
    });

    expect(outcome).toMatchObject({ ok: false, scanned: 0 });
    expect(required(reporter.errors[0], "error")).toMatch(
      /refusing to report a clean scan of nothing/,
    );
  });

  test("a git failure fails the gate with the cause, and never passes", () => {
    const reporter = createFakeReporter();
    const outcome = runControlCharCheck({
      runGit: () => {
        throw new Error("not a git repository");
      },
      readFile: () => bytes(""),
      reporter,
    });

    expect(outcome.ok).toBe(false);
    expect(required(reporter.errors[0], "error")).toMatch(
      /not a git repository/,
    );
  });

  test("every finish() payload carries findings and scanned", () => {
    for (const seam of [
      seams(clean),
      seams({ "a.ts": 'x = "\x00";' }),
      { runGit: () => "", readFile: () => bytes("") },
    ]) {
      const reporter = createFakeReporter();
      runControlCharCheck({ ...seam, reporter });
      expect(reporter.finishedWith).toHaveProperty("findings");
      expect(reporter.finishedWith).toHaveProperty("scanned");
    }
  });
});
