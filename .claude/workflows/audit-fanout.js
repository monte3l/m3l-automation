// max-agents: 20
//
// audit-fanout — the ADR-0025 pilot dynamic workflow. Owns the mechanical
// slice of the auditing skill: fan out one read-only Explore agent per audit
// facet (fixed EXISTING/GAP/INCONSISTENCY report format, full report returned
// inline in the digest under a hard size cap — Explore holds no write tool
// and guard-readonly-bash.mjs blocks every shell write route, so nothing here
// touches the filesystem), then adversarially verify each GAP/INCONSISTENCY
// finding with an independent `audit-refuter`-typed agent following the
// security-reviewer refute-mode pattern. Both phases dispatch a typed
// `agentType`, so guard-readonly-bash.mjs's read-only Bash block covers every
// agent() call in this file — an earlier version left the Verify refuter
// untyped, so it ran unguarded for mutating Bash despite the claim above; see
// docs/adr/0025-dynamic-workflows-assessment.md for the history. The hub
// keeps the judgment half: aggregation, clarifying questions, and plan mode
// (see .claude/skills/auditing/SKILL.md). The tier pins are enforced against
// the MODEL-MATRIX `agent` row for `audit-refuter` and the `workflow-script`
// file-level row for this script by `pnpm check:workflows`, which also
// enforces the max-agents header above (5 finders + 15 refuters = 20 <= 25;
// see the ADR for why 25 stays the ceiling despite the Workflow tool's own
// size-guideline default).
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

// Per-facet digest bound: REPORT_MAX_CHARS for reportMarkdown plus up to
// DIGEST_ITEMS_MAX items, each capped at ITEM_CLAIM_MAX_CHARS +
// ITEM_PATH_MAX_CHARS. Worst case per facet is REPORT_MAX_CHARS +
// DIGEST_ITEMS_MAX * (ITEM_CLAIM_MAX_CHARS + ITEM_PATH_MAX_CHARS) ~= 8000 +
// 20 * 700 = 22 KB; worst case across 5 facets ~= 110 KB of hub context —
// bounded and predictable, replacing the file-write indirection that never
// worked under Explore's read-only tool grant (see the header comment
// above). The prior comment ("worst case ~40 KB") counted reportMarkdown
// only and ignored the then-unbounded items array.
const REPORT_MAX_CHARS = 8000;
const DIGEST_ITEMS_MAX = 20;
const ITEM_CLAIM_MAX_CHARS = 400;
const ITEM_PATH_MAX_CHARS = 300;

const DIGEST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["facet", "reportMarkdown", "counts", "items"],
  properties: {
    facet: { type: "string" },
    reportMarkdown: { type: "string", maxLength: REPORT_MAX_CHARS },
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
      maxItems: DIGEST_ITEMS_MAX,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type", "claim", "citedPath"],
        properties: {
          type: { type: "string", enum: ["GAP", "INCONSISTENCY"] },
          claim: { type: "string", maxLength: ITEM_CLAIM_MAX_CHARS },
          citedPath: { type: "string", maxLength: ITEM_PATH_MAX_CHARS },
        },
      },
    },
  },
};

const VERDICT_EVIDENCE_MAX_CHARS = 2000;
const VERDICT_NOTE_MAX_CHARS = 500;

const VERDICT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "evidence"],
  properties: {
    verdict: { type: "string", enum: ["confirmed", "refuted"] },
    evidence: { type: "string", maxLength: VERDICT_EVIDENCE_MAX_CHARS },
    note: { type: "string", maxLength: VERDICT_NOTE_MAX_CHARS },
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
  throw invalidArgs("expected { topic, facets }");
}
const { topic, facets } = parsedArgs;
if (typeof topic !== "string" || topic.length === 0) {
  throw invalidArgs("topic must be a non-empty string");
}
if (!Array.isArray(facets) || facets.length < 1 || facets.length > FACETS_MAX) {
  throw invalidArgs(`facets must be an array of 1..${FACETS_MAX} entries`);
}
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
    // Two finders with one slug would collide as facet identity downstream.
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
    "- You hold no write tool and cannot write any file — this is by design (you are a structurally read-only spoke). Your full report travels back in your structured return value, not on disk.",
    "- Use this report format verbatim, as the value of the reportMarkdown field:",
    "",
    `  ## Findings: ${facet.name}`,
    "  - EXISTING: <description of what is already in place>",
    "  - GAP: <something absent that would be expected>",
    "  - INCONSISTENCY: <something that conflicts with another part of the repo>",
    "",
    `- reportMarkdown has a hard ${REPORT_MAX_CHARS}-character ceiling — write concisely and prioritize GAP/INCONSISTENCY detail over exhaustive EXISTING prose if you'd otherwise run over.`,
    "- Mark an item EXISTING only when you can confirm it is implemented — not merely because you found no evidence of a gap.",
    "- Your structured return value has two parts: reportMarkdown (the full report above) and a compact digest — the facet name, per-type counts, and one entry per GAP or INCONSISTENCY (the claim plus the repo path it cites). The digest must not restate EXISTING items; those live in reportMarkdown only.",
  ].join("\n");
}

function refutePrompt(finding) {
  return [
    `Adversarially verify one audit finding about the m3l-automation repo (topic: "${topic}"). Work in refute mode: assume the finding is WRONG and try to disprove it.`,
    "",
    `Finding (${finding.type}, facet "${finding.facet}"): ${finding.claim}`,
    `Cited path: ${finding.citedPath}`,
    "",
    "- Hunt for the claimed-missing thing under other names, paths, or conventions (search widely; read candidate files in full).",
    "- For an INCONSISTENCY, check whether the two sides are actually reconciled somewhere (a doc, a config, a generated artifact).",
    '- Return verdict "refuted" with the disproving evidence when refutation succeeds.',
    '- Return verdict "confirmed" ONLY after genuine refutation attempts fail, listing what you checked as the evidence trail.',
    '- Use the optional "note" field for caveats — e.g. the claim is only partially right, or holds on one platform only.',
  ].join("\n");
}

/**
 * Spread up to `max` findings across `groups` round-robin (one per group per
 * pass) rather than draining earlier groups first — a flat `slice(0, max)`
 * over facet-ordered findings starves later facets of verification entirely
 * whenever earlier facets alone exceed the budget, which measured production
 * runs show happening on every 5-facet audit. Each group keeps its own
 * internal order; only the interleaving changes.
 *
 * @param {{facet: string}[][]} groups
 * @param {number} max
 * @returns {{ selected: object[], remainder: object[] }}
 */
function allocateRoundRobin(groups, max) {
  const queues = groups.map((group) => [...group]);
  const selected = [];
  let tookAny = true;
  while (selected.length < max && tookAny) {
    tookAny = false;
    for (const queue of queues) {
      if (selected.length >= max) break;
      if (queue.length === 0) continue;
      selected.push(queue.shift());
      tookAny = true;
    }
  }
  return { selected, remainder: queues.flat() };
}

phase("Find");
log(`audit-fanout: ${facets.length} facet(s) on "${topic}"`);
const rawDigests = await parallel(
  facets.map(
    (facet) => () =>
      agent(findPrompt(facet), {
        label: `find:${facet.slug}`,
        phase: "Find",
        agentType: "Explore",
        schema: DIGEST_SCHEMA,
      }),
  ),
);

// A finder that returns null (stopped, unrecoverable API error) must not
// vanish silently — the hub needs to know a facet was never audited, not
// just infer it from a shorter facets[] array.
const missingFacets = facets
  .filter((facet, index) => !rawDigests[index])
  .map((facet) => facet.name);
if (missingFacets.length > 0) {
  log(
    `audit-fanout: ${missingFacets.length} facet(s) produced no finder digest — never audited: ${missingFacets.join(", ")}`,
  );
}

const digests = rawDigests
  // parallel() preserves index alignment (nulls for dead thunks), so stamp
  // each digest's facet linkage from the input array rather than trusting the
  // agent's self-reported facet echo.
  .map((digest, index) =>
    digest
      ? {
          ...digest,
          facet: facets[index].name,
        }
      : null,
  )
  .filter(Boolean);

const findingsByFacet = digests.map((digest) =>
  digest.items.map((item) => ({
    ...item,
    facet: digest.facet,
  })),
);

const { selected: allocated, remainder } = allocateRoundRobin(
  findingsByFacet,
  VERIFY_MAX,
);
let toVerify = allocated;
const unverified = remainder;
// budget.remaining() is Infinity when no target is set, so this naturally
// never fires without a target — no need to gate on budget.total separately
// (that gate was previously present but redundant with a hardcoded 50_000
// that had drifted from the MIN_VERIFY_TOKEN_BUDGET constant above it).
if (budget.remaining() < MIN_VERIFY_TOKEN_BUDGET) {
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
// Dispatches as the dedicated `audit-refuter` spoke (.claude/agents/audit-refuter.md),
// which pins claude-sonnet-5/medium in its own frontmatter — no inline
// model/effort override needed, and no untyped agent left outside
// check:agents' no-nesting invariant or guard-readonly-bash.mjs's read-only
// Bash block. See the header comment for the history this closes.
const verdicts =
  toVerify.length > 0
    ? await pipeline(toVerify, (finding) =>
        agent(refutePrompt(finding), {
          label: "verify",
          phase: "Verify",
          agentType: "audit-refuter",
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
  facets: digests.map(({ facet, reportMarkdown, counts }) => ({
    facet,
    reportMarkdown,
    counts,
  })),
  missingFacets,
  confirmed,
  refuted,
  unverified,
};
