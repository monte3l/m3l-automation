#!/usr/bin/env node
/**
 * Asserts that every `Item` key `sync:hub` derives from `docs/ROADMAP.md` and
 * `docs/plans/IMPLEMENTATION.md` is unique — no two tracker rows may produce
 * the same key, no two keys may differ only by case, and no `Item.legacyKeys`
 * alias may shadow a different item's current key. Also asserts (ADR-0051)
 * that `bin/lib/hub-sync.mjs`'s `PRIORITY_LABELS`, `MILESTONE_TITLES`, and
 * `ROADMAP_ANCHORS` constant tables stay mutually consistent — see
 * {@link findPriorityVocabularyMismatches}.
 *
 * This is the durable fix for issue #480 / F13. An item key is written into
 * its GitHub issue body as `<!-- m3l-hub-sync:<key> -->` and is the ONLY
 * thing `planIssueSync` (`bin/lib/hub-sync.mjs`) matches an issue on. Item
 * labels, however, are only unique within their own tracker table: the
 * ADR-0035 rollout and codified-procedure wave tables both restart at A1, so
 * A1/A2/A3/A5/A6 each denote two entirely different items. Under the old flat
 * `impl:<label>` scheme those five pairs collided, and `actionableItems`'
 * `addItem` merged a duplicate key silently — one of each pair would have
 * stopped being planned while its issue was closed as "removed from source
 * trackers".
 *
 * They did not actually collide in practice, but only by accident: the
 * rollout table was the one table not passing its label through `slug()`, so
 * its keys stayed upper-case and the case-sensitive marker match kept them
 * apart. Making key derivation consistent — an obvious cleanup — would have
 * fired all five at once. Namespacing the keys by section removed the
 * hazard; this gate is what stops it coming back, and it checks
 * case-insensitively precisely because that accident is what masked it.
 *
 * `actionableItems` also warns on a duplicate now, but a warning in a dry-run
 * log is the channel that let issue #204 sit wrong for weeks (ADR-0032's
 * 2026-08-15 Update). This is the hard backstop that does not depend on
 * someone reading that log.
 *
 * Exit codes:
 *   0  Every derived key is unique (case-insensitively, aliases included),
 *      and the priority label/milestone/anchor tables agree.
 *   1  At least one collision or vocabulary mismatch, or a tracker file
 *      could not be read/parsed.
 *
 * Usage:
 *   node bin/check-hub-keys.mjs
 *   pnpm check:hub-keys
 */
import process from "node:process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractImplementation, extractRoadmap } from "./lib/project-hub.mjs";
import {
  actionableItems,
  ISSUE_TYPES,
  MILESTONE_TITLES,
  PRIORITY_LABELS,
  PROJECT_PRIORITY_OPTIONS,
  ROADMAP_ANCHORS,
} from "./lib/hub-sync.mjs";
import { createReporter, parseJsonFlag, repoRoot } from "./lib/report.mjs";

const root = repoRoot(import.meta.url);

const ROADMAP_PATH = "docs/ROADMAP.md";
const IMPLEMENTATION_PATH = "docs/plans/IMPLEMENTATION.md";

/**
 * Every key collision in an {@link actionableItems} result, in a stable
 * order: exact duplicates first (two rows derived the same key), then
 * case-variant pairs, then legacy aliases shadowing another item's key.
 *
 * Exact duplicates come from `duplicateKeys` rather than from `items`,
 * because `addItem` has already merged them by the time `items` is returned —
 * the collision is only observable in that structural channel.
 *
 * Declares exactly the fields it reads — `key`, `title`, and `legacyKeys` off
 * each item, plus `duplicateKeys` — rather than a whole
 * {@link actionableItems} result. An `Item` satisfies it structurally, so the
 * real caller passes one unchanged, while a caller (or a test) constructing
 * the minimum input is not forced to invent a `status`, `priority`,
 * `sourcePath`, `sourceAnchor`, `detail`, and `warnings` that have no bearing
 * on whether two keys collide.
 *
 * @param {{ items: { key: string, title: string, legacyKeys?: string[] }[], duplicateKeys?: { key: string, first: string, second: string }[] }} result
 * @returns {Array<{ kind: string, key: string, message: string }>}
 * @example
 * ```js
 * import { findKeyCollisions } from "@m3l-automation/workspace/bin/check-hub-keys.mjs";
 *
 * findKeyCollisions(actionableItems(roadmap, implementation)); // []
 * ```
 */
export function findKeyCollisions({ items, duplicateKeys }) {
  const findings = [];

  for (const { key, first, second } of duplicateKeys ?? []) {
    findings.push({
      kind: "duplicate",
      key,
      message:
        `Two tracker rows derive the same item key "${key}" — "${first}" and ` +
        `"${second}". They share one GitHub issue: the first row's title, ` +
        `status, and priority win and the second only contributes detail ` +
        `lines. Give the two rows distinct labels within their table.`,
    });
  }

  // Case-variant keys are as dangerous as exact ones and far harder to see:
  // `impl:A2` and `impl:a2` are two different join keys that read as one.
  const byLowerKey = new Map();
  for (const item of items) {
    const lower = item.key.toLowerCase();
    byLowerKey.set(lower, [...(byLowerKey.get(lower) ?? []), item]);
  }
  for (const [lower, colliding] of byLowerKey) {
    if (colliding.length < 2) continue;
    findings.push({
      kind: "case-variant",
      key: lower,
      message:
        `Item keys ${colliding.map((item) => `"${item.key}"`).join(" and ")} ` +
        `differ only by case. Marker matching is case-sensitive, so these are ` +
        `two distinct join keys that a reader cannot tell apart — exactly the ` +
        `accident that masked issue #480's collision. Namespace their sections ` +
        `apart or relabel the rows.`,
    });
  }

  // An alias must never resolve to an item other than the one that declares
  // it; indexItemsByKey makes such an alias inert, which would silently strand
  // whichever issue still carries it.
  const currentKeys = new Map(items.map((item) => [item.key, item]));
  for (const item of items) {
    for (const legacy of item.legacyKeys ?? []) {
      const shadowed = currentKeys.get(legacy);
      if (shadowed === undefined || shadowed === item) continue;
      findings.push({
        kind: "legacy-shadow",
        key: legacy,
        message:
          `"${item.title}" lists legacy key "${legacy}", which is already the ` +
          `current key of "${shadowed.title}". The alias is ignored, so any ` +
          `issue still carrying that marker resolves to the wrong item.`,
      });
    }
  }

  return findings;
}

/**
 * Assert cross-module consistency between the priority vocabulary's
 * independent constant tables in `bin/lib/hub-sync.mjs`: every
 * {@link PRIORITY_LABELS} tier must resolve to a real {@link
 * MILESTONE_TITLES} entry — otherwise `buildIssuePayload` silently resolves
 * that tier's milestone to `undefined`, which only ever surfaces as a
 * confusing `gh` failure at `--apply` time — every {@link ROADMAP_ANCHORS}
 * key must also be a `MILESTONE_TITLES` key, since an item sourced from that
 * anchor needs a milestone to file under; and every {@link
 * PROJECT_PRIORITY_OPTIONS} tier (ADR-0052's board Priority field) must spell
 * the same tier `PRIORITY_LABELS` does — `"priority:" + PROJECT_PRIORITY_OPTIONS[key]
 * === PRIORITY_LABELS[key]` — so the label and the board field can never
 * drift into two different spellings of the same three tiers. Added under
 * ADR-0051 (labels/milestones/anchors) and widened under ADR-0052 (the board
 * field): a rename that updates only some of these four registers previously
 * failed only at runtime.
 *
 * Deliberately NOT blanket set equality: `MILESTONE_TITLES` legitimately
 * carries an extra `major` bucket with no priority-label counterpart
 * ({@link MAJOR_BUMP_ITEM_KEYS} routes to it independent of tier),
 * `ROADMAP_ANCHORS` legitimately omits `p2` — `docs/ROADMAP.md`'s Priority 2
 * section is parsed but never converted into items — and
 * `PROJECT_PRIORITY_OPTIONS.governance` is legitimately `"Governance"` with
 * no `PRIORITY_LABELS` counterpart (ADR-0052's 2026-08-20 Update; governance
 * still has no `priority:*` label — ADR-0051's "governance is a category,
 * not a tier" rule — it just isn't left blank on the board either).
 *
 * @param {{ priorityLabels: Record<string, string>, milestoneTitles: Record<string, string>, roadmapAnchors: Record<string, string>, projectPriorityOptions: Record<string, string | null> }} tables
 * @returns {string[]}
 * @example
 * ```js
 * import { findPriorityVocabularyMismatches } from "@m3l-automation/workspace/bin/check-hub-keys.mjs";
 *
 * findPriorityVocabularyMismatches({
 *   priorityLabels: { p0: "priority:0-now" },
 *   milestoneTitles: {},
 *   roadmapAnchors: {},
 *   projectPriorityOptions: {},
 * }); // ['PRIORITY_LABELS.p0 ("priority:0-now") has no MILESTONE_TITLES.p0 entry.']
 * ```
 */
export function findPriorityVocabularyMismatches({
  priorityLabels,
  milestoneTitles,
  roadmapAnchors,
  projectPriorityOptions,
}) {
  const findings = [];

  for (const [key, label] of Object.entries(priorityLabels)) {
    if (!(key in milestoneTitles)) {
      findings.push(
        `PRIORITY_LABELS.${key} ("${label}") has no MILESTONE_TITLES.${key} entry — ` +
          `buildIssuePayload would silently resolve this tier's milestone to undefined.`,
      );
    }

    const boardOption = projectPriorityOptions[key];
    const expectedLabel = boardOption ? `priority:${boardOption}` : null;
    if (expectedLabel !== null && expectedLabel !== label) {
      findings.push(
        `PRIORITY_LABELS.${key} ("${label}") and PROJECT_PRIORITY_OPTIONS.${key} ` +
          `("${boardOption}") spell tier "${key}" differently — the label and the board ` +
          `Priority field would show two different names for the same tier.`,
      );
    }
  }

  for (const [key, anchor] of Object.entries(roadmapAnchors)) {
    if (!(key in milestoneTitles)) {
      findings.push(
        `ROADMAP_ANCHORS.${key} ("${anchor}") has no MILESTONE_TITLES.${key} entry — ` +
          `an item sourced from this anchor would point at a tier with no milestone to file under.`,
      );
    }
  }

  return findings;
}

/**
 * Assert every {@link actionableItems} result item carries a
 * {@link ISSUE_TYPES} value (ADR-0052) — a section that gains an anchor
 * (see {@link TYPE_BY_ROADMAP_SECTION}/{@link TYPE_BY_IMPLEMENTATION_SECTION}
 * in `bin/lib/hub-sync.mjs`) but not a type would otherwise fail only when
 * `sync:hub-issues --apply` tries `gh issue edit --type undefined`.
 *
 * @param {{ key: string, title: string, type?: string }[]} items
 * @returns {string[]}
 * @example
 * ```js
 * import { findMissingTypes } from "@m3l-automation/workspace/bin/check-hub-keys.mjs";
 *
 * findMissingTypes([{ key: "roadmap:p0:x", title: "X" }]);
 * // ['Item "roadmap:p0:x" ("X") has no Issue Type — check TYPE_BY_ROADMAP_SECTION/TYPE_BY_IMPLEMENTATION_SECTION.']
 * ```
 */
export function findMissingTypes(items) {
  const validTypes = new Set(Object.values(ISSUE_TYPES));
  return items
    .filter((item) => !validTypes.has(item.type))
    .map(
      (item) =>
        `Item "${item.key}" ("${item.title}") has no Issue Type — check ` +
        `TYPE_BY_ROADMAP_SECTION/TYPE_BY_IMPLEMENTATION_SECTION.`,
    );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { json } = parseJsonFlag();
  const reporter = createReporter(json);

  try {
    const roadmap = extractRoadmap(
      readFileSync(join(root, ROADMAP_PATH), "utf8"),
    );
    const implementation = extractImplementation(
      readFileSync(join(root, IMPLEMENTATION_PATH), "utf8"),
    );

    // A missing section means whole tables went unread, so any key check over
    // the remainder would be reporting on a partial corpus.
    const extractionErrors = [...roadmap.errors, ...implementation.errors];
    if (extractionErrors.length > 0) {
      for (const message of extractionErrors) reporter.error(message);
      reporter.finish();
      process.exit(1);
    }

    const result = actionableItems(roadmap, implementation);
    const findings = findKeyCollisions(result);
    const vocabularyMismatches = findPriorityVocabularyMismatches({
      priorityLabels: PRIORITY_LABELS,
      milestoneTitles: MILESTONE_TITLES,
      roadmapAnchors: ROADMAP_ANCHORS,
      projectPriorityOptions: PROJECT_PRIORITY_OPTIONS,
    });
    const missingTypes = findMissingTypes(result.items);

    if (
      findings.length > 0 ||
      vocabularyMismatches.length > 0 ||
      missingTypes.length > 0
    ) {
      for (const { message } of findings) {
        reporter.error(message, { file: IMPLEMENTATION_PATH });
      }
      for (const message of vocabularyMismatches) {
        reporter.error(message, { file: "bin/lib/hub-sync.mjs" });
      }
      for (const message of missingTypes) {
        reporter.error(message, { file: "bin/lib/hub-sync.mjs" });
      }
      reporter.finish();
      process.exit(1);
    }

    reporter.succeed(
      `${result.items.length} hub-sync item keys are unique (case-insensitively, aliases included), ` +
        `every item carries an Issue Type, and the priority label/milestone/anchor/board-field tables agree.`,
    );
    reporter.finish();
  } catch (cause) {
    reporter.error(cause instanceof Error ? cause.message : String(cause));
    reporter.finish();
    process.exit(1);
  }
}
