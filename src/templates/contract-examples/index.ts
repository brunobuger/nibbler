export const exampleContracts = [
  {
    name: 'Web app',
    description: 'A minimal starting point for a web app with frontend/backend split.',
    content: `roles:
  - id: architect
    scope: ["vision.md", "architecture.md"]
    authority: { allowedCommands: ["npm test", "npm run lint"], allowedPaths: ["package.json", "tsconfig.json", "frontend/**", "backend/**", "shared/**"] }
    outputExpectations: ["planning artifacts", "delegation plan"]
    verificationMethod: { kind: "none" }
    budget: { maxIterations: 2, exhaustionEscalation: "exception_gate" }
  - id: backend
    scope: ["backend/**", "shared/**", "tests/backend/**"]
    authority: { allowedCommands: ["npm test"], allowedPaths: [] }
    outputExpectations: ["implementation", "tests (feature-level)"]
    verificationMethod: { kind: "none" }
    budget: { maxIterations: 3, exhaustionEscalation: "architect" }
    behavioralGuidance: |
      Own TDD for backend changes: red → green → refactor.
      Start by writing/updating tests, then implement the smallest change to pass them.
      Leave the suite green at the end of your session.
  - id: frontend
    scope: ["frontend/**", "shared/**", "tests/frontend/**"]
    authority: { allowedCommands: ["npm test"], allowedPaths: [] }
    outputExpectations: ["implementation", "tests (feature-level)"]
    verificationMethod: { kind: "none" }
    budget: { maxIterations: 3, exhaustionEscalation: "architect" }
    behavioralGuidance: |
      Own TDD for frontend changes: red → green → refactor.
      Add/adjust tests with each behavior change; keep increments small and keep the suite green.
  - id: sdet
    scope: ["tests/**", "e2e/**", ".github/**"]
    authority: { allowedCommands: ["npm test"], allowedPaths: [] }
    outputExpectations: ["test strategy/infra", "integration/e2e coverage", "flake reduction"]
    verificationMethod: { kind: "none" }
    budget: { maxIterations: 2, exhaustionEscalation: "architect" }
    behavioralGuidance: |
      Complement engineers' feature-level tests by hardening the test harness and system-level coverage.
      Prefer integration/e2e tests where appropriate; reduce flakiness; keep feedback loops fast.
  - id: docs
    scope: ["README.md", "docs/**"]
    authority: { allowedCommands: [], allowedPaths: [] }
    outputExpectations: ["README.md (ship-ready)"]
    verificationMethod: { kind: "none" }
    budget: { maxIterations: 2, exhaustionEscalation: "architect" }
    behavioralGuidance: |
      Produce a ship-ready README.md following top OSS best-practices:
      clear value prop, install, quickstart, commands, artifacts, troubleshooting.

sharedScopes:
  - roles: ["backend", "frontend", "sdet"]
    patterns: ["shared/**", "tests/**"]

escalationChain: []

phases:
  - id: planning
    actors: ["architect"]
    inputBoundaries: ["vision.md", "architecture.md"]
    outputBoundaries: [".nibbler/jobs/**/plan/**"]
    preconditions: [{ type: "always" }]
    completionCriteria:
      - { type: "artifact_exists", pattern: ".nibbler/jobs/**/plan/**" }
    successors: [{ on: "done", next: "execution" }]
  - id: execution
    actors: ["backend", "frontend", "sdet"]
    inputBoundaries: ["backend/**", "frontend/**", "shared/**", "tests/**", "e2e/**"]
    outputBoundaries: ["backend/**", "frontend/**", "shared/**", "tests/**", "e2e/**"]
    preconditions: [{ type: "always" }]
    completionCriteria:
      - { type: "diff_non_empty" }
      - { type: "command_succeeds", command: "npm test" }
    successors: [{ on: "done", next: "ship" }]
  - id: ship
    actors: ["docs"]
    inputBoundaries: ["**/*"]
    outputBoundaries: ["README.md", "docs/**"]
    preconditions: [{ type: "always" }]
    completionCriteria:
      - { type: "artifact_exists", pattern: "README.md" }
      - { type: "markdown_has_headings", path: "README.md", requiredHeadings: ["Install", "Quickstart", "Commands", "Local development"], minChars: 400 }
      - { type: "local_http_smoke", startCommand: "npm run dev -- --host 127.0.0.1 --port 5173 --strictPort", url: "http://127.0.0.1:5173/", timeoutMs: 60000, requestTimeoutMs: 5000 }
    successors: []
    isTerminal: true

gates:
  - id: plan
    trigger: "planning->execution"
    audience: "PO"
    approvalScope: "build_requirements"
    approvalExpectations:
      - "Approve the product requirements and MVP scope for this web app build."
      - "Approve the implementation plan and delegation before execution."
    businessOutcomes:
      - "Stakeholders are aligned on value delivery for the approved MVP."
      - "The PO authorizes implementation under the approved scope and priorities."
    functionalScope:
      - "User-facing workflows in vision.md are mapped to executable work items."
      - "Acceptance artifacts define the expected behavior to be delivered."
    outOfScope:
      - "Any feature not represented in approved planning artifacts is out of scope."
      - "Future roadmap enhancements are explicitly deferred."
    requiredInputs:
      - { name: "vision", kind: "path", value: "vision.md" }
      - { name: "architecture", kind: "path", value: "architecture.md" }
    outcomes: { approve: "execution", reject: "planning" }
  - id: ship
    trigger: "ship->__END__"
    audience: "PO"
    approvalScope: "phase_output"
    approvalExpectations:
      - "Approve ship-phase deliverables for release readiness."
    businessOutcomes:
      - "The release package is approved for handoff."
    functionalScope:
      - "README and docs provide installation, quickstart, and command guidance."
    outOfScope:
      - "No additional implementation scope is approved at SHIP."
    requiredInputs:
      - { name: "readme", kind: "path", value: "README.md" }
    outcomes: { approve: "__END__", reject: "ship" }

globalLifetime:
  maxTimeMs: 1800000
`
  },
  {
    name: 'API service',
    description: 'A minimal starting point for an API/service.',
    content: `roles:
  - id: architect
    scope: ["vision.md", "architecture.md"]
    authority: { allowedCommands: ["npm test"], allowedPaths: ["package.json", "tsconfig.json", "src/**"] }
    outputExpectations: ["planning artifacts", "delegation plan"]
    verificationMethod: { kind: "none" }
    budget: { maxIterations: 2, exhaustionEscalation: "exception_gate" }
  - id: backend
    scope: ["src/**", "tests/**"]
    authority: { allowedCommands: ["npm test"], allowedPaths: [] }
    outputExpectations: ["implementation", "tests (feature-level)"]
    verificationMethod: { kind: "none" }
    budget: { maxIterations: 3, exhaustionEscalation: "architect" }
    behavioralGuidance: |
      Own TDD for backend changes: red → green → refactor.
      Prefer small steps: add/adjust tests, then implement minimal code to pass.
  - id: sdet
    scope: ["tests/**", "e2e/**", ".github/**"]
    authority: { allowedCommands: ["npm test"], allowedPaths: [] }
    outputExpectations: ["test harness/CI", "integration/e2e coverage", "flake reduction"]
    verificationMethod: { kind: "none" }
    budget: { maxIterations: 2, exhaustionEscalation: "architect" }
  - id: docs
    scope: ["README.md", "docs/**"]
    authority: { allowedCommands: [], allowedPaths: [] }
    outputExpectations: ["README.md (ship-ready)"]
    verificationMethod: { kind: "none" }
    budget: { maxIterations: 2, exhaustionEscalation: "architect" }

sharedScopes:
  - roles: ["backend", "sdet"]
    patterns: ["tests/**"]

escalationChain: []

phases:
  - id: planning
    actors: ["architect"]
    inputBoundaries: ["vision.md", "architecture.md"]
    outputBoundaries: [".nibbler/jobs/**/plan/**"]
    preconditions: [{ type: "always" }]
    completionCriteria:
      - { type: "artifact_exists", pattern: ".nibbler/jobs/**/plan/**" }
    successors: [{ on: "done", next: "execution" }]
  - id: execution
    actors: ["backend", "sdet"]
    inputBoundaries: ["src/**", "tests/**"]
    outputBoundaries: ["src/**", "tests/**"]
    preconditions: [{ type: "always" }]
    completionCriteria:
      - { type: "diff_non_empty" }
      - { type: "command_succeeds", command: "npm test" }
    successors: [{ on: "done", next: "ship" }]
  - id: ship
    actors: ["docs"]
    inputBoundaries: ["**/*"]
    outputBoundaries: ["README.md", "docs/**"]
    preconditions: [{ type: "always" }]
    completionCriteria:
      - { type: "artifact_exists", pattern: "README.md" }
      - { type: "markdown_has_headings", path: "README.md", requiredHeadings: ["Install", "Quickstart", "Commands", "Local development"], minChars: 300 }
    successors: []
    isTerminal: true

gates:
  - id: plan
    trigger: "planning->execution"
    audience: "PO"
    approvalScope: "build_requirements"
    approvalExpectations:
      - "Approve the product requirements and MVP scope for this API/service build."
      - "Approve the implementation and validation strategy before execution."
    businessOutcomes:
      - "Business stakeholders confirm priority outcomes for the API release."
      - "The team has PO authorization to implement the approved scope."
    functionalScope:
      - "Core API capabilities and integration flows are defined in executable tasks."
      - "Acceptance artifacts specify expected behavior and test coverage targets."
    outOfScope:
      - "Endpoints and integrations outside approved planning artifacts are excluded."
      - "Post-MVP expansion is not approved by this gate."
    requiredInputs:
      - { name: "vision", kind: "path", value: "vision.md" }
      - { name: "architecture", kind: "path", value: "architecture.md" }
    outcomes: { approve: "execution", reject: "planning" }
  - id: ship
    trigger: "ship->__END__"
    audience: "PO"
    approvalScope: "phase_output"
    approvalExpectations:
      - "Approve ship-phase release artifacts."
    businessOutcomes:
      - "PO confirms release readiness for delivery."
    functionalScope:
      - "Final docs capture deployment/runbook expectations for consumers."
    outOfScope:
      - "No new implementation scope is approved at SHIP."
    requiredInputs:
      - { name: "readme", kind: "path", value: "README.md" }
    outcomes: { approve: "__END__", reject: "ship" }

globalLifetime:
  maxTimeMs: 1800000
`
  },
  {
    name: 'CLI tool',
    description: 'A minimal starting point for a CLI tool.',
    content: `roles:
  - id: architect
    scope: ["vision.md", "architecture.md"]
    authority: { allowedCommands: ["npm test"], allowedPaths: ["package.json", "tsconfig.json", "src/**"] }
    outputExpectations: ["planning artifacts", "delegation plan"]
    verificationMethod: { kind: "none" }
    budget: { maxIterations: 2, exhaustionEscalation: "exception_gate" }
  - id: core
    scope: ["src/**", "tests/**"]
    authority: { allowedCommands: ["npm test"], allowedPaths: [] }
    outputExpectations: ["implementation", "tests (feature-level)"]
    verificationMethod: { kind: "none" }
    budget: { maxIterations: 3, exhaustionEscalation: "architect" }
    behavioralGuidance: |
      Own TDD for code changes: red → green → refactor.
      Add/adjust tests for each behavior change; keep increments small and leave the suite green.
  - id: sdet
    scope: ["tests/**", "e2e/**", ".github/**"]
    authority: { allowedCommands: ["npm test"], allowedPaths: [] }
    outputExpectations: ["test harness/CI", "integration coverage", "flake reduction"]
    verificationMethod: { kind: "none" }
    budget: { maxIterations: 2, exhaustionEscalation: "architect" }
  - id: docs
    scope: ["README.md", "docs/**"]
    authority: { allowedCommands: [], allowedPaths: [] }
    outputExpectations: ["README.md (ship-ready)"]
    verificationMethod: { kind: "none" }
    budget: { maxIterations: 2, exhaustionEscalation: "architect" }

sharedScopes:
  - roles: ["core", "sdet"]
    patterns: ["tests/**"]

escalationChain: []

phases:
  - id: planning
    actors: ["architect"]
    inputBoundaries: ["vision.md", "architecture.md"]
    outputBoundaries: [".nibbler/jobs/**/plan/**"]
    preconditions: [{ type: "always" }]
    completionCriteria:
      - { type: "artifact_exists", pattern: ".nibbler/jobs/**/plan/**" }
    successors: [{ on: "done", next: "execution" }]
  - id: execution
    actors: ["core", "sdet"]
    inputBoundaries: ["src/**", "tests/**"]
    outputBoundaries: ["src/**", "tests/**"]
    preconditions: [{ type: "always" }]
    completionCriteria:
      - { type: "diff_non_empty" }
      - { type: "command_succeeds", command: "npm test" }
    successors: [{ on: "done", next: "ship" }]
  - id: ship
    actors: ["docs"]
    inputBoundaries: ["**/*"]
    outputBoundaries: ["README.md", "docs/**"]
    preconditions: [{ type: "always" }]
    completionCriteria:
      - { type: "artifact_exists", pattern: "README.md" }
      - { type: "markdown_has_headings", path: "README.md", requiredHeadings: ["Install", "Quickstart", "Commands", "Local development"], minChars: 250 }
    successors: []
    isTerminal: true

gates:
  - id: plan
    trigger: "planning->execution"
    audience: "PO"
    approvalScope: "build_requirements"
    approvalExpectations:
      - "Approve the product requirements and MVP command scope for this CLI build."
      - "Approve the execution approach and validation plan before implementation."
    businessOutcomes:
      - "The CLI value proposition and priorities are confirmed by the PO."
      - "The delivery team is authorized to build the approved command surface."
    functionalScope:
      - "Primary commands, flags, and expected outputs are mapped to implementation tasks."
      - "Acceptance artifacts define usability and behavior expectations."
    outOfScope:
      - "Commands not listed in approved planning artifacts are excluded."
      - "Advanced automation and extensions are deferred beyond MVP."
    requiredInputs:
      - { name: "vision", kind: "path", value: "vision.md" }
      - { name: "architecture", kind: "path", value: "architecture.md" }
    outcomes: { approve: "execution", reject: "planning" }
  - id: ship
    trigger: "ship->__END__"
    audience: "PO"
    approvalScope: "phase_output"
    approvalExpectations:
      - "Approve ship-phase artifacts for release."
    businessOutcomes:
      - "PO confirms the CLI package is ready for user adoption."
    functionalScope:
      - "README includes install, usage examples, and command reference expectations."
    outOfScope:
      - "No additional command scope is approved at SHIP."
    requiredInputs:
      - { name: "readme", kind: "path", value: "README.md" }
    outcomes: { approve: "__END__", reject: "ship" }

globalLifetime:
  maxTimeMs: 1800000
`
  }
] as const;

