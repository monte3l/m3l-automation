# Design Principles & Patterns

## Overview

This domain establishes the structural and behavioral rules that govern how code units are defined, composed, and made to interact. It covers the five SOLID principles — which apply universally to any unit that encapsulates state or behavior — and nine foundational design patterns across creational, structural, and behavioral categories. Together these rules ensure that code remains open to extension without requiring modification to stable internals, that units carry clearly bounded responsibilities, that object construction is controlled and flexible, and that collaborators interact through defined contracts rather than concrete dependencies. Violations of these rules consistently produce code that is fragile, rigid, and resistant to change; compliance must be evaluated actively during design and code review, not inferred retroactively.

---

## Core Principles

1. Every unit of code must have exactly one reason to change; units accumulating multiple responsibilities must be decomposed before further changes are made.
2. Code must be open for extension but closed for modification; new behavior must be added through abstractions, composition, or configuration — not by rewriting stable, tested internals.
3. Subtypes must be substitutable for their base types without altering program correctness; every subtype must honor the parent's invariants, preconditions, and postconditions.
4. Interfaces must be small and focused; a unit must not be forced to depend on operations it does not use.
5. High-level units must depend on abstractions, not on concrete low-level units; dependencies must be supplied through injection, parameters, or composition — never constructed internally.
6. Design patterns must be introduced only to solve a real, present problem; speculative introduction of any pattern is prohibited.
7. Every pattern in use must be documented at the seam where it is introduced so that future maintainers understand its role and the contracts between participants.
8. Patterns must promote loose coupling; if a chosen pattern increases coupling between collaborators it must be reconsidered.
9. Patterns must improve maintainability and testability; a pattern application that does neither must be reconsidered.
10. Stacking multiple structural or behavioral patterns without clear purpose obscures behavior and complicates debugging; layered patterns must remain intelligible.
11. SOLID compliance must be evaluated during design and code review; where a principle is violated the violation must be justified explicitly or remediated — silent violation accumulates structural debt.
12. Composition must be preferred over inheritance when combining behaviors; inheritance hierarchies that would produce a subclass explosion must be replaced with composable alternatives.

---

## SOLID Principles

### S — Single Responsibility Principle

- Every unit of code must have exactly one reason to change.
- A unit that handles multiple concerns must be split; modifying one concern must not risk breaking another.
- Cohesion must be high within a unit; unrelated responsibilities must be moved to separate units.
- When a unit accumulates responsibilities it must be decomposed before further changes are made to it.

### O — Open/Closed Principle

- Units of code must be open for extension but closed for modification.
- New behavior must be added by extending existing structures, not by rewriting their internals.
- Extension points must be designed through abstractions, configuration, or composition so that variations in behavior do not require changes to stable code.
- Stable, tested code must not be edited to support a new variation when an extension mechanism can satisfy the requirement.

### L — Liskov Substitution Principle

- Subtypes must be substitutable for their base types without changing the correctness of the program.
- A subtype must honor every contract established by its parent: invariants, preconditions, postconditions, and behavioral expectations.
- A subtype must not strengthen preconditions or weaken postconditions of operations it inherits.
- A subtype that cannot honor the parent's contract must not be defined as a subtype at all; an alternative composition or abstraction must be used.

### I — Interface Segregation Principle

- Interfaces must be small and focused.
- A unit must not be forced to depend on operations it does not use.
- Large general-purpose interfaces must be split into smaller role-specific interfaces.
- Clients must depend only on the interface they require, not on a broader surface that includes unrelated operations.

### D — Dependency Inversion Principle

- High-level units must depend on abstractions, not on concrete low-level units.
- Concrete implementations must also depend on abstractions so that both sides are coupled to a shared contract rather than to each other.
- Dependencies must be supplied to a unit through its declared interface — via injection, parameters, or composition — not constructed inside the unit's internals.
- Direct references from high-level policy to low-level mechanism are prohibited; an abstraction must sit between them.

### Application

- These principles apply to functions, modules, classes, services, and any other unit that encapsulates behavior; they are not exclusive to class-based code.
- Compliance must be evaluated during design and code review, not retroactively.
- Where a principle is violated the violation must be justified explicitly or remediated; silent violation accumulates structural debt.

---

## Creational Patterns

### Singleton

- The single instance must be created the same way every time it is requested.
- Instantiation must be thread-safe in environments where multiple threads may request the instance concurrently.
- A Singleton introduces global state; that global state must be tracked and documented because it complicates debugging, dependency tracing, and system reasoning.
- A Singleton must be avoided when its persistence across test runs would interfere with test isolation.
- Before introducing a Singleton the team must confirm that no dependency injection or scoped resource model would serve the same purpose with fewer drawbacks.

### Factory Method

- The Factory Method must be applied when the exact types or number of objects to be created are not known until runtime, when object creation logic must be controlled or validated centrally, or when a framework must hide creation complexity from its consumers.
- The factory must encapsulate construction logic completely; clients must receive the constructed object without knowledge of its concrete type or instantiation details.
- The factory must return a value conforming to a known abstract type so that clients can depend on the abstraction rather than the concrete result.
- Client code should remain simple and unaware of instantiation details.

### Builder

- The Builder pattern must be applied when an object has many optional or configurable parts whose combinations would otherwise produce unwieldy constructors, when construction order matters, or when intermediate validation between steps is required.
- The builder must allow assembly steps to be invoked in any meaningful order, except where ordering is part of the contract.
- Optional parts must be optional: their absence must produce a valid object.
- The final construction step must validate that the resulting object is consistent before returning it.
- Client code should be able to assemble objects readably and incrementally.

### Cross-Cutting Rules (Creational)

- Creational patterns must promote loose coupling between clients and concrete implementations.
- Creational patterns must improve maintainability and testability; if a particular use does not, it must be reconsidered.
- Creational patterns must not be introduced speculatively; each application must be justified by a real construction problem the project faces today.

---

## Structural Patterns

### Adapter

- The Adapter must be applied when existing code must collaborate with a system whose interface it was not designed for, and when modifying either side of the integration is impossible, expensive, or risky.
- The adapter must translate calls completely; consumers must not need to know that an adapter is involved.
- The adapter must not modify the underlying component being adapted; it wraps the component rather than altering it.
- The adapter must be the sole location where translation logic lives; consumers and adapted components must remain free of translation logic.

### Composite

- The Composite must be applied when the domain naturally contains hierarchical structures whose nodes share an interface (visual element trees, file structures, structured documents, hierarchical configurations), and when new component types must be added without forcing changes in client code.
- Both leaf elements and composite elements must implement the same abstract interface.
- Client code must be able to operate on a tree without distinguishing between leaves and composites.
- Type checks and conditional logic to differentiate leaves from composites are prohibited; the uniform interface must handle the distinction internally.

### Decorator

- The Decorator must be applied when behaviors must be combined dynamically and inheritance would produce an explosion of subclasses, or when responsibilities such as logging, validation, authorization, caching, or formatting must be layered around an existing object without altering it.
- A decorator must implement the same interface as the object it wraps so that consumers cannot distinguish a decorated object from an undecorated one.
- Decorators must be stackable; multiple decorators must compose without interfering with one another.
- A decorator must forward unhandled responsibilities to the wrapped object; it must not silently replace the wrapped behavior unless that replacement is its explicit purpose.

### Cross-Cutting Rules (Structural)

- Structural patterns must be introduced to solve a structural problem the system actually has, not as preemptive design.
- Layered structural patterns must remain intelligible; stacking adapters, composites, and decorators without clear purpose obscures behavior and complicates debugging.
- Every structural pattern in use must be documented at the seam where it is introduced so that future maintainers understand its role.

---

## Behavioral Patterns

### Observer

- The Observer must be applied in event-driven architectures that require loose coupling, in subscription and publish-subscribe scenarios, and wherever inter-service or inter-component communication must remain decoupled and reactive.
- One unit must act as the subject; the subject must track its registered observers and broadcast notifications when relevant state changes occur.
- The subject must allow observers to register and unregister without modification to its own logic.
- The subject must not depend on the concrete types of its observers; observers must depend only on the subscription contract.
- Notifications must carry enough information for observers to act, but must not impose ordering or response expectations that re-couple the parties.

### Strategy

- The Strategy must be applied when multiple algorithms solve the same problem in different ways and the choice depends on input, configuration, or runtime conditions, and when algorithms must be selected, swapped, or extended without disturbing surrounding logic.
- A common interface must define the operation that all strategies provide.
- The context using a strategy must hold the strategy through its abstract type and invoke it through the shared interface.
- Strategies must be substitutable: switching strategies must not require changes to the context.
- New strategies must be introducible without modifying the context.

### Command

- The Command must be applied for task and job queues requiring uniform handling of disparate actions, for undo and redo systems requiring reversible operations, for transaction logs and audit trails requiring recordable actions, for asynchronous or delayed execution, and for workflow orchestration requiring composable and replayable steps.
- Each command must represent a single, self-contained action.
- A command must encapsulate the receiver, the operation, and any required parameters so that execution requires no additional context.
- The dispatcher of a command must not need to know how the command performs its work.
- When undo or compensation is part of the contract, every command must provide its reverse operation explicitly.

### Cross-Cutting Rules (Behavioral)

- Behavioral patterns must reduce coupling between collaborators; if a chosen pattern increases coupling it must be reconsidered.
- Behavioral patterns must not be introduced speculatively; each use must address a real interaction problem the system has today.
- Where behavioral patterns are introduced the contracts between participants must be documented so that future maintainers understand the interaction.

---

## Anti-patterns & Red Flags

### From SOLID Principles

- A unit that has more than one reason to change is a violation of Single Responsibility; it must be decomposed before further changes are made.
- Editing stable, tested code to support a new variation when an extension mechanism would serve is a violation of Open/Closed; it introduces regression risk into proven behavior.
- A subtype that strengthens preconditions or weakens postconditions relative to its parent corrupts the contract model; it must not be treated as a subtype.
- A subtype that cannot honor the parent's invariants must not be defined as a subtype; using inheritance to reuse implementation while violating behavioral contracts is prohibited.
- Forcing a unit to implement interface methods it does not use indicates an oversized interface; the interface must be split.
- Constructing dependencies inside a unit's internals rather than receiving them through injection creates hidden coupling to concrete implementations and makes substitution and testing harder.
- A direct reference from high-level policy code to a low-level mechanism without an intervening abstraction is prohibited.

### From Creational Patterns

- Introducing a Singleton without confirming that dependency injection or a scoped resource model cannot serve the same purpose is prohibited; the global state debt a Singleton creates must be weighed explicitly.
- Using a Singleton in a context where its shared state would persist across test runs and corrupt test isolation is prohibited.
- Introducing any creational pattern speculatively — before a real construction problem exists — is prohibited.
- A Factory that exposes concrete types to its clients defeats the purpose of the pattern; the return type must be the abstract type.
- A Builder that allows optional parts to be absent without producing a valid object is defective; the final step must validate object consistency.

### From Structural Patterns

- Modifying the component being adapted rather than wrapping it conflates adaptation with alteration and breaks the Adapter contract.
- Allowing translation logic to leak into consumers or adapted components defeats the Adapter's purpose and spreads coupling.
- Using type checks or conditional logic to distinguish leaves from composites in client code is a Composite violation; the uniform interface must absorb the distinction.
- A decorator that fails to forward unhandled responsibilities to the wrapped object silently drops behavior; this is prohibited unless replacement is the decorator's explicit declared purpose.
- Stacking structural patterns (adapters, composites, decorators) without documenting each seam produces a system that is opaque to maintainers.
- Introducing structural patterns as default scaffolding rather than to solve a specific existing structural problem is over-engineering.

### From Behavioral Patterns

- A subject that depends on the concrete types of its observers defeats the Observer pattern and re-couples parties that were meant to be decoupled.
- Notifications that impose ordering or response expectations on observers re-couple the parties and must be redesigned.
- A strategy that can only be switched by modifying the context violates the Open/Closed Principle and defeats the purpose of the Strategy pattern.
- A Command that requires the dispatcher to know how it performs its work violates the encapsulation contract.
- A Command system that promises undo or compensation but does not provide an explicit reverse operation for every command is defective.
- Introducing behavioral patterns speculatively — before a real interaction problem exists — is prohibited.
- Failing to document the contracts between participants in a behavioral pattern leaves future maintainers unable to reason about the interaction.

---

## Quick-reference Checklist

Use this checklist during design and code review to verify compliance across all four source domains.

- [ ] Each unit has exactly one reason to change; unrelated responsibilities have been moved to separate units.
- [ ] New behavior is introduced by extension (abstractions, configuration, composition), not by editing stable internals.
- [ ] Every subtype honors its parent's invariants, preconditions, and postconditions without strengthening or weakening them.
- [ ] Interfaces are small and role-specific; no unit is forced to depend on operations it does not use.
- [ ] All dependencies are injected or passed in; no unit constructs its own concrete dependencies internally.
- [ ] SOLID compliance has been evaluated during design or code review; any violation is explicitly justified or scheduled for remediation.
- [ ] No design pattern has been introduced speculatively; each one addresses a real, present problem.
- [ ] Every pattern in use is documented at the seam where it is introduced with an explanation of its role and participant contracts.
- [ ] The Singleton's global state debt is documented; dependency injection or a scoped model was ruled out before adoption.
- [ ] Thread safety of Singleton instantiation has been confirmed for concurrent environments.
- [ ] The Factory returns an abstract type; clients have no knowledge of the concrete type constructed.
- [ ] The Builder validates object consistency in its final step; optional parts are truly optional and produce a valid object when absent.
- [ ] The Adapter wraps without altering the adapted component; translation logic lives exclusively in the adapter.
- [ ] Composite client code operates uniformly on leaves and composites with no type-check conditionals.
- [ ] Each Decorator forwards unhandled responsibilities to the wrapped object and implements the same interface as its wrappee.
- [ ] Stacked structural patterns (adapters, composites, decorators) remain intelligible and each layer is individually documented.
- [ ] The Observer subject depends on the observer abstraction, not on concrete observer types.
- [ ] Observer notifications carry enough information for observers to act without imposing ordering or response expectations.
- [ ] The Strategy context holds the strategy through its abstract interface; switching strategies requires no changes to the context.
- [ ] Each Command encapsulates its receiver, operation, and parameters; the dispatcher requires no knowledge of execution mechanics.
- [ ] Commands that support undo or compensation explicitly provide their reverse operation.
- [ ] Behavioral patterns reduce coupling between collaborators; any pattern that increases coupling is flagged for reconsideration.
- [ ] Composition is preferred over inheritance wherever a combination of behaviors would otherwise require a subclass hierarchy.
