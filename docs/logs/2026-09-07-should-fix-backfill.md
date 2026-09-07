# Work log — should-fix-backfill (2026-09-07)

This log is the output of `bin/backfill-should-fix.mjs` (PR 4 of the Should-fix acknowledgment gate sequence, [`docs/adr/0097`](../adr/0097-should-fix-acknowledgment-gate.md)) — the historical measurement the audit that produced ADR-0097 could not run live (GitHub access was unavailable at the time). It classifies every merged pull request's Should-fix disposition retroactively, before the gate existed to enforce anything.

Fetched: 2026-09-07T15:06:57.867Z. Total merged PRs examined: **831**.

## Methodology

For each merged PR: fetch its changed-file list and full comment history via the GitHub GraphQL API, filter comments to the review bot (GraphQL reports its login as `claude` with `author.__typename == "Bot"` — NOT `claude[bot]`, the REST API's `user.login` value `check-should-fix-ack.mjs` matches on instead), and reuse the SAME parsers the live gate uses (`bin/lib/pr-review-gate.mjs`'s `selectShouldFixComment`/`parseShouldFixSection`/`countShouldFixFindings`) so this measurement can never disagree with the gate about what counts as a finding. Acknowledgment/resolution evidence is read from the squash-merge commit's message via local `git log`, which concatenates every original commit's own message as a `* ...` bullet — so an `Acknowledged-Should-Fix:` footer or a pre-ADR-0097 resolve-commit on any commit in the branch is visible there even though the branch itself no longer exists post-merge. Classification logic: `bin/lib/should-fix-backfill.mjs`'s `classifyPr`.

**Two caveats stated explicitly, not papered over (per the plan of record):**

- REVIEW.md's "Re-review convergence" rule suppresses fresh Should-fix bullets to a count-only summary on every review round after the first. This script — like the live gate — cannot distinguish a Should-fix finding that was silently fixed from one that was silently carried forward once a PR reaches a second review round. Those cases are tagged `multi-round-suppressed`: **indeterminate, not resolved.**
- This measurement reads only `claude[bot]`'s posted PR review comments (the CI gate) — never local spoke review output (`code-reviewer`, `security-reviewer`, etc.) that work logs sometimes narrate as "review verdicts." Those are a different population and are not merged with this one.

## Results by category

| Category                                                                                                                                        | Count | % of total | Auto-merge | Manual |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ---------- | ---------- | ------ |
| Review-excluded (docs/config-only, never reviewed)                                                                                              | 160   | 19.3%      | —          | —      |
| No claude[bot] review ever posted                                                                                                               | 102   | 12.3%      | —          | —      |
| Reviewed, no Should-fix finding ever posted                                                                                                     | 198   | 23.8%      | —          | —      |
| Should-fix posted, Acknowledged-Should-Fix: footer present                                                                                      | 10    | 1.2%       | 1          | 9      |
| Should-fix posted, no footer — a pre-ADR-0097 'resolve claude-pr-review findings' commit exists (weak evidence, not proof)                      | 1     | 0.1%       | 0          | 1      |
| Should-fix posted, no footer/resolve-commit — multiple review rounds occurred (indeterminate: REVIEW.md suppresses fresh bullets after round 1) | 154   | 18.5%      | 35         | 119    |
| Should-fix posted, no footer/resolve-commit, exactly one review round — merged with no further review activity                                  | 206   | 24.8%      | 30         | 176    |

Of 831 merged PRs, **569** were candidates (not review-excluded, had a posted review). 95 PR(s) had a truncated files/comments page (GitHub's GraphQL connections were fetched at their maximum page size, 100 — a PR with more files or comments than that is marked † below) and their classification may be wrong in either direction; spot-check those before trusting them.

**Should-fix posted, Acknowledged-Should-Fix: footer present** (10):

```text
#1089, #1090, #1094, #1096, #1102, #1104, #1105, #1106, #1109, #1112
```

## PRs needing acknowledgment that never got one

Every PR in `resolve-commit-heuristic`, `multi-round-suppressed`, or `merged-unresolved` — i.e. every PR that posted a Should-fix finding and carries no `Acknowledged-Should-Fix:` footer. Grouped by category; PR numbers only (see the raw JSON for full detail, produced via `--json`).

**Should-fix posted, no footer — a pre-ADR-0097 'resolve claude-pr-review findings' commit exists (weak evidence, not proof)** (1):

```text
#955
```

**Should-fix posted, no footer/resolve-commit — multiple review rounds occurred (indeterminate: REVIEW.md suppresses fresh bullets after round 1)** (154):

```text
#25†, #28†, #42†, #51†, #68†, #86†, #99†, #108†, #109†, #112†, #114†, #128†, #151†, #159†, #163†, #166†, #168†, #180†, #185†, #227†, #231†, #251†, #267†, #275†, #282†, #283†, #297†, #298†, #305†, #312†, #313†, #316, #319, #321, #323, #326, #327, #328, #330, #425, #461, #463, #464, #478, #482, #484, #493, #494, #495, #501, #502, #512, #513, #515, #567, #574, #580, #582, #583, #585, #586, #587, #592, #598, #599, #600, #604, #618, #621, #636, #647, #649, #652, #657, #661, #662, #664, #666, #669, #675, #678, #683, #684, #685, #687, #689, #690, #692, #698, #700, #705, #706, #711, #712, #714, #717, #718, #719, #720, #721, #723, #725, #726, #730, #731, #732, #733, #737, #740, #741, #742, #743, #744, #748, #754, #757, #761, #762, #765, #769, #776, #778, #787, #822, #823, #830, #839, #842, #845, #853, #857, #859, #869, #878†, #897†, #906†, #913, #914, #916, #923, #952, #956, #958, #992, #1006, #1007, #1025, #1035, #1038, #1046, #1061, #1069, #1071, #1081
```

**Should-fix posted, no footer/resolve-commit, exactly one review round — merged with no further review activity** (206):

```text
#49†, #50†, #72†, #87†, #90†, #103†, #117†, #118†, #127†, #131†, #133†, #138†, #146†, #147†, #150†, #157†, #165†, #170†, #171†, #216†, #224†, #230†, #232†, #233†, #240†, #248†, #252†, #254†, #255†, #256†, #260†, #261†, #266†, #270†, #271†, #277†, #278†, #279†, #280†, #281†, #285†, #286†, #287†, #288†, #289†, #311†, #315, #317, #318, #320, #329, #331, #399, #404, #405, #406, #407, #415, #417, #418, #421, #423, #424, #431, #435, #436, #453, #454, #457, #462, #465, #486, #499, #511, #520, #573, #589, #593, #595, #616, #619, #622, #633, #642, #650, #653, #654, #656, #658, #665, #668, #670, #674, #679, #680, #682, #694, #695, #702, #707, #708, #710, #728, #734, #736, #738, #749, #755, #756, #763†, #766, #768, #771, #772, #777, #789, #791, #802, #812, #814, #817, #818, #819, #820, #821, #826, #827, #828, #829, #831, #836, #837, #841, #849, #851, #854, #861, #866, #870, #871, #872, #874, #880†, #881†, #884†, #887†, #888†, #892†, #894†, #895†, #896†, #903†, #905†, #907†, #908†, #909†, #915, #917, #920, #921, #927, #930, #932, #936, #937, #938, #939, #941, #943, #946, #951, #959, #971, #972, #973, #979, #980, #982, #983, #986, #987, #990, #991, #993, #1016, #1017, #1024, #1027, #1028, #1037, #1042, #1043, #1044, #1048, #1050, #1052, #1060, #1062, #1063, #1066, #1067, #1068, #1075, #1078, #1079, #1085
```

† truncated files/comments page — spot-check before trusting this classification.

## Lessons

- The dominant historical failure mode was never auto-merge or a manual override of a known-pending finding — it was structural silence: nothing read the Should-fix tier at all before ADR-0097, so a posted finding left no local trace regardless of how the PR merged. This measurement's own `mode` column corroborates the audit's live-code finding (`creating-prs` SKILL.md defaults to plain `gh pr merge --squash`, never `--auto`): the vast majority of PRs in every category merged `manual`, not `auto-merge`.
- `multi-round-suppressed` cannot be resolved into `resolved`/`unresolved` after the fact — REVIEW.md's convergence rule destroys that information at review time, not just at measurement time. Any future gate change wanting real historical resolution data would need REVIEW.md itself to restate current Should-fix status on every round, not a smarter parser here.
