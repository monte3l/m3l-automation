---
name: harness-guide
description: >-
  Answers "which skill handles X" and "how do I invoke Y" by reading
  docs/contributing/skill-routing.md. Reachable only via the explicit
  /harness-guide command — never auto-invoked from prose, so it costs zero
  skill-listing budget (see bin/check-context-budget.mjs's
  collectSkillDescriptions exclusion for this frontmatter key).
disable-model-invocation: true
---

# harness-guide

Answer the invoking question about this repo's Claude Code harness — which
skill applies, how to invoke it, what it hands off to next — by reading the
routing table rather than guessing from memory. The table changes as skills
are added or renamed; this skill's job is to consult it fresh every time, not
to memorize it.

## Steps

1. Read `docs/contributing/skill-routing.md` in full.
2. Match the invoking question's stated intent against the table's "I want
   to..." columns across every section (Planning and research, Starting a
   change, Building library code, Building a consumer script, Shipping and
   closing out, Git and review hygiene, CI/security/dependency triage,
   Config-specific how-to, The knowledge loop).
3. Answer directly:
   - The skill's exact `/slug`.
   - One example plain-English phrasing that also reaches it (from the
     table's "Also triggers on" column), and a one-line note that plain
     English depends on the skill-listing budget while `/slug` does not (see
     the routing doc's "Slash command or plain English" section) if that
     distinction is relevant to the question.
   - If the matched skill is a step in one of the "Successor chains", name
     the full chain and where this skill sits in it.
4. If no argument was given (a bare `/harness-guide`), don't guess at
   intent — summarize the routing table's section headers as a menu and ask
   what the user is trying to do.
5. If the stated intent matches nothing in the table, say so explicitly
   rather than picking the nearest-sounding skill name. Point at
   `/auditing` (the general-purpose "investigate and plan" entry point) or
   suggest asking the maintainer directly, per the routing doc's own "When
   nothing in the table matches" section.

## Notes

This skill deliberately does no work itself beyond reading and answering —
it never edits a file, runs a gate, or dispatches another skill. If the
matched skill is the right next step, name it and stop; let the user (or a
follow-up prompt) invoke it explicitly rather than this skill chaining into
it automatically.
