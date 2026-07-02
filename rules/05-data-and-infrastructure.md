# Data & Infrastructure

## Overview

The Data & Infrastructure domain governs how systems store, protect, move, and deliver data at every scale and in every environment — from relational databases and distributed data lakes, through governance frameworks and encryption controls, to CDN edge caches, constrained IoT devices, batch jobs, streaming pipelines, and the CI/CD machinery that turns source code into running software safely. Rules in this domain share a common concern: decisions made here are expensive to reverse, so they must be grounded in actual access patterns and operational requirements, enforced through automation, and kept continuously observable.

---

## Core Principles

1. **Match technology to actual workload.** Storage engines, processing paradigms, protocols, and deployment topologies must be selected against the real shape of the data and traffic, not assumed patterns or technological preference.
2. **Automate enforcement.** Encryption key rotation, access-control reviews, security gates, flaky-test quarantine, and compliance checks must run automatically; manual-only controls are insufficient.
3. **Design for failure as the normal case.** Network failures, node loss, device disconnection, and build flakiness are not exceptional events; every architecture must degrade gracefully rather than collapse.
4. **Make every system observable.** Storage usage, query performance, cache hit ratios, device health, pipeline durations, and governance signals must all be instrumented and visible; blind operation is prohibited.
5. **Embed governance from the start.** Access controls, encryption, data lineage, and audit trails must be built into pipelines and systems at design time, not added after the fact.
6. **Preserve determinism and reproducibility.** Batch jobs must be idempotent and restartable; builds must produce the same artifact from the same source; schema migrations must have rollback paths.
7. **Apply the principle of least privilege universally.** Identities, services, and devices receive the minimum permissions required to perform their function, reviewed and revoked as roles change.
8. **Choose consistency models deliberately and document them.** Every distributed store has a consistency model; the model must be documented and the application designed around it.
9. **Separate concerns across layers.** Cache layers, processing pipelines, deployment stages, and device hierarchy layers each have distinct responsibilities; skipping layers or conflating them degrades both correctness and maintainability.
10. **Treat latency budgets as first-class requirements.** Streaming vs. batch, edge vs. origin, and CDN routing decisions must all be anchored to explicit, measured latency targets.
11. **Version and immutably tag every artifact.** Artifacts, schemas, firmware, and data snapshots must be uniquely versioned and traceable to their origin; rebuilding or mutating after promotion is prohibited.
12. **Assign ownership to every policy.** Every governance control, quality gate, and security rule must have a named owner accountable for its enforcement and remediation.

---

## Data Persistence & Scaling

### Storage Selection

- Storage technology must be chosen against the actual shape of the workload:
  - Complex relationships and strong transactions: relational engine.
  - Fast full-text search: search-oriented engine.
  - High-write, schema-flexible data: document or wide-column store.
  - Time-series data: time-series engine.
  - Strictly key-keyed lookups: key-value store.
- Choosing storage without first characterizing access patterns is prohibited.

### Optimization at Scale

- Searchable fields must be indexed; indexes must be designed against actual query patterns. Unused indexes waste write capacity and storage and must be removed.
- Large tables must be partitioned by keys that support the most common range scans; partition keys must be chosen for both query efficiency and balanced distribution.
- Historical data accessed infrequently must be archived to lower-cost tiers so primary stores remain efficient.
- Persisted data may be compressed where the trade-off between CPU and storage favors compression.

### Big Data Dimensions

Architectures must be evaluated against all three dimensions:

- **Volume**: when data scales beyond what a single machine can hold or process, distributed storage and processing become necessary.
- **Velocity**: when data arrives faster than batch systems can absorb, streaming ingestion and processing become necessary.
- **Variety**: when data spans structured records, semi-structured documents, and unstructured media (text, images, audio, video), heterogeneous storage and processing are required.

### Scaling Triggers

The following symptoms must trigger consideration of distributed computing, partitioning strategies, and orchestrated processing rather than further vertical scaling:

- Transaction volume degrades overall response times.
- Search performance degrades unacceptably even with appropriate indexes.
- Data pipelines fail with resource exhaustion.
- Backup and recovery windows exceed acceptable bounds.

### Distributed Data Systems

- Any cross-node operation can fail or time out; persistence operations must handle this.
- Every distributed store has a consistency model (strong, causal, eventual, read-your-writes); the chosen model must be documented and the application designed around it.
- Cross-node consensus is expensive; coordination must be minimized.
- Even small error rates produce many incorrect records at high volume; data validation and reconciliation must be in place.

### Managed Services

- Managed persistence services reduce operational burden but do not eliminate architectural responsibility.
- Partitioning strategy, indexing, monitoring, and failure tolerance must still be designed thoughtfully.
- Storage usage, query performance, and failure rates must be visible.

### Schema and Migration Discipline

- Schema changes must be planned with rollback in mind; every change must have a path back.
- Backwards-incompatible schema changes must be coordinated with all readers and writers.
- Migrations must be tested against representative data volumes before being applied to production.

---

## Data Governance & Security

### Access Control

- **RBAC** must provide the baseline: identities are assigned roles, and roles carry permissions.
- **ABAC** must be added wherever contextual factors matter: time, location, request origin, requester attributes, or data attributes.
- **Principle of Least Privilege**: every identity must receive the minimum permissions required; permissions must be reviewed and revoked as roles change.
- Emergency elevated access must be granted temporarily, logged in full detail, and reviewed afterward.

### Encryption

- Data at rest must be encrypted using current, vetted algorithms.
- Data in transit must be encrypted between every component, internal or external.
- Keys must be managed by a dedicated key management service; embedding keys in code, configuration files, or images is prohibited.
- Key rotation must be scheduled and automated; manual rotation alone is insufficient.

### Anonymization and Pseudonymization

- **Anonymization** must irreversibly remove identifying information when downstream users do not need to identify individuals.
- **Pseudonymization** must replace identifiers with tokens that can be re-linked only by authorized parties holding the mapping.
- Administrative, analytical, and reporting workflows must operate on anonymized or aggregated data wherever possible.

### Data Minimization

- Only the minimum data necessary for the stated purpose must be collected.
- Identifying details that are not required must be removed before storage or further processing.
- Retention periods must be defined explicitly; data must be deleted or archived when the period expires.

### Data Lineage

- Every dataset must be traceable from its origin through every transformation it undergoes.
- Lineage must be queryable: given a record, an authorized investigator must be able to reconstruct its source and transformations.
- Lineage is required for compliance audits, debugging quality issues, and identifying the root cause of incorrect outputs.

### Audit Trails

- Access to sensitive data must be logged with sufficient detail to reconstruct what was accessed, by whom, when, and why.
- Audit logs must be tamper-evident and stored separately from the systems they audit.
- Audit logs must be retained for the duration required by applicable regulations.

### Monitoring for Governance

- Monitoring must include governance-relevant signals: unusual access patterns, denied requests, exports of sensitive data, and transformations applied to regulated fields.
- Alerts must be defined for unauthorized access attempts, unusual volumes, access from unexpected locations, and unexpected roles touching regulated data.

### Regulatory Compliance

- Applicable regulations must be identified before system design begins.
- Compliance requirements must be translated into concrete controls, not treated as documentation overhead.
- Compliance posture must be re-evaluated as the system evolves; changes in code or data flow can affect compliance.

### AI Governance

When the system uses machine learning or algorithmic decisions:

- **Bias testing**: models must be evaluated against fairness criteria before deployment and periodically thereafter.
- **Algorithmic fairness**: outcomes across protected groups must be measured; disparities must be explained or remediated.
- **Explainability**: where decisions affect people, the rationale for individual decisions must be reconstructable to a degree adequate for review and contestation.
- **Human-in-the-loop**: high-stakes automated decisions must be subject to human review before being acted on.
- **Auditability**: model inputs, outputs, and versions must be recorded so historical decisions can be reviewed.

### Embedding Governance into Pipelines

- Governance controls must be embedded into data pipelines from the start, not bolted on after the fact.
- Cloud-native security primitives must be combined with explicit policies and workflows.
- Responsibility for governance must be assigned; someone owns each policy and is accountable for its enforcement.

---

## Edge & CDN

### Multi-Layer Caching

CDN-based systems must treat caching as a layered concern. All three layers must be addressed deliberately:

- **Client caches**: cache headers must be set explicitly per resource.
- **CDN edge caches**: cache rules must be configured per content type and per access pattern.
- **Application caches**: eviction policies must be defined per cache.

### Cache Invalidation

- Every cached resource must have a defined freshness policy: a TTL, an event-driven invalidation rule, or both.
- TTL values must be chosen based on how often the underlying resource changes and how stale users can tolerate it being.
- Cache purging mechanisms must exist for emergency invalidation of incorrect or sensitive content.
- Personalized or user-specific content must not be cached at shared layers unless explicitly partitioned by identity.

### Content Distribution Strategies

- **Push-based distribution**: popular, predictable content must be proactively pushed to edge nodes ahead of demand.
- **Pull-based distribution**: personalized or unpredictable content must be fetched on first request and cached if appropriate.
- **Hierarchical caching**: large CDNs must organize edges into regional clusters that feed local nodes, reducing origin load.

### Intelligent Routing

Routing decisions must be based on user location and network topology, real-time network conditions, origin and edge server load, and historical access patterns. The routing strategy must be observable and inspectable for diagnosis when delivery fails.

### Edge Computation

Edge nodes must be considered for computation — not only caching — when per-user transformations, geographic personalization, security checks (authentication, rate limiting, request validation), or dynamic content assembly can be performed close to the user. Code running at the edge must be designed for the constraints of edge environments: short execution time, limited state, and operation across many distributed instances.

### Performance Targets

- Latency targets must be defined explicitly per critical content category.
- Load time targets must be measured against real user metrics, not synthetic benchmarks alone.
- The system must be designed to absorb traffic spikes that would overwhelm origin-only architectures.

### Observability

- Cache hit ratios must be monitored per cache layer and per content category.
- Origin offload must be measured.
- Latency must be measured at the edge, not only at the origin.
- Stale-content incidents must be detectable and traceable.

---

## Edge & IoT

### Operating Assumptions

Systems handling constrained devices must be designed against these assumptions:

- Network connectivity is unreliable; intermittent disconnection is normal, not exceptional.
- Devices may be deployed in physically inaccessible locations.
- Power, memory, and processing budgets are limited and must be respected.
- Devices may fail permanently; the system must degrade gracefully rather than guarantee recovery.

### Network Topology

- Mesh networks must be considered where devices can form interconnected webs routing messages around failed nodes.
- The system must tolerate intermediate node failures; messages must automatically reroute through alternative paths.
- Network topology must be inspectable: operators must be able to see current device connectivity and routing.

### Protocol Selection

- Publish-subscribe protocols designed for constrained environments are appropriate for many-to-one sensor-data communication.
- Lightweight request-response protocols are appropriate for simple queries against constrained devices.
- Heavyweight protocols designed for high-resource environments must not be imposed on constrained devices.
- Every protocol selection must be evaluated against the device's processing capacity, memory, power budget, and network bandwidth.

### Local Processing

- **Local computation**: devices must process data locally when the result is more valuable than the raw input and the local processing budget allows.
- **Sensor fusion**: data from multiple sensors on the same device or in the same vicinity must be combined to produce richer insights and reduce upstream bandwidth.
- **Filtering and aggregation**: raw streams must be filtered, downsampled, or aggregated locally so that only relevant data is transmitted.

### Hierarchical Architecture

Constrained-device systems must follow a hierarchical structure:

- **Local gateways** aggregate data from nearby devices and provide a local processing point.
- **Regional controllers** manage groups of gateways, perform coarser aggregation, and coordinate local behavior.
- **Central systems** handle global coordination, long-term storage, and analytics.

Each layer must be able to function independently if higher layers are unreachable.

### Fault Tolerance

- Where a device cannot be replaced, redundant sensors must be deployed so single-sensor failures do not blind the system.
- When components fail, the system must continue operating in reduced capacity rather than failing entirely.
- Devices and gateways must attempt to recover automatically from transient failures (self-healing).

### Energy Efficiency

- Transmissions must be batched and scheduled to align with low-cost windows or to minimize radio wake time.
- Data rates must adjust to network conditions to avoid wasted energy on failed transmissions.
- Devices may share routing or processing responsibilities to spread energy cost across the fleet.

### Security for Constrained Devices

- Devices must authenticate to the system before being trusted; unauthenticated devices must not be accepted into the topology.
- Communications between devices and any upstream component must be encrypted.
- Device identities and keys must be provisioned securely and rotated on a defined schedule.
- Firmware updates must be signed and verified before installation.

### Observability

- Device health (battery, connectivity, error rates, firmware version) must be visible to operators.
- Operators must be able to diagnose problems without physical access to devices wherever possible.
- The system must distinguish device failure, network failure, and data quality failure in its observability surface.

---

## Batch & Streaming

### Batch Processing

Batch processing must be selected when updates are not required in real time, cost efficiency matters more than immediacy, workloads naturally accumulate (monthly reports, model training, daily aggregations), or compute resources can be allocated for the duration of the job and released afterward.

Rules for batch design:

- Jobs must be idempotent: rerunning a job must produce the same result given the same input.
- Job inputs must be deterministic and reproducible; jobs must run against immutable snapshots of input data.
- Failed jobs must be restartable from a known checkpoint without producing duplicate output.
- Resource use must be bounded; jobs must be designed to fit available memory, storage, and time budgets, with explicit chunking when data exceeds those budgets.
- Where parallelism is available, batch jobs must exploit it; the unit of parallelism must be chosen based on data shape.

### Streaming Processing

Streaming must be selected when decisions must be made on individual events within tight latency budgets, events have time-critical value (fraud detection, alerting, real-time pricing, immediate user feedback), or continuous monitoring is required and periodic batches would miss critical patterns.

Rules for streaming design:

- Processing semantics must be specified explicitly: at-most-once, at-least-once, or exactly-once.
- Consumers must be idempotent unless exactly-once semantics are guaranteed by the platform end to end.
- Out-of-order delivery must be expected and handled: event time must be distinguished from processing time, and lateness windows must be defined.
- **Backpressure** must be designed for: when downstream processors fall behind, the system must slow upstream producers, buffer durably, or shed load deliberately.
- Continuous resource consumption must be planned for; stream processors run around the clock, even during quiet periods.

### Selection Criteria

For every processing workload, the team must answer:

- What is the maximum acceptable latency between event arrival and result availability?
- What is the cost difference between batch and streaming for this workload at expected scale?
- Does the workload tolerate periodic updates, or does it require continuous processing?
- Can the workload be re-run from raw inputs if reprocessing is required?

Where latency requirements are loose (minutes, hours, or longer), batch should be preferred for cost efficiency and simplicity. Where latency requirements are tight (seconds or sub-second), streaming must be used.

### Hybrid Approaches

- Hybrid batch-plus-streaming architectures may be used when historical reprocessing and real-time delivery are both required.
- Hybrid architectures must keep the two pipelines independently testable and operable.
- The semantics for reconciling batch results with streaming results must be defined: which is authoritative and how discrepancies are resolved.

### Optimization

- Chunk size and parallelism must be tunable in batch systems based on data volume.
- Data must be filtered or partitioned where possible so each job processes only relevant data.
- Incremental processing must be preferred when previous outputs can be reused as a baseline rather than recomputed from scratch.

---

## CI/CD Pipelines

### Pipeline Responsibilities

Every CI/CD pipeline must at minimum:

- Build the project deterministically from source.
- Run automated tests at the appropriate layers.
- Produce immutable, versioned artifacts.
- Validate against security, quality, and compliance gates.
- Deploy through controlled stages with explicit promotion criteria.

### Feedback Speed

- The fastest checks must run first: lint, static analysis, unit tests. Failures here must short-circuit further work.
- Slower stages (integration tests, end-to-end tests, security scans) must follow only when fast stages pass.
- The total time from commit to actionable feedback must be tracked and treated as a service-level objective.

### Predictive Test Selection

- Code changes may be analyzed against historical test results to select a relevant subset of the test suite.
- Selected subsets must be augmented by periodic full runs so that no test goes unrun for extended periods.
- Test selection must be auditable: the criteria for selecting tests must be documented and reproducible.

### Flaky Test Management

> **Scope note.** Quarantine is a general large-suite CI practice — a way to keep a
> big, slow suite shippable while a flake is triaged. It is **not** a licence to
> mute this library's tests: `@m3l-automation/m3l-common` runs a small, fast,
> unit-only suite, so a flake is diagnosed and fixed immediately, never parked. See
> the [Style Guide § Determinism](../docs/contributing/style-guide.md#parameterization--determinism).

- Tests that intermittently fail without code changes must be detected automatically.
- Detected flaky tests must be quarantined: they must not block the build, but they must be tracked as defects until stabilized.
- Quarantined tests must have explicit owners and remediation deadlines.
- A test must not remain quarantined indefinitely; if it cannot be stabilized, it must be removed.

### Failure Clustering

- When multiple tests fail simultaneously, failures must be grouped by signature (stack trace, error message, failing assertion) to identify common root causes.
- The pipeline must surface the cluster rather than emit redundant individual alerts.

### Failure Diagnostics

- Relevant logs, artifacts, and environmental context must be captured automatically on failure.
- Failure severity must be classified (build failure, test failure, security gate failure, deploy failure).
- Diagnostic information must be surfaced where the change author can act on it.

### Build Determinism

- Builds must produce the same artifact from the same source, given the same configuration.
- Non-deterministic build inputs (timestamps, hostnames, network-fetched dependencies without version pinning) must be eliminated or controlled.
- Build environments must be defined declaratively and version-controlled alongside the source they build.

### Artifact Discipline

- Every artifact promoted through the pipeline must be immutable.
- Every artifact must be uniquely versioned and traceable to its source commit.
- The same artifact must be used across all environments; rebuilding for each environment is prohibited.

### Deployment Stages

- Lower environments must validate that the artifact behaves correctly under conditions approximating production.
- Each stage must have defined acceptance criteria; promotion must be conditional on these criteria passing.
- Production deployments must support rollback to the previously deployed version, automated or one-step manual.

### Security Gates

- Dependency scanning, secret detection, and vulnerability checks must run in the pipeline.
- Critical findings must block promotion; lower-severity findings must be tracked and remediated on a defined schedule.
- Security gates must run automatically and consistently; manual review alone is insufficient.

### Quality Gates

- Code quality checks (lint, static analysis, complexity, coverage) must run in the pipeline.
- Each project must define which findings block promotion and which are advisory.
- Gates must be enforced uniformly; bypassing gates for individual changes is prohibited unless an explicit, time-bounded exception is recorded.

### Observability and Communication

- Pipeline success rates, durations, and failure modes must be visible.
- Long-running or unstable stages must be identifiable; pipeline health must be reviewed regularly.
- Failures must be communicated to the change author through the most direct channel available.
- Successes must not be noisy; failures must be loud enough to be acted on.
- Any contributor must be able to see the current state of the pipeline for any change.

---

## Anti-patterns & Red Flags

### Persistence

- Selecting a storage engine based on familiarity or trend rather than workload shape.
- Applying further vertical scaling when distributed partitioning is the correct solution.
- Skipping schema migration testing against representative data volumes.
- Backwards-incompatible schema changes deployed without coordinating all readers and writers.
- No rollback path for schema changes.

### Governance & Security

- Embedding encryption keys in source code, configuration files, or container images.
- Manual-only key rotation without automation.
- Collecting more data than the stated purpose requires, or retaining data past its defined expiration.
- Deploying ML models without bias testing or without measuring outcomes across protected groups.
- Adding governance controls after pipelines are built rather than designing them in from the start.
- Audit logs stored in the same system they audit, making them susceptible to tampering.
- Compliance treated as documentation overhead rather than enforced through concrete controls.

### Edge & CDN

- Setting uniform TTLs without considering per-resource change frequency or staleness tolerance.
- Caching personalized content at shared edge layers without identity-based partitioning.
- No purge mechanism for emergency invalidation of incorrect or sensitive cached content.
- Measuring latency only at the origin, missing edge-side degradation.

### Edge & IoT

- Assuming reliable connectivity for constrained devices and not designing for offline operation.
- Transmitting all raw sensor data upstream without local filtering, aggregation, or sensor fusion.
- Imposing heavyweight protocols on resource-constrained devices.
- Allowing unauthenticated devices into the network topology.
- Deploying unsigned or unverified firmware updates.
- No hierarchical independence: lower layers fail if higher layers are unreachable.

### Batch & Streaming

- Choosing streaming for workloads with loose latency requirements, incurring unnecessary continuous cost.
- Batch jobs that are not idempotent or not restartable from checkpoints.
- Streaming consumers that are not idempotent when exactly-once semantics are not guaranteed.
- Ignoring backpressure: allowing slow downstream processors to exhaust upstream resources.
- Failing to distinguish event time from processing time, causing incorrect windowed aggregations.
- Hybrid architectures with undefined reconciliation semantics between batch and streaming results.

### CI/CD

- Flaky tests that are not quarantined and block the build intermittently.
- Non-deterministic builds that produce different artifacts from the same source.
- Rebuilding different artifacts per environment rather than promoting a single immutable artifact.
- Security and quality gates that can be bypassed without an audited exception.
- Quarantining tests indefinitely without owner assignment or remediation deadlines.
- Pipeline failures that are not surfaced to the change author through a direct channel.

---

## Quick-reference Checklist

### Data Persistence

- [ ] Storage engine selected based on documented access pattern characterization, not assumption.
- [ ] Indexes exist for all common query fields; unused indexes have been removed.
- [ ] Large tables are partitioned; partition key supports both common queries and balanced distribution.
- [ ] Historical data is archived to lower-cost tiers; retention periods are defined.
- [ ] Consistency model for every distributed store is documented and application logic aligns with it.
- [ ] Every schema migration has a tested rollback path and has been tested against representative data volumes.
- [ ] Backwards-incompatible schema changes are coordinated with all readers and writers.

### Data Governance & Security

- [ ] RBAC baseline is in place; ABAC extends it where contextual access factors apply.
- [ ] Least-privilege assignments are reviewed whenever roles change.
- [ ] Data at rest and in transit are encrypted with vetted algorithms.
- [ ] Encryption keys are managed by a dedicated key management service with automated rotation.
- [ ] Data minimization is applied: only necessary data is collected; identifying details removed before storage.
- [ ] Retention periods are defined; expired data is deleted or archived automatically.
- [ ] Data lineage is queryable from source through all transformations.
- [ ] Audit logs are tamper-evident, stored separately, and retained per regulatory requirements.
- [ ] Governance controls are embedded in pipelines, not added post-deployment.
- [ ] ML models have been evaluated for bias and algorithmic fairness before deployment.

### Edge & CDN

- [ ] Each cache layer (client, CDN edge, application) has explicit TTL or event-driven invalidation rules.
- [ ] Personalized content is not cached at shared layers without identity partitioning.
- [ ] Emergency purge mechanism is tested and operational.
- [ ] Origin offload and cache hit ratios are monitored per layer.
- [ ] Latency is measured at the edge, not only at the origin.

### Edge & IoT

- [ ] System operates correctly under intermittent connectivity; offline mode is tested.
- [ ] Protocol selection is validated against device power, memory, and bandwidth budgets.
- [ ] Devices perform local filtering, aggregation, and sensor fusion before transmitting upstream.
- [ ] Hierarchical layers (gateway, regional, central) each function independently when higher layers are unreachable.
- [ ] All devices authenticate before being accepted; firmware updates are signed and verified.
- [ ] Device health (battery, connectivity, firmware version, error rates) is visible to operators.

### Batch & Streaming

- [ ] Batch-vs-streaming selection is documented against explicit latency and cost requirements.
- [ ] Batch jobs are idempotent, run against immutable input snapshots, and are restartable from checkpoints.
- [ ] Streaming processing semantics (at-most-once / at-least-once / exactly-once) are explicitly specified.
- [ ] Backpressure handling is designed and tested; downstream slowness cannot exhaust upstream resources.
- [ ] Event time and processing time are distinguished; lateness windows are defined for streaming.
- [ ] Hybrid architectures have documented reconciliation semantics.

### CI/CD Pipelines

- [ ] Fast checks (lint, static analysis, unit tests) run first and short-circuit on failure.
- [ ] Builds are deterministic: same artifact from same source; no unpinned dependencies, timestamps, or hostnames.
- [ ] Artifacts are immutable, uniquely versioned, and the same artifact is promoted across all environments.
- [ ] Flaky tests are automatically detected, quarantined with an owner and deadline, and not permitted indefinitely.
- [ ] Security gates (dependency scanning, secret detection, vulnerability checks) run automatically in the pipeline.
- [ ] Quality gates are enforced uniformly; exceptions are time-bounded and recorded.
- [ ] Each deployment stage has explicit acceptance criteria; production deployments support one-step rollback.
- [ ] Pipeline health (success rates, durations, failure modes) is monitored and treated as a service-level objective.
