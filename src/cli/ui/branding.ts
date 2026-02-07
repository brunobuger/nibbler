import chalk from 'chalk';
import { theme } from './theme.js';

// ── Brand Identity ──────────────────────────────────────────────────────────

const LOGO = `  ${chalk.bold('nibbler')}`;

/**
 * Display the brand header: logo + version + tagline.
 * Compact: single line for normal usage, expanded for --help.
 */
export function brandLine(version: string): string {
  return `${LOGO} ${theme.dim(`v${version}`)} ${theme.dim('—')} ${theme.dim('constitutional AI orchestration')}`;
}

/**
 * Welcome banner for `nibbler init` (first-time onboarding).
 */
export function welcomeBanner(version: string): string {
  return brandLine(version);
}

/**
 * Init onboarding explanation shown to first-time users.
 */
export function initExplanation(): string {
  const lines = [
    '',
    `  Nibbler will ask an Architect agent to propose a governance`,
    `  contract for your project. This defines:`,
    '',
    `    ${theme.bold('Roles')}       Who works on what (scopes, authority)`,
    `    ${theme.bold('Phases')}      The workflow (discovery ${theme.arrow} plan ${theme.arrow} build ${theme.arrow} ship)`,
    `    ${theme.bold('Gates')}       Where you review and approve`,
    '',
    `  You'll review and approve the contract before anything is committed.`,
    '',
  ];
  return lines.join('\n');
}

/**
 * Workspace scan summary shown during init.
 */
export function workspaceSummary(info: {
  repoPath: string;
  isClean: boolean;
  hasCode: boolean;
  language?: string;
  fileCount?: number;
  hasArchitecture: boolean;
  hasVision: boolean;
  hasPrd?: boolean;
  hasContract: boolean;
  isReview: boolean;
  projectType?: string;
  traits?: string[];
}): string {
  const lines: string[] = [];

  const repoStatus = info.isClean ? theme.success('clean') : theme.warning('dirty');
  lines.push(`  ${theme.dim('Git repo:')}         ${info.repoPath} (${repoStatus})`);

  if (info.hasCode && info.language) {
    lines.push(`  ${theme.dim('Existing code:')}    ${info.language}${info.fileCount ? `, ${info.fileCount} files` : ''}`);
  } else if (!info.hasCode) {
    lines.push(`  ${theme.dim('Existing code:')}    ${theme.dim('none')}`);
  }

  lines.push(
    `  ${theme.dim('architecture.md:')}  ${info.hasArchitecture ? theme.success('found') : theme.dim('none')}`,
  );
  lines.push(
    `  ${theme.dim('vision.md:')}        ${info.hasVision ? theme.success('found') : theme.dim('none')}`,
  );
  if (info.hasPrd != null) {
    lines.push(
      `  ${theme.dim('PRD.md:')}           ${info.hasPrd ? theme.success('found') : theme.dim('none')}`,
    );
  }
  lines.push(
    `  ${theme.dim('Contract:')}         ${info.hasContract ? theme.success('found') + (info.isReview ? ' (review mode)' : '') : theme.dim('none (first init)')}`,
  );

  if (info.projectType) {
    lines.push(`  ${theme.dim('Project type:')}     ${theme.bold(info.projectType)}`);
  }
  if (info.traits && info.traits.length > 0) {
    lines.push(`  ${theme.dim('Traits:')}           ${info.traits.join(', ')}`);
  }

  const mode = info.isReview
    ? 'Contract review'
    : info.hasCode
      ? 'Existing project initialization'
      : 'Greenfield initialization';
  lines.push('');
  lines.push(`  ${theme.dim('Mode:')} ${theme.bold(mode)}`);

  return lines.join('\n');
}

/**
 * Contract summary for init approval — displayed in a box.
 */
export function contractSummary(contract: {
  roles: Array<{ id: string; scope: string[] }>;
  phases: Array<{ id: string; isTerminal?: boolean }>;
  gates: Array<{ id: string; audience: string; trigger: string }>;
}): string {
  const lines: string[] = [];

  // Roles
  lines.push(theme.bold('Roles'));
  const maxRoleLen = Math.max(...contract.roles.map((r) => r.id.length), 4);
  for (const role of contract.roles) {
    const roleColor = theme.role(role.id);
    const scopeStr = role.scope.length <= 3
      ? role.scope.join(', ')
      : `${role.scope.slice(0, 2).join(', ')} +${role.scope.length - 2} more`;
    lines.push(`  ${roleColor(theme.bold(role.id.padEnd(maxRoleLen + 2)))}${theme.dim(scopeStr)}`);
  }

  lines.push('');

  // Phases
  lines.push(theme.bold('Phases'));
  const phaseFlow = contract.phases.map((p) => p.id).join(` ${theme.arrow} `);
  lines.push(`  ${phaseFlow}`);

  lines.push('');

  // Gates
  if (contract.gates.length > 0) {
    lines.push(theme.bold('Gates'));
    for (const gate of contract.gates) {
      lines.push(`  ${theme.bold(gate.id.padEnd(8))}(${gate.audience})   ${theme.dim(gate.trigger)}`);
    }
  }

  return lines.join('\n');
}
