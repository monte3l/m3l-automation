// max-agents: 20
//
// audit-fanout — the ADR-0025 pilot dynamic workflow. Owns the mechanical
// slice of the auditing skill: fan out one read-only Explore agent per audit
// facet (fixed EXISTING/GAP/INCONSISTENCY report format, full report written
// into the run directory, compact digest returned), then adversarially verify
// each GAP/INCONSISTENCY finding with an independent refute agent following
// the security-reviewer refute-mode pattern. The hub keeps the judgment half:
// aggregation, clarifying questions, and plan mode (see
// .claude/skills/auditing/SKILL.md). The tier pins below are enforced against
// the MODEL-MATRIX workflow-script rows by `pnpm check:workflows`, which also
// enforces the max-agents header above (5 finders + 15 refuters = 20 <= 25).
//
// Runtime contract (Workflow tool): agent/parallel/pipeline/phase/log/args/
// budget are ambient globals, and the body runs inside an async function
// scope — the top-level `return` at the bottom is the workflow's result. That
// contract is unparseable as a standard ES module, so eslint.config.js
// ignores this directory; `pnpm check:workflows` is the lint for it.

export const meta = {
  name: "audit-fanout",
  description:
    "Fan out read-only Explore agents over audit facets, then adversarially verify each finding",
  whenToUse:
    "Invoked by the auditing skill (step 2) for its mechanical fan-out + refute slice; the hub keeps aggregation, clarifying questions, and plan mode.",
  phases: [
    {
      title: "Find",
      detail: "one Explore agent per facet, fixed report format",
    },
    {
      title: "Verify",
      detail: "one refute agent per GAP/INCONSISTENCY finding",
    },
  ],
};

// Budget split under the max-agents header: at most 5 facet finders plus at
// most 15 refuters. Findings beyond VERIFY_MAX are returned `unverified` so
// the hub can verify them manually — clamped, never silently dropped.
const FACETS_MAX = 5;
const VERIFY_MAX = 15;
// Below this many remaining turn tokens, skip refutation entirely and hand
// every finding back to the hub — a half-verified audit is worse than an
// honestly unverified one.
const MIN_VERIFY_TOKEN_BUDGET = 50_000;

const DIGEST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["facet", "reportPath", "counts", "items"],
  properties: {
    facet: { type: "string" },
    reportPath: { type: "string" },
    counts: {
      type: "object",
      additionalProperties: false,
      required: ["existing", "gap", "inconsistency"],
      properties: {
        existing: { type: "integer", minimum: 0 },
        gap: { type: "integer", minimum: 0 },
        inconsistency: { type: "integer", minimum: 0 },
      },
    },
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type", "claim", "citedPath"],
        properties: {
          type: { type: "string", enum: ["GAP", "INCONSISTENCY"] },
          claim: { type: "string" },
          citedPath: { type: "string" },
        },
      },
    },
  },
};

const VERDICT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "evidence"],
  properties: {
    verdict: { type: "string", enum: ["confirmed", "refuted"] },
    evidence: { type: "string" },
    note: { type: "string" },
  },
};

function invalidArgs(reason) {
  return new Error(`audit-fanout: invalid args — ${reason}`);
}

// Tolerate a JSON-encoded string (the common caller mistake the Workflow tool
// docs warn about) by parsing before validating.
let parsedArgs = args;
if (typeof parsedArgs === "string") {
  try {
    parsedArgs = JSON.parse(parsedArgs);
  } catch {
    throw invalidArgs("args arrived as a string that is not valid JSON");
  }
}
if (
  parsedArgs === undefined ||
  parsedArgs === null ||
  typeof parsedArgs !== "object"
) {
  throw invalidArgs("expected { topic, runDir, facets }");
}
const { topic, runDir, facets } = parsedArgs;
if (typeof topic !== "string" || topic.length === 0) {
  throw invalidArgs("topic must be a non-empty string");
}
if (typeof runDir !== "string" || runDir.length === 0) {
  throw invalidArgs(
    "runDir must be a non-empty path created by the hub (scripts cannot mint timestamps)",
  );
}
if (!Array.isArray(facets) || facets.length < 1 || facets.length > FACETS_MAX) {
  throw invalidArgs(`facets must be an array of 1..${FACETS_MAX} entries`);
}
// Finders write their report via whatever shell they pick; forward slashes
// survive both PowerShell and Git Bash on Windows, backslashes don't (the
// first live acceptance run lost a report file to separator mangling).
const runDirPosix = runDir.replace(/\\/g, "/");
const seenSlugs = new Set();
for (const facet of facets) {
  if (
    facet === null ||
    typeof facet !== "object" ||
    typeof facet.name !== "string" ||
    facet.name.length === 0 ||
    typeof facet.slug !== "string" ||
    facet.slug.length === 0 ||
    typeof facet.brief !== "string" ||
    facet.brief.length === 0
  ) {
    throw invalidArgs(
      "every facet needs non-empty string name, slug, and brief",
    );
  }
  if (seenSlugs.has(facet.slug)) {
    // Two finders with one slug would clobber the same report file.
    throw invalidArgs(`duplicate facet slug "${facet.slug}"`);
  }
  seenSlugs.add(facet.slug);
}

function findPrompt(facet) {
  return [
    `You are auditing one facet of the topic "${topic}" in the m3l-automation repo (a pnpm/TypeScript monorepo). Repo rules are NOT in your context — the brief below restates everything that matters.`,
    "",
    `Facet: ${facet.name}`,
    "",
    facet.brief,
    "",
    "Method:",
    "- Read the relevant files IN FULL (not just search); excerpts miss content past the read window.",
    `- Write your full findings to exactly this file: ${runDirPosix}/${facet.slug}.md`,
    "- After writing, confirm the file actually exists at that exact path (e.g. list it) before returning your digest — a digest whose report file is missing forces the hub to redo your work.",
    "- Use this report format verbatim in that file:",
    "",
    `  ## Findings: ${facet.name}`,
    "  - EXISTING: <description of what is already in place>",
    "  - GAP: <something absent that would be expected>",
    "  - INCONSISTENCY: <something that conflicts with another part of the repo>",
    "",
    "- Mark an item EXISTING only when you can confirm it is implemented — not merely because you found no evidence of a gap.",
    "- Your structured return value is a compact digest ONLY: the facet name, the report file path, per-type counts, and one entry per GAP or INCONSISTENCY (the claim plus the repo path it cites). Do not restate EXISTING items or the full report.",
  ].join("\n");
}

function refutePrompt(finding) {
  return [
    `Adversarially verify one audit finding about the m3l-automation repo (topic: "${topic}"). Work in refute mode: assume the finding is WRONG and try to disprove it.`,
    "",
    `Finding (${finding.type}, facet "${finding.facet}"): ${finding.claim}`,
    `Cited path: ${finding.citedPath}`,
    `Full facet report for context: ${finding.reportPath}`,
    "",
    "- Hunt for the claimed-missing thing under other names, paths, or conventions (search widely; read candidate files in full).",
    "- For an INCONSISTENCY, check whether the two sides are actually reconciled somewhere (a doc, a config, a generated artifact).",
    '- Return verdict "refuted" with the disproving evidence when refutation succeeds.',
    '- Return verdict "confirmed" ONLY after genuine refutation attempts fail, listing what you checked as the evidence trail.',
    '- Use the optional "note" field for caveats — e.g. the claim is only partially right, or holds on one platform only.',
  ].join("\n");
}

phase("Find");
log(`audit-fanout: ${facets.length} facet(s) on "${topic}"`);
const digests = (
  await parallel(
    facets.map(
      (facet) => () =>
        agent(findPrompt(facet), {
          label: `find:${facet.slug}`,
          phase: "Find",
          agentType: "Explore",
          schema: DIGEST_SCHEMA,
        }),
    ),
  )
)
  // parallel() preserves index alignment (nulls for dead thunks), so stamp
  // each digest's facet linkage from the input array rather than trusting the
  // agent's self-reported facet/reportPath echo.
  .map((digest, index) =>
    digest
      ? {
          ...digest,
          facet: facets[index].name,
          reportPath: `${runDirPosix}/${facets[index].slug}.md`,
        }
      : null,
  )
  .filter(Boolean);

const findings = digests.flatMap((digest) =>
  digest.items.map((item) => ({
    ...item,
    facet: digest.facet,
    reportPath: digest.reportPath,
  })),
);

let toVerify = findings.slice(0, VERIFY_MAX);
const unverified = findings.slice(VERIFY_MAX);
if (budget.total && budget.remaining() < 50_000) {
  unverified.push(...toVerify);
  toVerify = [];
  log("audit-fanout: token budget low — deferring all refutations to the hub");
}
if (unverified.length > 0) {
  log(
    `audit-fanout: ${unverified.length} finding(s) beyond the verify budget — returned unverified for the hub`,
  );
}

phase("Verify");
const verdicts =
  toVerify.length > 0
    ? await pipeline(toVerify, (finding) =>
        agent(refutePrompt(finding), {
          label: "verify",
          phase: "Verify",
          model: "sonnet",
          effort: "medium",
          schema: VERDICT_SCHEMA,
        }),
      )
    : [];

const confirmed = [];
const refuted = [];
verdicts.forEach((verdict, index) => {
  const finding = toVerify[index];
  if (!verdict) {
    // The refuter died or was skipped — never launder that into "confirmed".
    unverified.push(finding);
  } else if (verdict.verdict === "refuted") {
    refuted.push({
      ...finding,
      evidence: verdict.evidence,
      note: verdict.note ?? "",
    });
  } else {
    confirmed.push({
      ...finding,
      evidence: verdict.evidence,
      note: verdict.note ?? "",
    });
  }
});

log(
  `audit-fanout: ${confirmed.length} confirmed, ${refuted.length} refuted, ${unverified.length} unverified`,
);

return {
  topic,
  runDir: runDirPosix,
  facets: digests.map(({ facet, reportPath, counts }) => ({
    facet,
    reportPath,
    counts,
  })),
  confirmed,
  refuted,
  unverified,
};
