# Code Quality & Standards

> **Concrete, project-specific rules live in the [Style Guide](../docs/contributing/style-guide.md).**
> This document is the deeper, language-agnostic _why_ — the quality hierarchy,
> anti-patterns, the four-part review checklist, and the refactoring discipline.
> When the two overlap, the Style Guide is the operational source of truth (and
> marks each rule `[enforced]` vs `[advisory]`); read it first for how to write and
> change code in this repo.

## Overview

This domain defines the complete baseline for producing, evaluating, and maintaining high-quality code across every stage of the development lifecycle. It covers the quality hierarchy that governs how correctness, readability, maintainability, and performance relate to one another; the universal coding standards that every line of code must satisfy; the anti-patterns and red flags that mandate remediation before merge; the systematic four-part checklist that governs code review; the discipline of incremental, validated refactoring; and the four levels of documentation that every project must maintain. Taken together, these rules ensure that code is correct, understandable, safe to change, and legible to future developers — the ultimate measure of engineering quality.

---

## Core Principles

1. **Quality is evaluated bottom-up.** Correctness must be established before readability is considered; readability before maintainability; maintainability before performance. A higher layer MUST NOT be optimized at the cost of a lower one.
2. **Code must be correct first.** Code MUST produce the right results for all defined inputs and satisfy its specification. Behavior that contradicts the spec is a defect even when the code runs without error.
3. **Code must remain understandable without its author.** Every identifier, structure, and flow MUST communicate intent to a developer who has never seen the code and to the author after the original context has been forgotten.
4. **Every failing path must be handled explicitly.** Silent failures, swallowed exceptions, and unvalidated inputs crossing trust boundaries are prohibited without exception.
5. **Functions must do one thing.** A function whose purpose cannot be stated in a single sentence MUST be decomposed. Single responsibility is the prerequisite for testability, safe modification, and reuse.
6. **Duplication must be consolidated.** Identical or near-identical logic in more than one location is prohibited. Every bug fix and requirement change applied to duplicated code multiplies cost and risk.
7. **Code must fit the existing architecture.** New code MUST follow established patterns, use declared interfaces, and respect naming, logging, configuration, and error-handling conventions. Divergence without justification is an architectural mismatch.
8. **Abstractions must solve real problems.** Complex design MUST NOT be applied where simple code suffices. Patterns and abstractions introduced for hypothetical future requirements (YAGNI) MUST be removed.
9. **Refactoring requires a test safety net.** Refactoring MUST NOT begin without a passing automated test suite. Where tests are absent, characterization tests MUST be added first to capture current behavior.
10. **Documentation must explain WHY, not WHAT.** Inline comments restating the code in prose are prohibited. All public interfaces MUST document purpose, parameters, return values, and failure modes.
11. **Review is a systematic gate, not an informal glance.** Every change MUST be assessed against the four-part checklist: structure and organization, naming and clarity, error handling, and testability.
12. **Technical debt must be tracked and paid deliberately.** Debt MUST be surfaced and addressed through continuous small improvements rather than tolerated silently or deferred to a future rewrite.

---

## Quality Foundations

### The Quality Hierarchy

Code quality is evaluated bottom-up. Every higher-level concern depends on the layer beneath it being solid. Never compromise a lower layer to optimize a higher one.

#### 1. Correctness

- Code MUST produce the right results for all defined inputs before any other quality concern is considered.
- Code MUST satisfy the specification it was written against. Behavior that contradicts the spec is a defect even when the code runs without error.
- Correctness MUST be verified through automated checks, not assumed from manual inspection or runtime success.

#### 2. Readability

- Code MUST be understandable by a developer who did not write it, without external explanation.
- Code MUST remain understandable after a period long enough for the author to forget the context in which it was written.
- Code MUST tell a coherent story when read top-to-bottom: identifier names, flow, and structure together MUST make the intent obvious.
- Readability MUST take priority over cleverness, brevity, or perceived elegance.

#### 3. Maintainability

- Code MUST be safe to modify when requirements change. Modification safety is measured by how much surrounding code must also be changed.
- Concerns MUST be separated so that each unit of code has one well-defined reason to change.
- Technical debt MUST be tracked, surfaced, and paid down deliberately rather than accumulating silently.
- Maintainability MUST be improved continuously through small, validated changes rather than rare large rewrites.

#### 4. Performance

- Performance MUST meet the speed and resource requirements defined for the system, no more.
- Performance optimization MUST NOT be applied before correctness, readability, and maintainability are established.
- Optimization MUST be driven by measurement against requirements, not by intuition or premature concern.
- Optimization MUST NOT obscure the intent of the code unless the resulting gain is measured, significant, and required.

### Quality Attributes of Excellent Code

Excellent code exhibits all of the following:

- Follows established patterns of the codebase correctly and consistently.
- Implements well-known algorithms in standard, recognizable form.
- Handles common use cases thoroughly, including their boundaries.
- Applies recognized design patterns where they solve a real problem.
- Uses common utility abstractions for repeated low-level operations (string handling, validation, data transformation).
- Provides consistent scaffolding for setup, configuration, and tests.

### Quality Attributes of Problematic Code

Problematic code exhibits any of the following:

- Appears correct on inspection but contains subtle defects revealed only under specific conditions.
- Misses business context, requirements, or implicit constraints.
- Relies on outdated practices, deprecated abstractions, or superseded approaches.
- References dependencies that do not exist, are unmaintained, or do not behave as the code assumes.
- Diverges from the surrounding architecture without justification.

### Improvement Targets

When measuring or improving quality, target the following dimensions:

- **Maintainability**: lower cyclomatic complexity, stronger separation of concerns, fewer reasons for any one unit to change.
- **Testability**: higher meaningful coverage, clearer test organization, less coupling to external systems.
- **Performance**: faster startup, reduced memory and resource consumption against measured baselines.
- **Security**: validated inputs, safe handling of external resources, no exposure of sensitive data.

The ultimate test of good code is whether future developers can work with it more effectively, not whether it is the fastest or shortest version possible.

---

## Coding Standards

### Development Discipline

- Code MUST be produced incrementally, in small validated steps, never as a single large change.
- Each unit of work MUST define its interface and contract before its implementation: what inputs it accepts, what outputs it returns, and what guarantees it makes.
- Each unit of work MUST be validated against its specification before being considered complete.
- Tests, error handling, and business logic MUST be verified before the change is shared with others.

### Architectural Consistency

- New code MUST follow the established patterns, conventions, and abstractions of the surrounding codebase.
- New code MUST integrate cleanly with existing modules through their declared interfaces, not by reaching into their internals.
- Existing naming, logging, configuration, and error-handling conventions MUST be respected and continued.
- Proposed solutions MUST fit the existing technology stack and its constraints; introducing incompatible patterns is prohibited.

### Error Handling

- Every operation that can fail MUST handle failure explicitly. Silent failures and unhandled error paths are prohibited.
- Error handling MUST follow the established conventions of the project: error types, propagation strategy, and reporting mechanisms.
- Error messages MUST identify the failing operation and provide sufficient context to diagnose the cause.
- Generic catch-all handlers that swallow errors without classification or reporting are prohibited.
- Inputs crossing a trust boundary (user input, external services, persisted data) MUST be validated before use.

### Identifiers and Naming

- Identifier names MUST be descriptive enough that the reader understands their purpose without consulting external documentation.
- Single-letter and ambiguous identifiers are prohibited except in scopes so small that meaning is unambiguous (for example, a loop index in a two-line loop).
- Identifiers MUST reflect the domain language of the problem, not the implementation mechanism.

### Constants

- Numeric, string, and configuration values used in logic MUST be declared as named constants in a single location.
- Hard-coded values scattered through business logic are prohibited.
- Environment-dependent values MUST be supplied through configuration, not embedded in source.

### Complexity

- Functions MUST be small enough that their purpose can be described in one sentence.
- Nesting depth MUST be limited; deep nesting MUST be reduced through early returns, extracted functions, or restructured conditionals.
- Repeated logic MUST be extracted into a single reusable unit. Identical or near-identical code in multiple locations is prohibited.

### Documentation and Annotations

- Public interfaces MUST carry documentation describing their purpose, parameters, return values, and failure modes.
- Type annotations MUST be applied where the language supports them and the team has adopted them as standard.
- Inline comments MUST explain WHY, not WHAT. Restating what the code does in prose is prohibited.

### Security

- Inputs from any external source MUST be validated and sanitized before being used in queries, commands, file paths, or rendered output.
- Sensitive data MUST NOT be logged, exposed in error messages, or transmitted without protection.
- Dependencies MUST be verified to exist, be actively maintained, and be used according to their current published interfaces.

### Testability

- Every unit of code MUST be testable in isolation from external systems.
- Dependencies on external systems MUST be injectable or otherwise replaceable for testing.
- Functions MUST have predictable behavior: the same inputs produce the same outputs, and side effects are explicit.

### Modification of Existing Code

- Changes to existing code MUST be reviewed as a diff to confirm that no unrelated functionality has been removed or altered.
- Before changing a unit, its existing tests MUST be present and passing. If tests are absent, they MUST be added before the change.
- Refactoring MUST preserve existing observable behavior unless the change is explicitly a behavior change.

---

## Anti-patterns & Red Flags

Detection of any item in this catalogue MUST trigger remediation before the code is merged or released.

### Functions Doing Too Many Things

- A function whose purpose cannot be stated in a single sentence is doing too much.
- Multi-responsibility functions MUST be decomposed before they accumulate further changes. They obstruct testing, raise the risk of every modification, and resist reuse.

### Ambiguous Identifier Names

- Identifier names that do not communicate purpose are prohibited outside of throwaway prototypes.
- Names MUST be renamed to reflect domain meaning before code is reviewed or merged.

### Missing Error Handling

- Code with no failure paths, no validation of inputs, and no defensive treatment of external responses has not been exercised under realistic conditions.
- Every external call, every parsed input, and every operation that may fail MUST be paired with explicit handling.

### Hard-Coded Values Scattered Through Logic

- Magic numbers and string literals embedded directly in business logic are prohibited.
- All such values MUST be lifted to named constants or configuration entries.

### Deep Nesting

- Code that requires horizontal scrolling because of nested conditionals and loops is a symptom of missing abstractions.
- Deeply nested structures MUST be flattened through early returns, guard clauses, extracted functions, or restructured control flow.

### Duplicated Code

- Identical or near-identical blocks appearing in more than one place are prohibited.
- Duplication multiplies the cost of every bug fix and every requirement change.
- Duplicated logic MUST be consolidated into a single shared implementation.

### Silent Loss of Existing Functionality

- Modifications MUST NOT remove or alter existing behavior unintentionally.
- Diffs MUST be reviewed both for what was added and for what was removed.
- Business logic completeness MUST be verified after every change.

### Phantom Dependencies

- Code MUST NOT reference libraries, modules, or symbols that do not exist in current package registries.
- Code MUST NOT use deprecated abstractions copied from old documentation.
- Every dependency MUST be verified to be present in the current package ecosystem, actively maintained, and used through its current published interface with signatures matching current documentation.

### Incomplete Context Awareness

- Code MUST NOT be written without first understanding the existing architecture, conventions, and constraints.
- Solutions MUST NOT introduce patterns that contradict the established architecture.
- Error handling, naming, logging, and configuration MUST follow established project conventions, not arbitrary defaults.

### The Context Gap

- Focusing on an immediate task MUST NOT lead to ignoring related or surrounding functionality.
- Before completing a change, the broader feature, module, and user-visible behavior MUST be re-examined to confirm nothing adjacent has been overlooked or regressed.

### Over-Engineering

- Complex design MUST NOT be applied where simple code suffices.
- Abstractions MUST NOT be introduced for hypothetical future requirements (the YAGNI principle: "You Aren't Gonna Need It").
- Before adopting any abstraction or pattern, the following questions MUST all be answered affirmatively:
  - Does the complexity match the problem scope?
  - Is this construct necessary for current, real requirements?
  - Would simpler code achieve the same goal?

### Test Theater

- Tests MUST exercise real behavior, not merely the existence of code.
- Tests that pass while the underlying feature is broken provide negative value.
- Before tests are considered adequate, the following questions MUST be answered affirmatively:
  - Do tests interact with real integration points where the system actually breaks?
  - Are failure cases covered, not only happy paths?
  - Do tests verify observable behavior rather than internal implementation details?
  - Are edge conditions and integration boundaries covered?
  - If the feature broke silently, would any test catch it?

### Architectural Mismatch

- Code MUST follow the existing patterns of the codebase.
- Code MUST use the project's established conventions and abstractions.
- Code MUST integrate with the architecture rather than work around it.
- Before merging, similar features in the codebase MUST be examined to confirm consistency.

---

## Code Review

Code review is a systematic gate, not an informal glance. Every change MUST be assessed against the same four-part checklist. Correctness is non-negotiable; complete quality requires all four levels. Performance MUST NOT be optimized at the expense of readability or maintainability.

### The Four-Part Checklist

Every review MUST evaluate the change across all four categories.

#### 1. Structure and Organization

- Concerns MUST be cleanly separated; responsibilities MUST NOT be mixed within a single unit.
- Functions, classes, modules, and other organizational units MUST be used appropriately for their intended scope.
- Code MUST be organized logically: related elements grouped, unrelated elements separated.
- New code MUST fit the architectural boundaries already established in the codebase.

#### 2. Naming and Clarity

- Variable, function, and type names MUST be descriptive and reflect their purpose.
- Code MUST be self-documenting where possible: well-named identifiers reduce the need for comments.
- Comments MUST be minimal but present where logic is non-obvious.
- Code that requires extensive comments to be understood MUST be restructured rather than further annotated.

#### 3. Error Handling

- All failure paths MUST be handled explicitly using project-standard mechanisms.
- Edge cases MUST be identified and addressed, not assumed away.
- Inputs MUST be validated at trust boundaries.
- Error handling MUST be consistent with existing patterns; introducing new error-handling styles is prohibited unless the change is explicitly about error handling.

#### 4. Testability

- Functions and units under review MUST have single, well-defined responsibilities.
- External dependencies MUST be minimal and replaceable, allowing the unit to be tested in isolation.
- Behavior MUST be predictable and reproducible from the same inputs.
- The unit MUST be exercised by tests that verify its behavior, not merely its existence.

### Pre-Review Checklist

Before submitting code for review, the author MUST confirm each of the following.

#### Context Gap Check

- Before/after diffs MUST be inspected to confirm that no original functionality has been removed.
- All previously working behavior MUST remain intact.
- New code MUST integrate with existing operations rather than bypass them.
- Business logic MUST be complete with respect to the requirement being addressed.

#### Phantom Dependency Check

- Every dependency referenced MUST exist in current package registries.
- Every dependency MUST be actively maintained.
- Imports and references MUST use current, non-deprecated interfaces.
- Function signatures MUST match the current published documentation of the dependency.

#### Over-Engineering Check

- The complexity introduced MUST match the scope of the problem.
- Any added pattern or abstraction MUST be necessary for current requirements.
- Where simpler code would achieve the same goal, the simpler approach MUST be preferred.
- Speculative complexity for hypothetical future needs MUST be removed.

#### Test Theater Check

- Tests MUST interact with real systems at the appropriate boundaries.
- Failure cases MUST be covered, not only happy paths.
- Tests MUST verify behavior, not implementation details.
- Edge conditions and integration points MUST be covered.
- The reviewer MUST ask: if this feature were silently broken, would these tests fail?

#### Architectural Mismatch Check

- Code MUST follow existing patterns in the codebase.
- Code MUST use the project's established conventions.
- Code MUST integrate with the surrounding architecture.
- Code MUST match the technology stack and framework usage already in place.
- Similar features in the codebase MUST be examined to confirm that the change follows the same patterns.

### Review Discipline

- Reviewers MUST apply the checklist systematically; informal review is prohibited for non-trivial changes.
- Reviewers MUST treat correctness as a precondition: if correctness is not established, other categories are not yet relevant.
- Reviewers MUST NOT request optimizations that compromise readability or maintainability without an explicit, measured justification.

---

## Refactoring

Refactoring changes the internal structure of code without changing its observable behavior. It is a discipline of incremental, validated, purposeful improvement. Refactoring is not feature work, performance work, or behavior change.

### Purpose

- Refactoring MUST address a specific, identified problem: duplication, complexity, unclear naming, fragile abstractions, performance bottlenecks, or weak type safety.
- Refactoring without an identified problem is prohibited; changes without purpose generate churn without value.
- The primary goal of any refactoring MUST be that future developers can read and modify the code more effectively.

### Preconditions

- A passing automated test suite MUST exist before any refactoring begins. Refactoring without tests is prohibited.
- If the area under refactoring lacks tests, characterization tests MUST be added first to capture current behavior.
- The intended outcome of the refactoring MUST be stated before the change is made: what improves, and how the improvement will be verified.

### Procedure

- Refactoring MUST proceed in small, isolated steps. Wholesale refactoring of a system in one pass is prohibited.
- After every refactoring step the full relevant test suite MUST be run. Any failure MUST be treated as a regression and reverted before continuing.
- Each step MUST be one focused operation: extract a function, rename an identifier, introduce a parameter, replace a conditional, consolidate a duplicate.
- Steps MUST be committed individually so that any regression can be bisected and reverted cleanly.

### Validation Questions

Before any refactoring is accepted, the following questions MUST all be answerable affirmatively:

- Does it make error handling more consistent?
- Does it make the code easier to test?
- Does it reduce duplication without obscuring logic?
- Does it actually solve a problem the team has?

If none of these are satisfied, the refactoring MUST NOT be performed.

### Scope Boundaries

- Refactoring MUST NOT add new features.
- Refactoring MUST NOT alter observable behavior.
- Refactoring MUST NOT introduce new external dependencies.
- Refactoring MUST NOT change public interfaces unless that change is the explicit purpose and is coordinated with all callers.

### Valid Refactoring Operations

The following are valid refactoring operations:

- Extract common patterns into shared utilities to remove duplication.
- Rename identifiers for clarity and domain accuracy.
- Simplify complex conditionals and reduce nesting.
- Replace ad-hoc structures with established design patterns where the pattern solves a real problem.
- Improve error message clarity so failures are easier to diagnose.
- Strengthen type safety where the language supports it.
- Address measured performance bottlenecks where evidence justifies the change.

The following are NOT refactoring operations and MUST NOT be bundled into a refactoring change: adding new features or capabilities; changing established user-visible behavior; introducing new third-party libraries or frameworks; speculative restructuring for hypothetical future needs.

### Encapsulation Progression

When evolving code toward better structure, the following language-agnostic progression applies:

- Begin by giving meaningful names to values, even if structure is rudimentary.
- Replace shared mutable state with state owned by a well-defined unit (an object, a module, or a closure scope).
- Encapsulate related data and operations within a single unit so that state is managed through a known interface.
- Avoid global mutable state; it complicates debugging, testing, and scaling.

### Quality Metrics

Refactoring outcomes MUST be measurable along at least one of:

- **Maintainability**: reduced cyclomatic complexity, improved separation of concerns.
- **Testability**: higher meaningful coverage, clearer test organization.
- **Performance**: measured improvement against a stated baseline.
- **Security**: stronger validation, safer handling of inputs and external resources.

If the change does not improve any measurable quality metric, it MUST NOT be merged as a refactoring.

### After Refactoring

- Test suites MUST be rerun in full to confirm no behavior has changed.
- Documentation referring to internals that were renamed or relocated MUST be updated.
- The commit history MUST reflect the refactoring as distinct from any feature or fix work.

---

## Documentation

Documentation serves the reader, not the author. It must remain accurate, accessible, and aligned with what the code actually does. Outdated documentation is worse than no documentation.

### The Four Documentation Levels

Every project MUST maintain documentation across all four levels. Each level has a distinct audience and purpose; one MUST NOT substitute for another.

#### 1. Inline Comments

- Inline comments MUST explain logic that is not self-evident from the code.
- Inline comments MUST describe WHY a decision was made, never WHAT the code does.
- Comments restating the code in prose are prohibited.
- Comments referring to specific tickets, callers, or temporary state MUST NOT be left in source files; that context belongs in commit messages or change records.

#### 2. Interface Documentation

- Every public function, class, module, or interface MUST carry documentation describing its purpose, parameters, return values, side effects, and failure modes.
- The documentation MUST be located adjacent to the declaration in the language's standard documentation form.
- Documented signatures MUST match the actual signatures of the code.

#### 3. Setup and Usage Documentation

- Every project MUST provide a top-level document describing how to install, configure, build, run, and use the system.
- The document MUST allow a new contributor to reach a working state without external assistance.
- Setup steps MUST be verified periodically against the current state of the project.

#### 4. Architecture Documentation

- Every non-trivial system MUST provide documentation describing its overall structure, component responsibilities, communication patterns, and significant design decisions.
- Architecture documents MUST explain the rationale behind decisions so maintainers understand which choices are load-bearing.
- Architecture documents MUST be updated when those decisions change.

### Required Properties

All documentation MUST satisfy each of the following:

- **Consistent formatting**: style and structure conventions MUST be applied uniformly across the documentation set.
- **Comprehensive coverage**: every parameter, return value, side effect, and known failure mode MUST be described.
- **Realistic usage examples**: where examples are provided, they MUST reflect actual, current usage of the interface.
- **Cross-references**: related documents MUST be linked so readers can navigate between them without searching.

### What to Capture

Before writing documentation, the author MUST identify:

- Which parts of the system will confuse a future developer.
- What context is required to safely modify the code.
- Which design decisions are critical and must be preserved.
- What failure modes future maintainers must be warned about.

### Audience Awareness

- Documentation MUST be written for a specific audience: users, application developers, or system maintainers.
- A single document MUST NOT attempt to serve all audiences; separate documents are required for separate concerns.
- Terminology MUST match the audience's vocabulary: business terms for users, technical terms for developers.

### Accuracy Validation

- Documentation MUST be verified against the actual behavior of the code, not against intent or assumption.
- When code behavior changes, the corresponding documentation MUST be updated in the same change.
- Documentation found to be incorrect MUST be repaired immediately, not deferred.

### Content Focus

- Documentation MUST explain WHY and WHEN, not merely WHAT.
- Business logic, edge cases, error conditions, and intended usage scenarios MUST be documented so readers can decide when and how to use the code.
- Internal implementation details MUST NOT be documented in public-facing documentation; they belong with the implementation.

---

## Quick-reference Checklist

Use this checklist during code review, design, and pre-merge verification. Each item maps to one or more of the sections above.

### Correctness & Quality Foundations

- [ ] Code produces correct results for all defined inputs and satisfies its specification.
- [ ] Correctness is verified through automated checks, not manual inspection.
- [ ] Performance optimization has not been applied before correctness, readability, and maintainability are solid.
- [ ] Technical debt introduced is tracked and has an owner.

### Coding Standards

- [ ] Code was produced incrementally in small validated steps; interface and contract were defined before implementation.
- [ ] New code follows the established patterns, conventions, and abstractions of the codebase.
- [ ] New code integrates through declared interfaces, not by reaching into module internals.
- [ ] Every operation that can fail handles failure explicitly; no silent failures or swallowed exceptions.
- [ ] Inputs crossing trust boundaries (user input, external services, persisted data) are validated before use.
- [ ] All identifiers reflect domain language and are descriptive without consulting external docs.
- [ ] No magic numbers or string literals embedded in business logic; all extracted to named constants.
- [ ] Functions are small enough that their purpose can be stated in a single sentence.
- [ ] Nesting depth is minimal; deep nesting has been flattened via early returns or extracted functions.
- [ ] Sensitive data is not logged, exposed in error messages, or transmitted without protection.

### Anti-patterns & Red Flags

- [ ] No duplicated blocks; all repeated logic consolidated into a shared implementation.
- [ ] No phantom dependencies: every referenced library exists, is maintained, and uses its current interface.
- [ ] No over-engineering: every abstraction is justified by a current, real requirement (YAGNI verified).
- [ ] Tests exercise real behavior and cover failure cases, not only happy paths (no test theater).
- [ ] Diff reviewed for removals as well as additions; no existing functionality silently removed.

### Code Review

- [ ] Structure and organization: concerns are separated, responsibilities are not mixed.
- [ ] Naming and clarity: all names are descriptive; non-obvious logic has a brief explanatory comment.
- [ ] Error handling: all failure paths use project-standard mechanisms; edge cases are addressed.
- [ ] Testability: the unit has a single responsibility, injectable dependencies, and predictable behavior.
- [ ] Architectural mismatch check: similar features in the codebase reviewed to confirm consistency.

### Refactoring

- [ ] A passing test suite exists (or characterization tests have been added) before refactoring begins.
- [ ] The intended outcome is stated: what improves and how it will be verified.
- [ ] Each refactoring step is one focused operation, committed individually.
- [ ] No new features, behavior changes, or external dependencies are bundled into the refactoring.
- [ ] Outcome is measurable along at least one of: maintainability, testability, performance, or security.

### Documentation

- [ ] All public functions, classes, and interfaces document purpose, parameters, return values, and failure modes.
- [ ] Inline comments explain WHY, not WHAT; no comments restate the code in prose.
- [ ] Project provides a top-level setup/usage document sufficient for a new contributor to self-serve.
- [ ] Architecture documentation exists and explains the rationale behind load-bearing design decisions.
- [ ] Documentation has been verified against actual code behavior, not intent; outdated docs are corrected.
