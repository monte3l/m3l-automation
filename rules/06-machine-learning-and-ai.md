# Machine Learning & AI

## Overview

Machine learning systems differ from conventional software in a fundamental way: their logic is learned from data rather than written explicitly. This difference reshapes every stage of design, deployment, monitoring, and maintenance. These rules apply to any system in which a learned model influences behavior — from classical supervised learning pipelines and batch inference jobs to real-time serving clusters, retrieval-augmented generation (RAG) systems, and fully agentic AI flows that act through tools across multi-step processes. The governing principle is that ML systems must be built around three operationally distinct but feedback-connected stages — data preparation, model training, and prediction serving — and that each stage must be observable, reproducible, and governed.

## Core Principles

1. ML systems must be designed around three distinct stages: data preparation, model training, and prediction serving. These stages must be operationally separate but connected by explicit feedback loops that carry data quality signals, drift alerts, and outcome measurements back upstream.
2. Preprocessing logic used during training must be identical to preprocessing logic used during serving. Any divergence is a primary source of silent model degradation.
3. Every experiment must be tracked: hyperparameters, dataset versions, code versions, and evaluation results must all be recorded so any model can be reproduced.
4. Models must be validated against held-out data before being considered for deployment. Validation must include model behavior checks, not only aggregate accuracy metrics.
5. Model versions must be tracked at the serving layer; the version that produced any given prediction must be recoverable.
6. Observability for ML systems must cover model behavior — input feature distributions, prediction distributions, confidence scores, and real-world outcomes — not only infrastructure health metrics.
7. Statistical drift detection must run continuously; alerts must fire before accuracy visibly degrades rather than after.
8. High-stakes automated decisions must involve a human-in-the-loop pattern where the AI produces options and rationale and a human makes the final decision.
9. The set of tools available to any agentic AI system must be explicitly defined; unbounded tool access is prohibited.
10. Rolling deployments and shadow modes must be supported so new models can be evaluated against production traffic before being trusted.
11. The feedback loop between deployment and improvement must be closed: deployed models must continuously inform the next training cycle through drift signals, outcome measurements, and retraining triggers.
12. Interfaces between generative AI components and traditional ML components must be designed explicitly; ad-hoc integration produces fragile systems.

## Data Preparation & Validation

- Data pipelines must validate data on ingestion: schema conformance, value ranges, missing-value rates, and other quality metrics must be checked before any data enters training.
- Both batch and real-time ingestion paths must be supported when serving requires both training-time and request-time features.
- Preprocessing logic must be versioned and shared between training and serving code paths. A mismatch between training-time and serving-time preprocessing must be treated as a critical defect.
- Data quality metrics must be continuously compared against established baselines; anomalies must trigger alerts before contaminated data reaches training.
- Problematic or ambiguous data must be routed for human review rather than silently discarded or corrected by heuristics.
- Dataset versions must be recorded alongside model versions so any trained model can be traced back to the exact data used to produce it.
- Schema migrations to training datasets must follow the same discipline as schema migrations to production databases: rollback plans, backward-compatibility checks, and coordination with all consumers.

## Training & Experimentation

- Every training run must record: hyperparameters, dataset identifiers and versions, code commit reference, compute environment, and evaluation results. This metadata must be sufficient to reproduce the run.
- Distributed training must be planned for when model size or data volume exceeds single-machine capacity; this decision must be made before it becomes blocking.
- Training runs must have explicit compute budgets and termination criteria; unbounded training jobs must not be accepted.
- Models must be validated against held-out data — reserved before training begins — before being considered for deployment. Data leakage between training and evaluation sets is prohibited.
- Retraining pipelines must include validation steps before any new model replaces a production model; automated promotion without validation gates is prohibited.
- Controlled experimentation mechanisms — A/B tests, canary deployments — must be managed through the orchestration layer, not through ad-hoc manual switches.
- Drift detection should trigger automated retraining pipelines where data and operational maturity allow; automated retraining must still pass all validation gates before promotion.

## Model Serving & Deployment

- Serving architecture must match the latency requirements of the consumer: batch inference must be used when predictions can be precomputed; real-time inference must be used when predictions must be available within a user-facing request budget.
- Real-time models must run behind load balancers and should use cached or precomputed features where possible to remain within latency budgets.
- Model versions must be tracked at the serving layer; the version that produced any given prediction must be recoverable for debugging, auditing, and compliance purposes.
- Models must be deployable independently of consumers; consumers must not require redeployment to switch model versions.
- Rolling deployments and shadow modes must be supported: shadow mode runs a new model on production traffic without serving its predictions to users, enabling comparison against the current production model before the new model earns trust.
- Human approval gates must be required before deploying models to production in any context where governance, safety, or regulatory requirements demand it.
- Audit trails of every deployed model — including who approved deployment, what validation evidence was reviewed, and what version was promoted — must be maintained.
- When a single prediction request involves multiple models or services, distributed tracing must be in place so the full request path can be reconstructed and component failures can be localized.

## Observability & Monitoring

- Input feature distributions must be monitored continuously and compared against training distributions; significant divergence must trigger alerts.
- Prediction distributions must be tracked over time; unexpected shifts in output distributions are early indicators of model degradation.
- Where ground truth becomes available after predictions are made, predicted vs. observed outcomes must be compared to measure real-world model accuracy.
- Confidence scores must be tracked and used to flag anomalies: a model producing consistently low-confidence predictions at scale signals a distribution shift or model failure.
- Standard infrastructure observability — latency, throughput, error rates, resource consumption — must also be in place alongside model-specific monitoring.
- Statistical comparisons between recent inputs and training data must run continuously; drift must be detected before accuracy visibly degrades.
- Alerts must fire on significant drift and must be actionable: drift sources — environmental changes, upstream data quality regressions, behavior shifts in the user population — must be diagnosable from the alert context.
- When a prediction request spans multiple models or services, distributed tracing must allow the path and outcome of any individual request to be reconstructed.

## Generative AI & Agentic Systems

### Retrieval-Augmented Generation (RAG)

- The retrieval component must surface information that is current and relevant to the query; stale or irrelevant retrieved context must not be passed to the generative model.
- Retrieved context must be passed to the generative model alongside the user's input, structured so the model can ground its response in the retrieved material rather than rely solely on parametric knowledge.
- The system must be able to attribute responses to retrieved sources where attribution is required by the use case; attribution must be verifiable, not asserted.
- Retrieval quality must be measured separately from generation quality: failures in the retrieval stage and failures in the generation stage must be independently diagnosable. A single end-to-end accuracy metric is insufficient.
- Retrieval indexes must be kept current; staleness windows must be defined, monitored, and alertable.

### Agentic Flows

- The set of tools available to an agentic system must be defined explicitly before deployment; tools must not be added at runtime without review. Unbounded tool access is prohibited.
- Failure handling must be designed for every tool invocation: each tool call must have defined behavior on failure, including retry policy, fallback behavior, and escalation path.
- Orchestration logic must coordinate steps deterministically; long-running agentic flows must be observable — with logged intermediate states — and interruptible at any step.
- Side effects of tool use — writes, transactions, external notifications, financial operations — must be authorized appropriately, typically through explicit human oversight or pre-approved bounded permissions. Irreversible side effects require especially careful authorization.
- Agentic flows that operate autonomously over extended periods must have defined stopping conditions and must not run indefinitely without a check-in mechanism.
- The scope of any autonomous agent must be bounded by its use case: agents must not acquire capabilities, data access, or tool permissions beyond what the task requires.

### Determinism and Reproducibility

- Model versions used in production must be fixed; updates must be controlled releases, not silent rollouts.
- Any source of nondeterminism — temperature settings, sampling strategies, dropout — must be configurable and recorded with each prediction so that outputs can be reproduced for debugging, auditing, or dispute resolution.
- Inputs to generative models must be validated; small or adversarial input perturbations must not produce disproportionately different outputs in safety-critical applications.

### Human-in-the-Loop

- High-stakes decisions must involve a human-in-the-loop pattern where the AI produces options and rationale and a human makes the final decision.
- Domains requiring human oversight include healthcare, finance, hiring, legal determinations, safety-critical control, and any other context where an automated error has material consequences for individuals.
- Human review queues must be monitored; if review capacity is insufficient to keep pace with the volume of decisions requiring oversight, the system must throttle or defer rather than bypass review.

## Governance & Ethics

- Models must be tested for bias across demographic groups and use-case-relevant subpopulations before deployment; bias testing must be documented and repeated after retraining.
- Algorithmic fairness requirements must be defined explicitly for each use case; there is no single universal fairness metric, and the chosen definition must be justified.
- Model predictions in high-stakes domains must be explainable: the system must be able to provide human-understandable rationale for individual decisions where required by regulation or policy.
- Audit trails for AI-influenced decisions must be maintained: the model version, input features, prediction output, confidence score, and any human review outcome must be recorded and retained per applicable policy.
- Data minimization applies to ML systems: models must not be trained on or given access to more personal or sensitive data than the task requires.
- Models trained on personal data must be subject to the same data retention and deletion obligations as the underlying data; model unlearning requirements must be planned for where applicable.
- AI governance reviews must be conducted before deploying models in new domains or with materially expanded scope; scope creep in model usage must be treated as a governance event requiring review.
- Generative AI outputs in customer-facing systems must be labeled as AI-generated where required by policy, regulation, or where there is a meaningful risk of user confusion.

## Anti-patterns & Red Flags

- **Training-serving skew**: Preprocessing logic diverges between training and serving, producing silent model degradation that is hard to diagnose.
- **Unversioned datasets**: Models cannot be reproduced because the training data was not versioned alongside the model artifact.
- **Untracked experiments**: Promising experiments cannot be recovered or compared because hyperparameters and results were not recorded.
- **Deploying without validation**: Models promoted to production without held-out evaluation, shadow mode testing, or human approval gates.
- **Silent model replacement**: Model versions updated in production without versioned tracking, making it impossible to attribute prediction changes to a model change.
- **Missing drift detection**: Monitoring covers only infrastructure metrics; no alerts exist for distribution shift until users report degraded results.
- **Unbounded tool access**: Agentic systems given access to all available tools rather than a minimal bounded set, increasing blast radius of failures and misuse.
- **Unapproved side effects**: Agentic flows writing to databases, sending notifications, or executing transactions without explicit authorization per action type.
- **Non-interruptible agents**: Long-running agentic flows with no observable intermediate state and no mechanism to pause or cancel.
- **Single end-to-end RAG metric**: Measuring only final answer quality without separately measuring retrieval precision, making failures undiagnosable.
- **Bias testing deferred**: Fairness and bias evaluation treated as post-deployment concerns rather than pre-deployment gates.
- **Explanation theater**: Model explainability implemented as a checkbox — producing outputs that appear explanatory but do not accurately reflect the model's actual decision process.
- **Automated promotion without gates**: Retraining pipelines that promote new models to production automatically without any validation step.
- **Unbounded compute**: Training jobs with no budget or termination criteria, creating runaway cost exposure.

## Quick-reference Checklist

- [ ] Data validated on ingestion: schema, ranges, missing-value rates checked before training.
- [ ] Training and serving preprocessing logic are identical and co-versioned.
- [ ] Every training experiment records hyperparameters, dataset version, code version, and evaluation results.
- [ ] Training dataset and evaluation dataset are strictly separated; no data leakage.
- [ ] Models validated against held-out data before deployment consideration.
- [ ] Model versions tracked at the serving layer; prediction-to-version traceability confirmed.
- [ ] Shadow mode and rolling deployment capability in place for new model evaluation.
- [ ] Human approval gate required before production promotion where governance demands it.
- [ ] Audit trail maintained for every deployed model version.
- [ ] Input feature distribution monitoring active and compared against training baseline.
- [ ] Prediction distribution monitoring active and tracked over time.
- [ ] Confidence score tracking active; low-confidence anomalies alertable.
- [ ] Real-world outcome measurement in place where ground truth is available post-prediction.
- [ ] Drift detection runs continuously; alerts fire before accuracy visibly degrades.
- [ ] Distributed tracing in place for multi-model prediction requests.
- [ ] RAG retrieval quality measured independently of generation quality.
- [ ] RAG retrieval index staleness window defined and monitored.
- [ ] Agentic system tool access explicitly bounded; no runtime tool acquisition.
- [ ] Every agentic tool invocation has defined failure handling.
- [ ] Agentic flows are observable (logged intermediate states) and interruptible.
- [ ] Irreversible side effects from agentic tool use require explicit authorization.
- [ ] High-stakes decisions confirmed to use human-in-the-loop pattern.
- [ ] Bias and fairness testing completed before deployment; documented and repeatable.
- [ ] Explainability mechanism in place for high-stakes model decisions.
- [ ] Retraining pipelines include validation gates before automated model promotion.
