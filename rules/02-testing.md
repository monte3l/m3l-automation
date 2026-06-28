# Testing

## Overview

The test suite is a layered safety net that gives the development team confidence to change, refactor, and ship software. It is organized as a pyramid of three complementary layers — unit tests at the base, integration tests in the middle, and end-to-end tests at the top — each serving a distinct purpose that no other layer can substitute. Tests must be treated as production code: named precisely, maintained continuously, parameterized to eliminate repetition, and grown deliberately alongside the codebase. When practiced as Test-Driven Development, the act of writing tests first also functions as a design discipline that shapes APIs and exposes structural weaknesses before any implementation decision is committed.

---

## Core Principles

1. **The suite must follow the pyramid shape.** Many fast isolated unit tests at the base, fewer integration tests in the middle, a small number of end-to-end tests at the top. An inverted pyramid or flat distribution is prohibited.
2. **Every test must verify observable behavior, not internal implementation details.** Tests coupled to private code paths break during refactoring without catching real regressions.
3. **Every test must be deterministic.** A test that passes and fails intermittently for reasons unrelated to the code under test is a defect; it must be diagnosed and fixed, never tolerated.
4. **Every test must be isolated.** No test must depend on the order or outcome of another test, and no test must leave residual state that affects subsequent tests.
5. **Test names must describe the behavior being verified.** A failure message must identify what behavior broke without requiring the reader to inspect the test body.
6. **Tests must be derived from explicit requirements.** Acceptable sources include API contracts, user stories, acceptance criteria, and bug reports — not the implementation itself.
7. **Meaningful coverage is the goal, not raw line counts.** Coverage must include error paths, edge cases, and integration boundaries, not only happy paths. Coverage figures alone must not be treated as evidence of quality.
8. **Tests must be treated as production code.** They must be refactored, parameterized, documented, and kept healthy. A test suite that degrades becomes a liability that masks defects and slows development.
9. **Test doubles must be used deliberately and sparingly.** They must isolate the unit under test from external systems, not substitute for real integration testing, and not disguise poor production design.
10. **The TDD Red-Green-Refactor cycle must not be skipped or merged.** Each step has a distinct purpose; combining them defeats the methodology's design and verification benefits.
11. **A test that no longer satisfies its selection criteria must be removed or demoted.** Outdated, redundant, or unjustifiably expensive tests are noise; they erode trust and slow the suite.
12. **Difficulty testing code is a design signal, not a test problem.** When a unit is hard to test, the design must be revised rather than the test weakened.

---

## Test Strategy & Pyramid

### Pyramid Layers

- The base of the suite **must** consist of many fast, isolated unit tests.
- The middle **must** consist of fewer integration tests that verify interactions between components.
- The top **must** consist of a small number of end-to-end tests covering critical user journeys.
- The shape **must** be a pyramid, not an inverted pyramid or a flat distribution. Heavy reliance on slow, high-level tests is prohibited.

### Layer Purposes

**Unit tests (base)** verify small units of code in isolation from databases, networks, file systems, and external systems. They provide rapid, precise feedback: failures point to a specific unit. They form the foundation of trust; if unit tests are solid, higher layers are more meaningful.

**Integration tests (middle)** verify that components interact correctly at their boundaries. They exercise actual integration points — databases, message queues, external services — rather than simulated stand-ins wherever feasible. They catch defects that emerge only when real components exchange data.

**End-to-end tests (top)** verify complete user journeys through the entire system. They provide whole-system confidence for critical workflows only. They are necessarily slow and fragile; their number **must** be deliberately constrained.

### Choosing the Right Layer

Before writing a test, the author **must** choose its layer based on what is being verified:

- If behavior is localized to a single unit and does not require external systems, write a unit test.
- If behavior depends on interaction between components, write an integration test.
- If behavior is meaningful only from the perspective of an end user moving through the system, and the workflow is critical enough to justify the cost, write an end-to-end test.

For every new feature, the team **must** ask: at this stage of development, which type of test delivers the most value? Tests added without answering this question are likely misplaced in the pyramid.

### Strategic Test Planning

Every test suite **must** be designed to answer:

- What could break in production?
- What would be expensive to debug after a failure?
- What behaviors must be preserved as the code evolves?
- What error conditions could lead to data loss, security incidents, or compliance violations?

If a test does not contribute to answering at least one of these questions, its value **must** be reconsidered.

### Coverage

- A minimum line-coverage threshold appropriate to the project **must** be enforced, but coverage figures alone **must not** be treated as evidence of test quality.
- Coverage **must** include error paths, edge cases, and integration points, not only happy paths.

### Test Quality Standards

Every test **must** satisfy:

- **Clear name**: describes the behavior being verified.
- **Single behavior**: verifies one well-defined behavior.
- **Minimal setup**: setup is the minimum required for the verified behavior.
- **Deterministic**: produces the same result on every run unless the code under test has changed.
- **Isolated**: does not depend on the order or outcome of other tests.
- **Behavioral assertion**: verifies observable behavior, not internal implementation details.

---

## Unit Testing

### Required Characteristics

Every unit test **must** satisfy:

- **Fast**: executes within milliseconds. Unit tests collectively **must** give near-instant feedback.
- **Isolated**: does not depend on databases, networks, file systems, external services, or any other process. A unit test exercises code, not its environment.
- **Self-contained**: a single failure **must not** cascade into unrelated tests.
- **Numerous**: each test covers a small portion of behavior. The suite **should** have as many unit tests as needed to cover the behavior of the code.
- **Precise**: a failure **must** identify exactly which unit is responsible.

### Scope

- A unit test **must** exercise a single function, method, or small cohesive unit of logic.
- A unit test **must not** cross architectural boundaries; that role belongs to integration tests.
- A unit test **must not** use real instances of databases, queues, network clients, or file systems. Such dependencies **must** be replaced with test doubles.

### Test Categories

Unit tests **must** cover the following three categories for every unit they verify.

#### 1. The Happy Path

- Verify the most common, expected usage of the unit when all inputs are valid and all dependencies behave normally.
- Every unit **must** have at least one happy-path test.
- Happy-path tests clarify what success looks like and are typically the first tests written for new functionality.

#### 2. Edge Cases

- Verify behavior at the limits of what the unit is expected to handle: empty inputs, maximum sizes, boundary values, unusual but valid combinations, off-by-one situations, and similar cases.
- For every input parameter, the question **must** be asked: what is the most unusual but still valid input that could reach this code?

#### 3. Business Rules

- Verify that the unit enforces official policies and requirements of the application.
- Categories include: uniqueness constraints, minimum/maximum thresholds, format requirements, state transitions, and authorization conditions.
- Business-rule tests ensure the application's core logic does not drift from its specification.

### Requirements as Test Inputs

Unit tests **must** be derived from explicit requirements:

- **API contracts**: define exact paths, fields, status codes, and shapes. Use these to write precise expectation-based tests.
- **User stories and acceptance criteria**: describe desired behavior without prescribing implementation. Use these to write behavioral tests.
- **Bug reports and policies**: describe broader goals. Translate these into specific testable assertions before writing the test.

### Naming

- Test names **must** describe the behavior being verified.
- Test names **must** be specific enough that a failure message identifies what behavior failed without inspecting the test body.
- Generic or category-level test names covering "everything about a feature" are prohibited.

### Growth and Independence

- The test suite **must** grow incrementally. Attempting to cover everything from the start is prohibited.
- Start with one function and one piece of logic; cover the happy path first, then edge cases, then business rules.
- New code **must** arrive with tests, not be retrofitted later.
- Unit tests **must not** share mutable state.
- Unit tests **must not** depend on test execution order.
- Setup and teardown **must** leave the test environment as the test found it.

---

## Integration Testing

### Purpose

- Integration tests **must** verify that data flows correctly between components.
- Integration tests **must** confirm that components communicate reliably through their declared interfaces.
- Integration tests **must** catch contract defects: format mismatches, missing fields, incompatible expectations between producer and consumer.
- Integration tests **must not** duplicate the responsibilities of unit tests (internal logic of one component) or end-to-end tests (full user journeys).

### Required Characteristics

- Integration tests **must** exercise real integration points wherever feasible: actual database engines, actual message brokers, actual file systems, actual external services in a sandbox configuration.
- Integration tests **may** be slower than unit tests; this is acceptable because they verify behavior unit tests cannot.
- Integration tests **must** remain deterministic and repeatable. Flakiness **must** be diagnosed and eliminated, not tolerated.

### Test Selection

Integration tests **must** be chosen for quality, not quantity. Criteria for what to integration-test:

- The most important interactions between components.
- Boundaries where data formats are translated or contracts are crossed.
- Points where multiple services or layers must agree on shape, ordering, or timing.
- Interfaces whose defects would propagate widely if undetected.

Interactions that are unlikely to fail, or whose failure would have negligible impact, **must not** be integration-tested. Integration test budget is finite; spend it where defects would hurt.

### What Integration Tests Catch

- Data format mismatches between producer and consumer.
- Schema drift between application code and persistence layer.
- Contract changes in external services the application depends on.
- Concurrency issues that emerge only when real components share resources.
- Configuration errors that pass unit tests but fail at the seam.

### Setup and Teardown

- Integration tests **must** manage their own data lifecycle: every test **must** leave the environment in the state it found it.
- Shared state across tests is prohibited unless explicitly required by the integration being verified.
- Resources allocated for a test (database rows, files, queue entries, network listeners) **must** be released even when the test fails.

### Balance Within the Suite

- The number of integration tests **must** be lower than the number of unit tests.
- The number of integration tests **must** be higher than the number of end-to-end tests.

### Failure Mode Coverage

Integration tests **must** exercise failure conditions, not only success:

- Behavior when a downstream component is unavailable.
- Behavior when a downstream component returns malformed responses.
- Behavior when timeouts occur.
- Behavior when retries are exhausted.

Tests of failure paths are often more valuable than tests of the happy path, because the happy path is also exercised by unit and end-to-end tests while failure paths often are not.

---

## End-to-End Testing

### Purpose

- End-to-end tests **must** verify complete user journeys through the production-equivalent system.
- End-to-end tests **must** exercise every layer the journey touches: presentation, application logic, persistence, and any external integration that is part of the user-visible behavior.
- End-to-end tests **must** be reserved for the most critical workflows of the system.

### Required Scenario Structure (LNAAV)

Each end-to-end scenario **must** follow the LNAAV structure:

- **Launch**: bring up the system in a configuration equivalent to production.
- **Navigate**: drive the system through its real entry points (user interface, public API, or external integration surface).
- **Authenticate** (where applicable): exercise the authentication path that real users would follow.
- **Act**: perform the operations that define the workflow under test.
- **Verify**: confirm that the resulting system state and user-visible output match what the workflow promises.

### Selection Criteria

End-to-end tests **must** be chosen using strict criteria. A workflow qualifies only if it satisfies all of:

- It is critical to the value the system delivers.
- Its failure would directly harm users, revenue, compliance, or safety.
- It cannot be adequately covered by lower-cost unit or integration tests.

Typical qualifying categories: user registration, authentication, primary transaction flows, checkout, payment, and primary content creation.

Workflows that do not satisfy these criteria **must not** be end-to-end tested.

### Cost Acknowledgement

End-to-end tests carry inherent costs that **must** be planned for:

- **Slowness**: they can take minutes per scenario.
- **Fragility**: small interface changes (a renamed element, a moved button) can cause failures even when application logic is correct.
- **Maintenance burden**: scenario scripts **must** be kept in sync with the evolving interface.
- **Setup complexity**: a production-equivalent environment is required and **must** be maintained.

### Constraints

- The number of end-to-end tests **must** be deliberately kept small.
- Each end-to-end test **must** justify its presence against the selection criteria. Tests that no longer satisfy the criteria **must** be removed or demoted.
- End-to-end tests **must** be exercised against an environment that matches production in topology, configuration, and dependency versions to the greatest extent practical.

### Stability

- Flaky end-to-end tests **must** be diagnosed and stabilized, never ignored or muted permanently.
- Sources of nondeterminism (time, randomness, race conditions, external dependencies) **must** be controlled within the scenario.
- A consistently flaky end-to-end test **must** be quarantined and either fixed or removed; it **must not** remain in the suite producing noise.

### Reporting

- Failure output **must** include enough context for diagnosis: the step that failed, the observed system state, and any artifacts (logs, screenshots, captured responses) needed to reconstruct the failure.
- End-to-end test results **must** be visible and actionable; failures **must not** be deferred to the end of a release cycle.

---

## Test Doubles & Mocking

### Categories of Test Doubles

The following categories **must** be distinguished and used for their stated purposes.

#### Stub

- Provides canned data in place of a real dependency.
- Used when the test cares about how the code under test behaves given certain inputs, but does not need to verify how the dependency was used.

#### Mock

- Provides canned data AND records how it was used by the code under test.
- Allows the test to assert that the dependency was called, how many times, and with which arguments.
- Used when the test must verify an interaction (e.g., that a notification was sent, a record was persisted, a callback was invoked).

### Usage Rules

- Test doubles **must** be used to isolate the unit under test from slow, unpredictable, or unavailable external systems.
- Test doubles **must not** be used to replace code whose behavior is part of the unit being tested. Doing so converts a real test into test theater.
- Stubs are preferred to mocks when interaction verification is not required.
- The simplest configuration **must** be preferred: a fixed return value is preferred over scripted sequences when sequences are not required.
- Scripted sequences **may** be used to simulate failures, retries, or ordered responses, and only when the test requires such behavior.
- Test doubles **must** be scoped narrowly: configured for the specific test that needs them and cleaned up immediately after, so that one test's setup never leaks into another.

### Design for Testability

- Production code **must** be designed so that dependencies are injectable or otherwise replaceable. Hard-wired references to external systems impede testing and **must** be avoided.
- Business logic **must** be kept pure where possible: free of external side effects, deterministic given the same inputs. Pure logic is testable without any doubles at all.
- Where doubles are unavoidable, they **must** be confined to a thin shell at the boundary of the system. The core **must** remain testable without them.

### Boundaries of Mocking

- Mocking **must not** replace integration testing. Tests that mock every external system verify only that the code calls its dependencies the way the test author expected — not that the dependency actually works.
- For systems whose behavior is critical (databases, message brokers, external services), integration tests **must** exercise the real components in addition to unit tests that use doubles.

### Anti-Patterns (Prohibited)

- Mocking a unit and then asserting only that the mock was called. This verifies nothing about behavior.
- Building elaborate mock setups that mirror the behavior of the real dependency. If the mock is as complex as the real thing, the test should exercise the real thing.
- Using mocks to make a brittle test pass by suppressing the real interaction it failed against.
- Relying on mocked behavior to mask defects in the dependency's contract.

---

## Test Maintenance & Parameterization

### Properties of a Healthy Test Suite

A test suite is healthy when all of the following hold:

- Tests reliably catch regressions in existing behavior.
- Refactoring can be performed with confidence because tests provide a safety net.
- Deployments proceed predictably; automated checks provide assurance.
- Development remains fast and smooth without test-related friction.

If any of these conditions degrades, the test suite is unhealthy and remediation **must** begin immediately.

### Common Pitfalls and Required Responses

| Symptom                                                                                       | Required Response                                                                                                                                            |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Duplicated setup**: identical or near-identical setup code repeated across many tests.      | Extract setup into shared fixtures so a single update propagates everywhere.                                                                                 |
| **Real I/O in unit tests**: unit tests that access databases, networks, or files.             | Replace external interactions with test doubles. Real I/O belongs in integration tests.                                                                      |
| **Giant tests**: tests so large that diagnosing a failure requires substantial investigation. | Break into smaller, focused, atomic tests. Move repeated setup into fixtures.                                                                                |
| **Flaky tests**: tests that pass and fail intermittently for reasons unrelated to the code.   | Identify and eliminate the source of nondeterminism. Freeze time, seed randomness, replace unstable dependencies with doubles. Flakes must not be tolerated. |
| **Sluggish unit tests**: unit tests that take noticeable time to execute.                     | Identify hidden integration work and remove it. Move slow operations behind interfaces and replace with doubles.                                             |

### Ongoing Maintenance Rules

- Tests **must** be updated when the behavior they verify changes.
- Test names **must** be renamed when the verified behavior is renamed or redefined.
- Fixtures **must** be refactored when setup logic changes; updating the fixture once is preferred over editing every test individually.
- Redundant tests **must** be removed. Duplicate coverage and tests of internal implementation details are noise that obscures real failures.
- Behavioral assertions **must** be preferred over assertions tied to internal implementation or private code paths.

### Test Parameterization

Repetition in tests violates the same DRY principle that applies to production code. Parameterization **must** be applied wherever the same logic is exercised against multiple inputs.

#### Setup-level parameterization

- Common setup **must** be centralized into reusable fixtures that supply preconfigured objects, test data, or resources to multiple tests.
- Tests **must** receive their dependencies prepared, allowing the test body to focus on behavior under verification.

#### Case-level parameterization

- A single test body **must** be exercised against multiple input/expected pairs when the same logic applies to each pair.
- Each parameterized case **must** be identifiable in test output so that failures point to the specific case that failed.

#### Required properties of a well-parameterized suite

- **Reusable setup**: common setup is defined once.
- **Controlled execution scope**: fixtures use the appropriate scope (per-test, per-class, per-session) to balance performance and isolation.
- **Reliable cleanup**: resources are released even when tests fail, leaving no residual state.

### Resource Management

- Tests that create files, database records, processes, network listeners, or other resources **must** release those resources at the end of the test.
- Cleanup **must** be reliable in the presence of failures; cleanup **must not** be skipped because an assertion failed earlier.
- Tests **must not** depend on resources created by other tests.

### Growth Strategy

- Test coverage **must** be expanded incrementally. Begin with the most critical paths and extend coverage gradually.
- The test suite **must** be designed for growth: modular, isolated, maintainable, ready to expand alongside the codebase.

---

## Test-Driven Development

### The TDD Cycle

Every TDD iteration **must** consist of the following three steps in order. No step **must** be skipped or merged into another.

#### Step 1 — Red: Write a Failing Test

- A new test **must** be written for functionality that does not yet exist or for a defect that has not yet been fixed.
- The test **must** fail when first executed. A test that does not fail at this stage is not validated and **must not** be trusted.
- The test **must** be specific: focused on a single, well-defined aspect of the behavior being introduced.
- The test name **must** be descriptive: it **must** make clear, to any reader, what behavior is being verified.

#### Step 2 — Green: Make the Test Pass

- Only the minimum code necessary to make the failing test pass **must** be written.
- Elegant, comprehensive, or future-proofed solutions **must not** be written at this step.
- Over-engineering at this step is prohibited; refining the solution is deferred to the Refactor step.
- The goal is to validate the test by demonstrating that it can be satisfied.

#### Step 3 — Refactor: Make the Code Right

- With a passing test in place, the implementation **must** be improved without changing its observable behavior.
- Permitted refactoring: removing duplication, renaming identifiers for clarity, simplifying logic, extracting helper functions or methods, applying recognized design patterns where they solve a real problem.
- Prohibited at this step: adding new features, changing established behavior, introducing new dependencies.
- After every refactoring step, the test suite **must** be rerun in full. Any failure **must** be reverted before continuing.

### Cycle Outcomes

Each completed Red-Green-Refactor cycle **must** produce all of:

- A feature or fix that is fully implemented.
- Tests that guard the new behavior against future regressions.
- Code that is clean, maintainable, and ready for further work.

### Test Quality Requirements Under TDD

Tests written under TDD **must** satisfy all of:

- **Specific**: focused on a single, well-defined aspect of behavior.
- **Descriptive**: named so the verified behavior is obvious from the test name alone.
- **Self-validating**: passes or fails clearly, with no manual interpretation required.
- **Repeatable**: produces the same result on every run.

Generic, broad, or vaguely named tests are prohibited under TDD; they undermine the discipline.

### TDD as a Design Discipline

- The Red-Green-Refactor cycle **must** be treated as a design tool, not solely a verification tool.
- Writing the test first forces the author to consider the API, the contract, and the failure modes of the unit before any implementation choices are made.
- Designs that are difficult to test are typically poor designs; the difficulty **must** be treated as a signal to revise the design, not to weaken the test.

### Relationship to the Test Pyramid

- Unit tests written under TDD **must** be supplemented by integration and end-to-end tests for behaviors that span multiple units or rely on real external systems.
- TDD does not replace the test pyramid; it determines how unit tests are produced and what they look like.

### Discipline

- Implementation code **must not** precede its test. Writing implementation first and tests afterward is not TDD and **must not** be claimed as such.
- The cycle **must** be applied iteratively, in small steps. Large batches of tests followed by large batches of implementation defeat the methodology.
- Each cycle **must** aim for a small, complete, valuable milestone.

---

## Anti-patterns & Red Flags

### Test Suite Shape

- **Inverted pyramid**: more end-to-end tests than unit tests. Produces a slow, fragile suite that gives poor diagnostic precision.
- **Flat distribution**: equal numbers at each layer with no deliberate hierarchy. Fails to exploit the cost-feedback tradeoff between layers.
- **No pyramid consideration**: adding tests without choosing a layer first. Leads to misplaced tests that neither verify the right things nor provide appropriate feedback speed.

### Test Design

- **Testing implementation, not behavior**: assertions tied to private methods, internal state, or call sequences that are invisible to callers. These tests break during refactoring without catching real regressions.
- **Generic or category-level test names**: names like `testUserService` or `testCalculate` that identify a module rather than a behavior. Failures from these tests require inspecting the test body to understand what broke.
- **Giant tests**: one test that covers multiple behaviors or exercises multiple units. When it fails, the failure points nowhere useful.
- **Happy-path-only coverage**: tests that verify only the ideal scenario. Error paths, edge cases, and boundary conditions remain untested until production failures reveal them.
- **Test theater**: mocking the unit under test or mocking a unit and asserting only that the mock was called. This verifies the test's own assumptions, not the behavior of any real code.

### Test Doubles

- **Over-mocking**: replacing every dependency with a double, including internal collaborators whose behavior is part of the feature being tested.
- **Elaborate mock setups**: doubles that replicate the logic of the real dependency. If the mock is as complex as the real thing, the test should exercise the real thing.
- **Mocking as a substitute for integration testing**: tests that mock every external system give false confidence that the system works end-to-end.
- **Leaking double configuration**: a double configured for one test affects another because scope was not properly constrained.

### Test Maintenance

- **Tolerating flaky tests**: intermittently failing tests that are ignored, muted, or re-run to pass. They erode trust in the entire suite and mask real failures.
- **Neglecting cleanup**: tests that leave database rows, files, or other resources behind. These create invisible ordering dependencies that cause intermittent failures.
- **Failing to update tests after behavior changes**: stale tests that verify superseded behavior. They produce false passes or false failures and misdirect investigation.
- **Redundant coverage**: multiple tests that verify the same behavior. When the behavior changes, every duplicate must be updated; when one fails, the signal is obscured.
- **Copy-paste test bodies**: repeated test code that diverges over time, creating maintenance debt and inconsistent coverage.

### TDD Discipline

- **Skipping the Red step**: writing implementation before writing a failing test. The test is never validated as an actual detector of failure.
- **Over-engineering in the Green step**: writing a full, elegant solution before the test suite justifies it. Defers the design feedback that TDD is meant to surface.
- **Merging Refactor into Green**: cleaning up and adding features at the same time. Produces a muddled commit history and defeats the cycle's safety net.
- **Writing TDD in large batches**: writing many tests, then many implementations, rather than iterating one small cycle at a time.

### End-to-End Misuse

- **Covering everything end-to-end**: using E2E tests for low-value or non-critical workflows. The cost is not justified; the suite becomes slow and fragile.
- **Ignoring flaky E2E tests**: leaving flaky end-to-end tests in the suite permanently. They produce noise, erode confidence, and hide real failures.
- **Testing against non-production-equivalent environments**: running E2E tests against configurations that differ from production in topology or dependency versions. Results are not representative.

---

## Quick-reference Checklist

Use this checklist during code review or test design to verify the suite remains healthy.

### Strategy & Pyramid

- [ ] Test suite follows the pyramid: many unit tests, fewer integration, a small number of E2E
- [ ] Each test is placed at the correct layer for what it verifies
- [ ] Coverage includes error paths, edge cases, and boundary conditions, not only happy paths
- [ ] Coverage threshold is enforced but not treated as the sole quality signal

### Unit Tests

- [ ] Each unit test executes within milliseconds and uses no real databases, networks, or files
- [ ] Each unit has at least one happy-path test, edge-case tests, and business-rule tests
- [ ] Test names describe the behavior being verified, not the unit's name
- [ ] No unit test shares mutable state with or depends on the execution order of another test
- [ ] New code ships with unit tests; no retroactive coverage allowed

### Integration Tests

- [ ] Integration tests exercise real integration points (actual databases, services, message brokers)
- [ ] Integration tests cover failure modes: unavailability, malformed responses, timeouts, retry exhaustion
- [ ] Every integration test manages its own data lifecycle and cleans up even on failure
- [ ] Count of integration tests is fewer than unit tests and more than E2E tests

### End-to-End Tests

- [ ] Each E2E test covers a workflow that is critical, user-facing, and not adequately covered below
- [ ] Each scenario follows the LNAAV structure (Launch, Navigate, Authenticate, Act, Verify)
- [ ] E2E environment matches production in topology, configuration, and dependency versions
- [ ] Flaky E2E tests are quarantined and assigned for fix or removal; none remain muted indefinitely
- [ ] Failure output includes step, system state, logs, screenshots, or captured responses

### Test Doubles

- [ ] Stubs are used when interaction verification is not required; mocks only when it is
- [ ] No double replaces the code under test itself
- [ ] No double is more complex than the real dependency it replaces
- [ ] Integration tests exercise the real components, not just mocked versions
- [ ] Double scope is narrowly confined to the test that needs it

### Maintenance & Parameterization

- [ ] Repeated setup is extracted into shared fixtures
- [ ] Parameterization is applied wherever the same logic is exercised against multiple inputs
- [ ] Each parameterized case is identifiable by name in test output
- [ ] Cleanup runs reliably even when assertions fail mid-test
- [ ] Redundant tests are removed; stale tests are updated when behavior changes

### TDD

- [ ] Every test is written before the implementation it verifies (Red step precedes Green)
- [ ] Green step writes the minimum code to pass the test, nothing more
- [ ] Full suite is rerun after every Refactor step; any failure is reverted before continuing
- [ ] Each TDD cycle produces a small, complete, valuable milestone
- [ ] Difficulty testing is treated as a design signal, not a reason to weaken the test
