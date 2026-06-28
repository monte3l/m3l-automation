# Architecture

## Overview

Architecture is the set of high-level decisions that shape every subsequent choice about deployment, scaling, testing, and team organization. This domain covers four complementary levels: selecting and disciplining an application-level structure (monolithic, layered, MVC, or event-driven), decomposing systems into independent microservices, designing those services for cloud-native operation, and applying the cross-cutting resilience and data-consistency patterns that make distributed systems trustworthy. No single style is universally correct; the governing principle is that architecture must be chosen based on current and near-term requirements, and the cost of premature complexity must always be weighed against the cost of changing the architecture later.

## Core Principles

1. Architecture must be chosen based on current and near-term requirements, not speculative future scale.
2. Every service or module must own its data, logic, and lifecycle; direct database sharing between independently deployed units is prohibited.
3. Components must communicate through declared interfaces; undeclared, ad-hoc coupling between layers or services must not exist.
4. Failures at any layer are inevitable and must be designed for explicitly; the system must tolerate infrastructure failures without complete outage.
5. Servers and instances must be treated as ephemeral; application state must never be held in a running process and must live in a backing service.
6. Configuration must be supplied externally (environment variables or equivalent runtime mechanisms) and must never be embedded in code or built artifacts.
7. Observability (logs, metrics, distributed traces) must be in place before a system is exposed to production traffic; it must not be retrofitted after incidents.
8. Asynchronous messaging must be preferred over long synchronous call chains between independent components; synchronous calls must be reserved for operations whose completion is required for the caller to respond.
9. Every consumer of events or retried operations must be idempotent; receiving the same message more than once must produce the same result as receiving it once.
10. Service-to-service contracts and event schemas must be versioned; breaking changes must be coordinated and must not be deployed unilaterally.
11. Mixed architectural styles are acceptable when justified; the seams between styles must be explicit, declared, and disciplined.
12. The number of services and layers must be justified by current need; speculative decomposition is prohibited.

## Application Architectures

### Monolithic Architecture

- A monolith is a single codebase containing all business logic, deployed as one unit in a single process space.
- Monoliths should be used when validating a new idea, when teams are small, or when strong transactional consistency across all operations is required.
- Even within a monolith, internal modules must have clear boundaries so the codebase can be decomposed later if needed.
- Monoliths must follow well-defined internal patterns; acceptable patterns include three-tier separation or MVC.
- Deployment is all-or-nothing and scaling is coarse; when these limitations become blockers the architecture should be reconsidered.

### Model-View-Controller (MVC)

- MVC separates three concerns: the Model handles data and business logic, the View manages presentation, and the Controller orchestrates user input and coordinates Model and View.
- MVC organizes a presentation layer; it must not be confused with a full application architecture for the whole system.
- Controllers must not accumulate responsibilities; bloated controllers must be split before further changes are made.
- MVC variants (Model-View-Presenter, Model-View-ViewModel, and others) must be chosen deliberately and applied consistently throughout the system.

### Layered Architecture

- Code is organized into distinct layers with specific responsibilities: presentation, business logic, and data access, each communicating only with adjacent layers.
- Layers must communicate only through declared interfaces.
- Skipping layers — for example, presentation calling data access directly — is prohibited unless the skip is explicitly documented as an architectural exception.
- Layered architecture should be adopted when a monolith is becoming unwieldy, when team ownership boundaries need clarification, or when distinct deployment targets (web, mobile) must share business logic.
- Simple systems must not be over-layered; pass-through code at every level for trivial operations is a signal of over-engineering.

### Event-Driven Architecture

- Components communicate by publishing events and subscribing to events rather than calling each other directly.
- Event-driven architecture should be used when loose coupling between subsystems is a primary requirement, when multiple teams or systems would otherwise couple their release cycles, or when workflows naturally fan out into many independent reactions.
- Event schemas must be versioned and documented; consumers depend on the shape of events and must not be broken by unannounced schema changes.
- Idempotency must be considered for every consumer because events may be delivered more than once.
- Failure handling must be defined for every event type: what happens when a consumer fails to process an event must be specified before deployment.
- Distributed tracing must be in place so event chains can be reconstructed when debugging.
- Eventual consistency is inherent in event-driven systems; downstream consumers may see stale data briefly, and the system must be designed to tolerate this.

### Selection Rules

- The architecture must be chosen based on current and near-term requirements, not on speculative future scale.
- The cost of changing architecture later must be weighed against the cost of premature complexity now.
- Mixed architectures are acceptable when justified; parts of a system may use different styles, provided the seams between styles are explicit and disciplined.

## Microservices

### When to Apply

- Microservices are appropriate when different parts of the system have vastly different scaling requirements, require different technology stacks, when strong DevOps practices and deployment automation are already in place, or when multiple independent teams must deploy and evolve their components on different cadences.
- Microservices must not be adopted when the application is small or still validating its core ideas, when the team lacks operational maturity to run distributed systems, or when the same outcome can be achieved with a well-structured monolith.
- The number of services must be justified by current need; adding services without justification is prohibited.

### Required Properties of Every Service

- A service must own its data; it must manage its own persistence, and direct database sharing between services is prohibited.
- A service must own its logic; it must encapsulate the business logic for its bounded responsibility.
- A service must own its lifecycle; it must be deployable independently of other services.
- A service must communicate through declared interfaces: synchronous APIs for immediate operations, asynchronous messages or events for background and decoupled operations.
- A service must fail in isolation; its failure must not bring down unrelated services.

### Communication

- Direct synchronous calls between services must be reserved for operations whose completion is required for the caller to respond.
- Asynchronous messaging or event publication must be used for background work, fan-out workflows, and operations that should not block the caller.
- Excessive synchronous chains create a distributed monolith and must be avoided; failures and slowdowns in any service cascade through the entire chain.

### Operational Requirements

- Every service must produce logs, metrics, and traces; observability tooling must aggregate them centrally.
- Requests crossing services must carry correlation identifiers so end-to-end traces can be reconstructed.
- Independent deployments require version compatibility planning at every interface; breaking changes must be coordinated.
- Every cross-service call must be treated as a potentially failing network operation.
- Local development must be supported through stubs, contract tests, or partial environments when running the full system locally is impractical.
- Network calls must be assumed to fail, slow down, or duplicate at any time; code must be defensive accordingly.

### Resilience Patterns

- **Circuit breaker**: detects failing downstream services and stops repeated calls, returning fallback responses quickly instead of waiting for timeouts; after a cooldown, test requests probe whether the service has recovered.
- **Retry with exponential backoff**: handles transient failures by retrying with increasing delays and random jitter to prevent synchronized retry storms.
- **Timeouts**: every cross-service call must have a timeout; hanging requests must not hold resources indefinitely.
- **Bulkheads**: assign separate resource pools (connections, threads, queues) to different operations so one failing operation cannot exhaust all available resources.
- **Graceful degradation**: when a dependency is unavailable, the service must return cached data, default values, or reduced functionality rather than failing completely.
- **Health checks**: each service must expose liveness and readiness signals so orchestration systems can remove unhealthy instances from rotation.

### Data Consistency Patterns

- ACID transactions across service boundaries are not available; the system must use eventual consistency patterns.
- **Saga pattern**: coordinates multi-step business processes through a sequence of local transactions with explicit compensating transactions to undo earlier steps when a later step fails.
- **Event sourcing**: persists state changes as an append-only sequence of events; current state is derived by replaying events and events provide an audit trail.
- **Command Query Responsibility Segregation (CQRS)**: separates write models (optimized for updates) from read models (optimized for queries), allowing each to scale and evolve independently.
- **Idempotent operations**: every operation that may be retried must be safe to execute more than once with the same result.
- **CAP awareness**: distributed systems trade between consistency, availability, and partition tolerance; each trade-off must be made deliberately and documented.

### Performance

- Frequently accessed data must be cached close to consumers; cache invalidation strategy (time-to-live, event-driven invalidation, or write-through) must be chosen explicitly per cache.
- Long-running operations must be moved off the request path through message queues so callers are not blocked.
- Each service may choose the persistence technology that fits its access patterns; this requires explicit handling of cross-service joins and consistency.
- Bottlenecks across services must be identifiable through distributed traces, not guesswork.

## Cloud-Native Architecture

### Foundational Assumptions

- Failures will happen at every layer; the system must tolerate them.
- Servers are ephemeral; instances must be assumed to come and go without affecting the application.
- Scale changes constantly; the system must adapt to varying demand without manual intervention.
- Configuration varies between environments; the application must be environment-agnostic and configured externally.

### The Twelve-Factor Methodology

Cloud-native applications must follow all twelve Twelve-Factor principles:

- **Factor I — Codebase**: one codebase per application, tracked in version control, with many deployments.
- **Factor II — Dependencies**: dependencies must be declared explicitly and isolated; the application must not rely on system-wide packages being present.
- **Factor III — Config**: configuration must be supplied through environment variables or equivalent runtime mechanisms, never embedded in code.
- **Factor IV — Backing Services**: databases, queues, and similar resources must be treated as attached resources reachable via URLs or connection descriptors, swappable without a code change.
- **Factor V — Build, Release, Run**: build once to produce an immutable artifact, combine with configuration at release, then execute; these three stages must remain distinct.
- **Factor VI — Processes**: applications must execute as one or more stateless processes; any persistent state must live in a backing service.
- **Factor VII — Port Binding**: services must expose themselves via ports, independent of any external web server.
- **Factor VIII — Concurrency**: the application must scale out via the process model with independent process types for different workloads.
- **Factor IX — Disposability**: processes must start fast and shut down gracefully on receiving a termination signal.
- **Factor X — Dev/Prod Parity**: development, staging, and production environments must be kept as similar as possible in code, dependencies, and backing services.
- **Factor XI — Logs**: logs must be treated as event streams written to standard output; the application must not manage log files itself.
- **Factor XII — Admin Processes**: one-off administrative tasks must run in the same environment, with the same code and configuration, as the application.

### Scaling

- Horizontal scaling must be preferred over vertical scaling; adding more instances exploits the cloud's strengths while growing a single instance does not.
- Stateless services must scale horizontally behind load balancers; load balancers must distribute traffic using strategies appropriate to the workload.
- Databases must be scaled using read replicas for read-heavy workloads, caching for hot data, and partitioning where data volume requires it.
- Background work must scale through queues and worker pools that grow and shrink with queue depth.
- Auto-scaling policies must be defined against measured metrics (CPU utilization, queue depth, response time, or business-specific signals), not assumptions.

### Resilience

- Circuit breakers must be used to prevent cascading failures: detect failing dependencies and stop sending requests until they recover.
- Retry with exponential backoff and jitter must be used for transient failures; jitter prevents synchronized retry storms across clients.
- Health checks must distinguish liveness (the instance is running) from readiness (the instance can accept traffic); the platform must be allowed to route traffic accordingly.
- Multi-region deployment must be considered for systems whose unavailability would have material business impact; active-passive deployments are simpler while active-active delivers higher availability at the cost of consistency complexity.
- Global traffic management (typically DNS-based) must be used to redirect traffic away from failing regions when a region failure is detected.

### Cost Management

- Instances must be sized based on measured CPU, memory, and application-specific usage; over-provisioning must be detected and corrected.
- Predictable workloads should use reserved capacity or committed-use discounts; unpredictable workloads should use consumption-based pricing; batch jobs may use spot or preemptible instances.
- Every cloud resource must be tagged by project, team, environment, or cost center so spending can be attributed accurately.
- Cloud spending must be monitored continuously, reviewed regularly, and integrated into development decisions.

### Event Delivery and Idempotency

- Delivery guarantees must be defined explicitly per channel: at-most-once, at-least-once, or exactly-once where the platform supports it.
- Consumers must be designed to be idempotent; receiving the same event more than once must produce the same result as receiving it once.
- Out-of-order delivery must be planned for where the platform does not guarantee ordering.

### Operational Discipline

- Configuration changes must flow through the same pipeline as code changes; manual production edits are prohibited.
- Deployments must be automated, repeatable, and reversible.
- Observability (logs, metrics, traces) must be in place before the system is exposed to production traffic.

## Anti-patterns & Red Flags

### Distributed Monolith

- The system has been split into services, but services still rely on long synchronous call chains, meaning failures and slowdowns in any service cascade through the entire chain.
- The team inherits the complexity of a monolith and the operational difficulty of distributed systems with none of the resilience benefits.
- Detected when: services cannot be deployed independently, every release requires coordinating multiple teams, or a single service failure brings down unrelated services.

### Direct Database Sharing Between Services

- Multiple services reading from or writing to the same database schema creates invisible coupling, undermines service independence, and makes it impossible to evolve persistence without coordinating all consumers.

### Premature Microservice Decomposition

- Splitting a system into microservices before operational maturity (observability, deployment automation, contract testing) is in place produces systems that are harder to develop, debug, and operate than a well-structured monolith.

### Synchronous Call Chains

- Long chains of synchronous service-to-service calls amplify latency and propagate failures; every hop adds a failure surface, and a timeout at the bottom of the chain blocks resources all the way to the top.

### Skipping Architecture Layers

- Presentation code calling data access directly, or a service calling an internal subsystem of another service, bypasses declared interfaces, makes the system fragile to change, and hides dependencies that should be explicit.

### Stateful Processes

- Storing session data, user state, or any mutable application data in a running process instance violates Factor VI and prevents horizontal scaling; instances become unequal and load balancers can no longer route freely.

### Configuration in Code or Artifacts

- Hardcoding environment-specific values (hostnames, credentials, feature flags) in source code or build artifacts creates separate artifacts per environment, breaks Factor V, and introduces a class of production incidents caused by build-time vs. runtime mismatch.

### Monolith Internal Anarchy

- Even in a monolith, allowing modules to reach directly into other modules' internals — bypassing their public interfaces — makes future decomposition extremely costly and produces a codebase where every change has unpredictable blast radius.

### Missing Idempotency for Retried Operations

- Operations that can be retried (event consumers, API calls with retry logic) must not produce duplicate side effects on re-execution; missing idempotency produces double charges, duplicate records, or inconsistent state.

### Speculative Complexity

- Adding services, layers, or patterns that are not required today in anticipation of hypothetical future needs violates YAGNI and imposes real operational cost without current benefit.

## Quick-reference Checklist

- [ ] Architecture choice is driven by current requirements, not speculative scale.
- [ ] Every service or module owns its data and has its own persistence layer; no direct database sharing.
- [ ] Every service or module communicates through declared, versioned interfaces.
- [ ] Event schemas are versioned and documented before any consumer depends on them.
- [ ] Every event consumer and retried operation is idempotent.
- [ ] All cross-service calls have explicit timeouts.
- [ ] Circuit breakers are in place for all critical downstream dependencies.
- [ ] Retry logic uses exponential backoff with jitter.
- [ ] Services expose distinct liveness and readiness health-check endpoints.
- [ ] Correlation identifiers are propagated through all service calls and events for distributed tracing.
- [ ] Observability (structured logs, metrics, traces) is deployed before the system reaches production.
- [ ] Configuration is supplied through environment variables or equivalent; no environment-specific values are embedded in code or artifacts.
- [ ] Application processes are stateless; all persistent state lives in a backing service.
- [ ] Build, release, and run stages are distinct; one immutable artifact is built and promoted through environments.
- [ ] Development, staging, and production environments are kept as similar as possible (Factor X).
- [ ] Auto-scaling policies are defined against measured metrics, not assumptions.
- [ ] Horizontal scaling is preferred; services are stateless behind load balancers.
- [ ] Multi-region or multi-zone deployment is in place for any system whose unavailability has material business impact.
- [ ] Every cloud resource is tagged by project, team, environment, and cost center.
- [ ] CAP trade-offs for each service are documented explicitly.
- [ ] Saga compensating transactions are defined for every multi-step cross-service business process.
- [ ] Monolith internal modules have clear boundaries even though they share a process.
- [ ] Layer skipping (e.g., presentation directly accessing data) is explicitly documented as an exception where it exists.
- [ ] Deployment pipeline is automated, repeatable, and supports rollback without manual intervention.
- [ ] The number of services is justified by current organizational and scaling need; no speculative decomposition.
