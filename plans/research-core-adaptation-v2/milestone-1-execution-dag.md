# Milestone 1 Execution DAG

```yaml
objective: extend the existing Research template with the repository page type and directory while preserving all existing projects and templates
root_owner: current Codex root session

nodes:
  - id: root-scope
    kind: root
    depends_on: []
    outcome: pin accepted seams and exact fixed page-type surfaces from Milestone 0
    status: completed

  - id: tests-red
    kind: root
    archetype: verifier
    depends_on: [root-scope]
    outcome: add failing behavior tests for creation, routing, rendering, search/graph visibility, and safe merge
    write_scope: test files only
    status: completed

  - id: profile-builder
    kind: root
    archetype: builder
    depends_on: [tests-red]
    outcome: add only the Research repository type/directory and update required fixed surfaces
    write_scope: accepted template and page-type presentation files
    status: completed

  - id: focused-verification
    kind: root
    archetype: verifier
    depends_on: [profile-builder]
    outcome: pass focused tests and typechecking
    write_scope: read-only except generated test/build artifacts
    status: completed

  - id: independent-review
    kind: root
    archetype: reviewer
    depends_on: [focused-verification]
    outcome: review the complete diff independently against repository standards and the handoff
    write_scope: read-only
    status: completed

  - id: root-integration
    kind: root
    depends_on: [independent-review]
    outcome: resolve findings and run the full verification matrix
    status: completed

  - id: commit
    kind: root
    depends_on: [root-integration]
    outcome: commit the accepted Milestone 0 evidence and Milestone 1 implementation
    status: completed
```

Delegation note: this task runtime exposes no subagent/spawn tool. The root
therefore collapses builder, verifier, and reviewer roles into explicit
sequential passes with non-overlapping phases. Architecture and integration
remain root-owned.
