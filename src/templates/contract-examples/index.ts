export const exampleContracts = [
  {
    name: 'Web app',
    description: 'A minimal starting point for a web app.',
    content: `roles:
  - id: architect
    scope: ["src/**", "tests/**", "docs/**", "README.md"]
    authority: { allowedCommands: ["npm test", "npm run lint"], allowedPaths: [] }
    outputExpectations: ["plan artifacts", "architecture decisions"]
    verificationMethod: { kind: "none" }
    budget: { maxIterations: 2, exhaustionEscalation: "exception_gate" }
  - id: worker
    scope: ["src/**", "tests/**"]
    authority: { allowedCommands: ["npm test"], allowedPaths: [] }
    outputExpectations: ["implementation"]
    verificationMethod: { kind: "none" }
    budget: { maxIterations: 3, exhaustionEscalation: "architect" }

sharedScopes:
  - roles: ["architect", "worker"]
    patterns: ["src/**", "tests/**"]

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
    actors: ["worker"]
    inputBoundaries: ["src/**", "tests/**"]
    outputBoundaries: ["src/**", "tests/**"]
    preconditions: [{ type: "always" }]
    completionCriteria: [{ type: "diff_non_empty" }]
    successors: []
    isTerminal: true

gates:
  - id: plan
    trigger: "planning->execution"
    audience: "PO"
    requiredInputs:
      - { name: "vision", kind: "path", value: "vision.md" }
      - { name: "architecture", kind: "path", value: "architecture.md" }
    outcomes: { approve: "execution", reject: "planning" }

globalLifetime:
  maxTimeMs: 1800000

escalationChain: []
`
  },
  {
    name: 'API service',
    description: 'A minimal starting point for an API/service.',
    content: `roles:
  - id: architect
    scope: ["src/**", "tests/**", "README.md"]
    authority: { allowedCommands: ["npm test"], allowedPaths: [] }
    outputExpectations: ["plan artifacts", "tech decisions"]
    verificationMethod: { kind: "none" }
    budget: { maxIterations: 2, exhaustionEscalation: "exception_gate" }
  - id: worker
    scope: ["src/**", "tests/**"]
    authority: { allowedCommands: ["npm test"], allowedPaths: [] }
    outputExpectations: ["implementation"]
    verificationMethod: { kind: "none" }
    budget: { maxIterations: 3, exhaustionEscalation: "architect" }

sharedScopes:
  - roles: ["architect", "worker"]
    patterns: ["src/**", "tests/**"]

phases:
  - id: execution
    actors: ["worker"]
    inputBoundaries: ["src/**", "tests/**"]
    outputBoundaries: ["src/**", "tests/**"]
    preconditions: [{ type: "always" }]
    completionCriteria:
      - { type: "command_succeeds", command: "npm test" }
    successors: []
    isTerminal: true

gates:
  - id: ship
    trigger: "execution->execution"
    audience: "PO"
    requiredInputs:
      - { name: "vision", kind: "path", value: "vision.md" }
      - { name: "architecture", kind: "path", value: "architecture.md" }
    outcomes: { approve: "execution", reject: "execution" }

globalLifetime:
  maxTimeMs: 1800000

escalationChain: []
`
  },
  {
    name: 'CLI tool',
    description: 'A minimal starting point for a CLI tool.',
    content: `roles:
  - id: architect
    scope: ["src/**", "tests/**", "README.md"]
    authority: { allowedCommands: ["npm test"], allowedPaths: [] }
    outputExpectations: ["contract + plan"]
    verificationMethod: { kind: "none" }
    budget: { maxIterations: 2, exhaustionEscalation: "exception_gate" }
  - id: worker
    scope: ["src/**", "tests/**"]
    authority: { allowedCommands: ["npm test"], allowedPaths: [] }
    outputExpectations: ["implementation"]
    verificationMethod: { kind: "none" }
    budget: { maxIterations: 3, exhaustionEscalation: "architect" }

sharedScopes:
  - roles: ["architect", "worker"]
    patterns: ["src/**", "tests/**"]

phases:
  - id: execution
    actors: ["worker"]
    inputBoundaries: ["src/**", "tests/**"]
    outputBoundaries: ["src/**", "tests/**"]
    preconditions: [{ type: "always" }]
    completionCriteria: [{ type: "command_succeeds", command: "npm test" }]
    successors: []
    isTerminal: true

gates:
  - id: plan
    trigger: "execution->execution"
    audience: "PO"
    requiredInputs:
      - { name: "vision", kind: "path", value: "vision.md" }
    outcomes: { approve: "execution", reject: "execution" }

globalLifetime:
  maxTimeMs: 1800000

escalationChain: []
`
  }
] as const;

