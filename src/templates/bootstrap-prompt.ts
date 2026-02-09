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
  lines.push('- A global job lifetime budget must exist.');
  lines.push('');

  lines.push('## Project context');
  lines.push(`- kind: ${ctx.project.kind}`);
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
    for (const d of docsToRead) lines.push(`  - ${d}`);
    lines.push('');
    lines.push('Treat `vision.md` and `architecture.md` as the durable source of truth.');
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
  for (const ex of ctx.exampleContracts) {
    lines.push(`### ${ex.name}`);
    lines.push(ex.description);
    lines.push('```yaml');
    lines.push(ex.content.trimEnd());
    lines.push('```');
    lines.push('');
  }

  lines.push('## Output requirements');
  lines.push('- Ensure the contract is VALID against the constitution.');
  lines.push('- Keep scopes tight and realistic.');
  lines.push('- Include a PO gate (plan/ship).');
  lines.push('- Use reasonable budgets (iterations/time) and a global lifetime.');
  lines.push('');
  lines.push('When finished, emit:');
  lines.push('NIBBLER_EVENT {"type":"PHASE_COMPLETE","summary":"init contract proposed"}');
  lines.push('');

  return lines.join('\n');
}

