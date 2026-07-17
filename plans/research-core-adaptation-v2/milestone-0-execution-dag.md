# Milestone 0 Execution DAG

```yaml
objective: reconcile Research Core Adaptation V2 with the checked-out Nashsu core without changing production behavior
root_owner: current Codex root session
requested_model: GPT-5.6 Sol High
model_verification: unavailable in this task surface

nodes:
  - id: package-intake
    kind: root
    depends_on: []
    outcome: verify the complete handoff and extract its constraints and code anchors
    status: completed

  - id: repository-baseline
    kind: root
    depends_on: [package-intake]
    outcome: acquire the canonical repository, pin the exact version, and create a feature branch
    status: completed

  - id: scout-frontend-ingest
    kind: root
    archetype: scout-equivalent
    depends_on: [repository-baseline]
    outcome: map templates, schema routing, source import, queues, review persistence, page merge, and tests
    write_scope: read-only
    status: completed

  - id: scout-backend-api
    kind: root
    archetype: scout-equivalent
    depends_on: [repository-baseline]
    outcome: map Rust persistence, local API routing, graph/search behavior, and project resolution
    write_scope: read-only
    status: completed

  - id: scout-mcp-models
    kind: root
    archetype: scout-equivalent
    depends_on: [repository-baseline]
    outcome: map MCP registration and binding, model routing, and integration-test surfaces
    write_scope: read-only
    status: completed

  - id: baseline-validation
    kind: root
    depends_on: [scout-frontend-ingest, scout-backend-api, scout-mcp-models]
    outcome: run existing builds and tests and attempt the canonical desktop launch
    status: completed-with-findings

  - id: root-reconciliation
    kind: root
    depends_on: [baseline-validation]
    outcome: reconcile reports, identify contradicted assumptions, and choose a proposed PR sequence
    status: completed

  - id: milestone-0-report
    kind: root
    depends_on: [root-reconciliation]
    outcome: publish the root-owned intake report; make no production change
    status: completed
```

Delegation note: the installed Codex CLI reports stable `multi_agent`, but this
task runtime exposes no spawn/subagent tool. Following the handoff fallback, the
three non-overlapping read-only scouting passes were performed sequentially by
the root. No alternate orchestration runtime was installed.

