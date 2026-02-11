import type { ProjectState } from '../workspace/scanner.js';

export interface InitBootstrapContext {
  project: ProjectState;
  existingContractYaml?: string;
  exampleContracts: Array<{ name: string; description: string; content: string }>;
  contractStagingDir: string;
  artifactQualitySummary?: string;
}

export function renderInitBootstrapPrompt(ctx: InitBootstrapContext): string {
  const lines: string[] = [];

  lines.push('You are the Architect agent for Nibbler initialization.');
  lines.push('');
  lines.push('## Mission');
  lines.push('- Propose a governance contract for this repository that satisfies the constitutional constraints.');
  lines.push(`- Write the proposed contract YAML files under: ${ctx.contractStagingDir}`);
  lines.push('- Produce TWO YAML files with deterministic keys:');
  lines.push('  - team.yaml: roles, sharedScopes, escalationChain');
  lines.push('  - phases.yaml: phases, gates, globalLifetime');
  lines.push('');

  lines.push('## Constitutional constraints (high level)');
  lines.push('- Every role has: scope, budget (with exhaustion escalation), verification method.');
  lines.push('- Protected paths must be excluded from all scopes: .nibbler/** and .cursor/rules/00-nibbler-protocol.mdc');
  lines.push('- Overlapping scopes require shared scope declarations.');
  lines.push('- Phases declare inputs/outputs and deterministically verifiable completion criteria.');
  lines.push('- Phase graph must be a DAG with a reachable terminal phase.');
  lines.push('- Gates must include approve+reject outcomes; at least one PO gate must exist.');
  lines.push('- Every gate must declare: approvalScope, approvalExpectations, businessOutcomes, functionalScope, outOfScope.');
  lines.push('- PLAN PO gates (trigger `planning->...`) must use approvalScope `build_requirements` or `both`, include vision.md + architecture.md as requiredInputs, and provide non-empty businessOutcomes + functionalScope.');
  lines.push('- The contract MUST include a final PO SHIP gate before job completion/merge.');
  lines.push('  - Recommended: use a terminal trigger `${terminalPhaseId}->__END__` so SHIP approval happens AFTER the final phase work is done.');
  lines.push('- A global job lifetime budget must exist.');
  lines.push('');

  lines.push('## Critical schema rules (prevent Zod parse failures)');
  lines.push('- `escalationChain`: array of `{ from: string, to: string, reason?: string }`. Use `escalationChain: []` if no custom chain needed.');
  lines.push('- Every phase MUST have non-empty: `actors`, `inputBoundaries`, `outputBoundaries`, `completionCriteria`.');
  lines.push('- `.nibbler/jobs/**/plan/**` outputs are engine-managed — they are EXEMPT from scope coverage.');
  lines.push('  Do NOT add `.nibbler/**` to any role scope (it is a protected path). Just use it in planning phase outputBoundaries as-is.');
  lines.push('- If a scaffold/planning phase actor (e.g. architect) needs to create files outside its scope,');
  lines.push('  add the paths to `authority.allowedPaths` on the role (NOT to scope). Example:');
  lines.push('  `authority: { allowedCommands: [...], allowedPaths: ["package.json", "frontend/**", "backend/**"] }`');
  lines.push('- `scope` defines what files a role can NORMALLY touch. `authority.allowedPaths` grants extra write access for bootstrap/scaffold work.');
  lines.push('');

  lines.push('## Default best-practice expectations (apply unless clearly inappropriate)');
  lines.push('- Include a docs-focused SHIP phase that produces/updates `README.md` and is checked deterministically:');
  lines.push('  - completionCriteria:');
  lines.push('    - { type: "artifact_exists", pattern: "README.md" }');
  lines.push('    - { type: "markdown_has_headings", path: "README.md", requiredHeadings: ["Install", "Quickstart", "Commands", "Local development"], minChars: 500 }');
  lines.push('  - The "Local development" heading must describe how to run the project end-to-end on a developer machine.');
  lines.push('  - CRITICAL: The SHIP phase must ONLY contain criteria the docs role can satisfy (README.md checks). NEVER put `local_http_smoke`, `command_succeeds`, or other app-level checks in SHIP — the docs role cannot fix app code.');
  lines.push('- If the project is expected to run a local dev server, you MUST add a deterministic local boot check in the **execution** phase completion criteria (NEVER in ship — the docs role cannot fix app issues):');
  lines.push('  - { type: "local_http_smoke", startCommand: "<start command>", url: "<dev server url>", timeoutMs: 60000 }');
  lines.push('  - This ensures the built project actually starts and responds to HTTP requests.');
  lines.push('  - Derive the `startCommand` and `url` from `ARCHITECTURE.md` and the chosen tech stack. Examples: `npx vite --config frontend/vite.config.ts` + `http://localhost:5173`, or `npx next dev -p 3000` + `http://localhost:3000`.');
  lines.push('  - IMPORTANT: The startCommand should point to the correct config file if the app root differs from the project root. For nested layouts, reference the config file directly rather than using `npm run dev`, which may watch the entire project root.');
  lines.push('  - Scoping the dev server to its own source directory prevents file-watcher exhaustion in worktrees.');
  lines.push('- Treat TDD as the responsibility of the engineers implementing production code (backend/frontend/etc.).');
  lines.push('  - Encode TDD as role guidance: red → green → refactor; small increments; keep the suite green at the end of each role session.');
  lines.push('- Keep SDET as a first-class role focused on test strategy/infra and system-level quality (integration/E2E, flake reduction).');
  lines.push('');

  lines.push('## Directory layout principle (scope robustness)');
  lines.push('- Prefer a directory structure where each role owns a distinct top-level folder.');
  lines.push('  Examples: frontend/ (or ui/), backend/ (or api/, server/), tests/ (or e2e/).');
  lines.push('- Shared code that multiple roles need should live in a declared shared folder (e.g. shared/, common/).');
  lines.push('- Define role scopes as top-level folder globs when possible: "frontend/**", "backend/**", "shared/**".');
  lines.push('- This keeps scope enforcement deterministic and avoids fragile patterns like mixing everything under src/.');
  lines.push('- For existing repos: propose a migration-friendly layout that wraps current code without a big-bang rewrite.');
  lines.push('');
  lines.push('## Architect scope (reliability default)');
  lines.push('- The Architect should have broad write access to avoid scope-violation retries during scaffold/triage.');
  lines.push('- Implement this via `authority.allowedPaths: ["**/*"]` on the Architect role (NOT by making `scope: ["**/*"]`, which would violate overlap rules).');
  lines.push('- The engine still blocks engine-protected paths and git internals; do not attempt to write `.nibbler/**`, `.cursor/rules/**`, or `.git/**`.');
  lines.push('');

  lines.push('## Project context');
  lines.push(`- kind: ${ctx.project.kind}`);
  if (ctx.project.kind === 'empty' || ctx.project.kind === 'docs_only') {
    lines.push(
      '- NOTE: This repo has no code scaffold yet. Your contract should include a scaffold step (phase and/or role) ' +
        'that is allowed to create the initial project structure (e.g., package.json, configs, frontend/back-end folders) ' +
        'before feature implementation roles run.'
    );
    lines.push(
      '- If you expect repo-root commands like `npm test`, ensure the owning role scope (or a declared sharedScope) includes required root files ' +
        'like `package.json`, lockfiles, and build config (or choose a folder layout + commands like `npm --prefix frontend test`).'
    );
  }
  lines.push(`- hasContract: ${ctx.project.hasContract}`);
  lines.push(`- hasArchitectureMd: ${ctx.project.hasArchitectureMd}`);
  lines.push(`- hasVisionMd: ${ctx.project.hasVisionMd}`);
  lines.push(`- hasPrdMd: ${ctx.project.hasPrdMd ?? false}`);
  lines.push(`- topLevelEntries: ${ctx.project.topLevelEntries.join(', ') || '(none)'}`);
  if (ctx.project.packageJsonPreview) {
    lines.push(`- package.json: ${JSON.stringify(ctx.project.packageJsonPreview)}`);
  }
  lines.push('');

  // Explicit doc-reading instructions
  const docsToRead: string[] = [];
  if (ctx.project.hasVisionMd) docsToRead.push(ctx.project.visionMdPath ?? 'vision.md');
  if (ctx.project.hasArchitectureMd) docsToRead.push(ctx.project.architectureMdPath ?? 'architecture.md');
  if (ctx.project.hasPrdMd) docsToRead.push(ctx.project.prdMdPath ?? 'PRD.md');
  if (docsToRead.length > 0) {
    lines.push('**IMPORTANT:** Read the following files BEFORE proposing the contract:');
    for (const d of docsToRead) lines.push(`  - @${d}`);
    lines.push('');
    lines.push('Treat the `@vision` and `@architecture` files listed above as the durable source of truth.');
    lines.push('If a PRD exists, use it to validate/reconcile (but do not ignore vision/architecture).');
    lines.push('These documents define the product, architecture, and tech stack. Use them to:');
    lines.push('  - Identify the project type (web-app, API, CLI, etc.)');
    lines.push('  - Identify technical traits (auth, database, realtime, etc.)');
    lines.push('  - Propose specialized roles that match the actual tech stack (e.g., frontend, backend, sdet)');
    lines.push('  - Do NOT use generic "worker" roles — define roles by specialization.');
    lines.push('');
  }

  if (ctx.artifactQualitySummary && ctx.artifactQualitySummary.trim().length > 0) {
    lines.push('## Artifact quality (engine checks)');
    lines.push('The engine ran structural checks on input artifacts. Use this to spot gaps and mitigate risk.');
    lines.push('```text');
    lines.push(ctx.artifactQualitySummary.trimEnd());
    lines.push('```');
    lines.push('');
  }

  lines.push('## Project classification (best-effort)');
  if (ctx.project.projectType) {
    lines.push(`- type: ${ctx.project.projectType} (${ctx.project.classificationConfidence ?? 'low'} confidence)`);
  } else {
    lines.push(`- type: (unknown) (${ctx.project.classificationConfidence ?? 'low'} confidence)`);
  }
  if (Array.isArray(ctx.project.traits) && ctx.project.traits.length) {
    lines.push(`- traits: ${ctx.project.traits.join(', ')}`);
  } else {
    lines.push(`- traits: (none detected)`);
  }
  if (Array.isArray(ctx.project.classificationReasons) && ctx.project.classificationReasons.length) {
    lines.push(`- reasons: ${ctx.project.classificationReasons.join(', ')}`);
  }
  lines.push('');
  lines.push('Use the classification (type + traits) AND the project documents to justify your team composition:');
  lines.push('- NEVER use generic role IDs like "worker". Instead, define roles by specialization.');
  lines.push('  Examples: "frontend", "backend", "sdet", "devops", "data-engineer", "ui-designer".');
  lines.push('- Choose roles/specializations that match the project type, traits, and tech stack.');
  lines.push('- Define realistic scopes and verification per role.');
  lines.push('- Keep roles minimal but sufficient for the detected traits.');
  lines.push('- The Architect role is always required.');
  lines.push('');

  if (ctx.existingContractYaml) {
    lines.push('## Existing contract (for review/update)');
    lines.push('```yaml');
    lines.push(ctx.existingContractYaml.trimEnd());
    lines.push('```');
    lines.push('');
  }

  lines.push('## Examples (suggestions, not templates)');
  lines.push('- Use these as structure hints only; adapt to this repository and contract constraints.');
  const selectedExamples = selectExampleContracts(ctx.exampleContracts, ctx.project.projectType, 2);
  for (const ex of selectedExamples) {
    lines.push(`### ${ex.name}`);
    lines.push(ex.description);
    lines.push('```yaml');
    lines.push(truncateExampleYaml(ex.content, 2_600));
    lines.push('```');
    lines.push('');
  }
  if (ctx.exampleContracts.length > selectedExamples.length) {
    lines.push(`(omitted ${ctx.exampleContracts.length - selectedExamples.length} additional example contract(s) for brevity)`);
    lines.push('');
  }

  lines.push('## Output requirements');
  lines.push('- Ensure the contract is VALID against the constitution.');
  lines.push('- Keep scopes tight and realistic.');
  lines.push('- Include PO gates for PLAN approval and final SHIP approval (before job completion/merge).');
  lines.push('- Define business/functional approval details for each gate: approvalExpectations, businessOutcomes, functionalScope, outOfScope.');
  lines.push('- Use reasonable budgets (iterations/time) and a global lifetime.');
  lines.push('- The scaffold phase completion criteria MUST include `command_succeeds: npm install` AND `command_succeeds: npm run build` to verify the scaffold is functional before execution roles inherit it.');
  lines.push('- The execution phase SHOULD include `command_succeeds: npm test` if a test script is expected, not just `diff_non_empty`.');
  lines.push('- The execution phase SHOULD also include `command_succeeds: npm run build` to catch unresolved imports and type errors before the smoke test runs. This prevents agents from importing packages they forgot to add to package.json.');
  lines.push('- SDET/test roles should only own `tests/**` and test config files. Do NOT include source files (e.g. `frontend/**`) in their scope.');
  lines.push('  If tests need test IDs in source components, add those specific files to sharedScopes or assign the test-ID work to the owning role.');
  lines.push('- Execution roles frequently need `package.json` and `package-lock.json` (for npm install). Add them to sharedScopes for all execution-phase roles. The engine also auto-shares them, but explicit is better.');
  lines.push('- If the scaffold phase creates root config files (tsconfig.json, next.config.*, etc.) that execution roles may need, add them to sharedScopes.');
  lines.push('');
  lines.push('After writing the contract YAML files, signal completion by outputting this as plain text in your response (NOT inside any file):');
  lines.push('');
  lines.push('```');
  lines.push('NIBBLER_EVENT {"type":"PHASE_COMPLETE","summary":"init contract proposed"}');
  lines.push('```');
  lines.push('');
  lines.push('CRITICAL: The NIBBLER_EVENT line is a protocol signal. NEVER write it into any file.');
  lines.push('');

  return lines.join('\n');
}

function selectExampleContracts(
  examples: Array<{ name: string; description: string; content: string }>,
  projectType: string | undefined,
  maxItems: number
): Array<{ name: string; description: string; content: string }> {
  if (examples.length <= maxItems) return examples;
  const needle = (projectType ?? '').trim().toLowerCase();
  const scored = examples.map((ex, index) => {
    const haystack = `${ex.name} ${ex.description}`.toLowerCase();
    const score = needle && haystack.includes(needle) ? 1 : 0;
    return { ex, index, score };
  });
  scored.sort((a, b) => (b.score - a.score) || (a.index - b.index));
  return scored.slice(0, maxItems).map((x) => x.ex);
}

function truncateExampleYaml(yaml: string, maxChars: number): string {
  const trimmed = yaml.trimEnd();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars)}\n# ... truncated for prompt window ...`;
}

