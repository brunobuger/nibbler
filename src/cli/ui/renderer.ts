import chalk from 'chalk';

import type { GateDefinition } from '../../core/contract/types.js';
import type { GateResolution } from '../../core/gate/types.js';
import type { ArtifactQualityReport } from '../../discovery/artifact-validator.js';
import { theme, INDENT, RULE_WIDTH, ROLE_LABEL_WIDTH } from './theme.js';
import {
  formatMs,
  phaseBanner,
  dashedRule,
  roleLabel,
  roleContinuation,
  verificationLine,
  keyValue,
  drawBox,
  safeJson,
  type VerificationLine,
} from './format.js';
import { brandLine, welcomeBanner, initExplanation, workspaceSummary, contractSummary } from './branding.js';
import { startSpinner, type SpinnerHandle } from './spinner.js';
import type { GatePromptModel } from './gate-prompt.js';
import { promptInput, promptSelect } from './prompts.js';

// ── Renderer Interface ──────────────────────────────────────────────────────

/**
 * The Renderer is the single output coordinator for the CLI.
 * All user-facing output routes through it, enabling:
 * - InteractiveRenderer for rich TTY output (colors, spinners, box-drawing)
 * - QuietRenderer for machine-friendly JSON lines (--quiet mode)
 */
export interface Renderer {
  // ── Branding ──
  brand(version: string): void;
  welcome(version: string): void;
  initExplanation(): void;
  workspaceScan(info: Parameters<typeof workspaceSummary>[0]): void;
  artifactQualityReport(reports: ArtifactQualityReport[]): void;
  contractSummary(contract: Parameters<typeof contractSummary>[0], filePaths?: string[]): void;

  // ── Phase / Workflow ──
  phaseBanner(phase: string): void;
  statusLine(info: { jobId: string; phase: string; role?: string; roleIndex?: number; roleTotal?: number }): void;

  // ── Role-Tagged Activity Stream ──
  roleMessage(role: string, message: string): void;
  roleWorking(role: string, taskDescription: string): void;
  roleComplete(role: string, summary: string, durationMs?: number): void;
  roleFailed(role: string, reason: string): void;
  roleEscalation(role: string, reason: string): void;
  roleRetry(role: string, attempt: number, maxAttempts: number, reason?: string): void;
  handoff(fromRole: string, toRole: string): void;

  // ── Verification ──
  verificationStart(role: string): void;
  verificationResult(role: string, items: VerificationLine[]): void;
  commitSuccess(role: string, commitHash: string): void;

  // ── Errors ──
  error(title: string, details: string, tip?: string): void;
  scopeViolation(role: string, violations: Array<{ file: string; owner?: string }>, scope: string[]): void;
  warn(message: string): void;

  // ── Gates ──
  presentGatePrompt(gateDef: GateDefinition, model: GatePromptModel, renderedInputs: Record<string, unknown>): Promise<GateResolution>;

  // ── Spinners ──
  spinner(message: string): SpinnerHandle;

  // ── Completion ──
  jobComplete(info: {
    jobId: string;
    durationMs: number;
    roles: string[];
    commits: number;
    filesChanged: number;
    linesAdded: number;
    linesRemoved: number;
    branch: string;
    evidencePath: string;
    ledgerPath: string;
  }): void;

  // ── Generic ──
  text(message: string): void;
  blank(): void;
  info(message: string): void;
  success(message: string): void;
  dim(message: string): void;
}

// ── Interactive Renderer (Rich TTY Output) ──────────────────────────────────

export class InteractiveRenderer implements Renderer {
  private write(msg: string): void {
    process.stderr.write(msg);
  }
  private writeln(msg: string = ''): void {
    process.stderr.write(msg + '\n');
  }

  brand(version: string): void {
    this.writeln(brandLine(version));
  }

  welcome(version: string): void {
    this.writeln(welcomeBanner(version));
  }

  initExplanation(): void {
    this.write(initExplanation());
  }

  workspaceScan(info: Parameters<typeof workspaceSummary>[0]): void {
    this.writeln(workspaceSummary(info));
    this.writeln();
  }

  artifactQualityReport(reports: ArtifactQualityReport[]): void {
    const lines: string[] = [];
    for (const r of reports) {
      const badge =
        r.score === 'good'
          ? theme.success('GOOD')
          : r.score === 'needs-improvement'
            ? theme.warning('NEEDS_IMPROVEMENT')
            : theme.error('INSUFFICIENT');
      lines.push(`${theme.bold(r.file)}: ${badge}`);
      for (const issue of r.issues) {
        const tag = issue.severity === 'error' ? theme.error('error') : theme.warning('warn');
        lines.push(`  - ${tag} ${issue.message}`);
      }
      lines.push('');
    }
    // Trim trailing blanks for nicer boxes.
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    const box = drawBox('Artifact Quality', lines.length > 0 ? lines : ['(no data)'], RULE_WIDTH);
    this.writeln(box);
    this.writeln();
  }

  contractSummary(contract: Parameters<typeof contractSummary>[0], filePaths?: string[]): void {
    const content = contractSummary(contract);
    const box = drawBox('Contract Summary', content.split('\n'), RULE_WIDTH);
    this.writeln(box);
    if (filePaths && filePaths.length > 0) {
      this.writeln();
      this.writeln(`${INDENT}${theme.dim('Full contract:')} ${filePaths.join(', ')}`);
    }
    this.writeln();
  }

  phaseBanner(phase: string): void {
    this.writeln();
    this.writeln(INDENT + phaseBanner(phase));
    this.writeln();
  }

  statusLine(info: { jobId: string; phase: string; role?: string; roleIndex?: number; roleTotal?: number }): void {
    const parts = [
      `Job ${theme.bold(info.jobId)}`,
      `Phase: ${theme.bold(info.phase)}`,
    ];
    if (info.role) {
      const rolePart = info.roleIndex != null && info.roleTotal != null
        ? `Role: ${theme.bold(info.role)} (${info.roleIndex}/${info.roleTotal})`
        : `Role: ${theme.bold(info.role)}`;
      parts.push(rolePart);
    }
    this.writeln(INDENT + parts.join(theme.dim('  |  ')));
    this.writeln();
  }

  roleMessage(role: string, message: string): void {
    const label = roleLabel(role);
    const lines = message.split('\n');
    this.writeln(`${INDENT}${label}${lines[0]}`);
    for (let i = 1; i < lines.length; i++) {
      this.writeln(`${INDENT}${roleContinuation(lines[i])}`);
    }
  }

  roleWorking(role: string, taskDescription: string): void {
    this.roleMessage(role, `Working on: ${taskDescription}`);
  }

  roleComplete(role: string, summary: string, durationMs?: number): void {
    const timing = durationMs != null ? ` ${theme.dim(`(${formatMs(durationMs)})`)}` : '';
    this.roleMessage(role, `${theme.success('COMPLETE')} — ${summary}${timing}`);
  }

  roleFailed(role: string, reason: string): void {
    this.roleMessage(role, `${theme.error('FAILED')} — ${reason}`);
  }

  roleEscalation(role: string, reason: string): void {
    this.roleMessage(role, `${theme.warning('NEEDS_ESCALATION')} — ${reason}`);
  }

  roleRetry(role: string, attempt: number, maxAttempts: number, reason?: string): void {
    const detail = reason ? ` — ${reason}` : '';
    this.roleMessage(role, `Retrying (attempt ${attempt}/${maxAttempts})${detail}`);
  }

  handoff(_fromRole: string, _toRole: string): void {
    this.writeln(INDENT + dashedRule(RULE_WIDTH - 2));
    this.writeln();
  }

  verificationStart(role: string): void {
    this.writeln();
    this.writeln(`${INDENT}${theme.dim(`Verifying ${role} session...`)}`);
  }

  verificationResult(_role: string, items: VerificationLine[]): void {
    for (const item of items) {
      this.writeln(verificationLine(item));
    }
  }

  commitSuccess(role: string, commitHash: string): void {
    this.writeln();
    this.writeln(`${INDENT}${theme.success(role)} complete — committed ${theme.dim(`[${commitHash.slice(0, 7)}]`)}`);
  }

  error(title: string, details: string, tip?: string): void {
    this.writeln();
    this.writeln(`${INDENT}${theme.error(theme.bold('ERROR'))}  ${title}`);
    this.writeln();
    for (const line of details.split('\n')) {
      this.writeln(`${INDENT}${line}`);
    }
    if (tip) {
      this.writeln();
      this.writeln(`${INDENT}${theme.dim('Tip:')} ${tip}`);
    }
    this.writeln();
  }

  scopeViolation(role: string, violations: Array<{ file: string; owner?: string }>, scope: string[]): void {
    this.writeln();
    this.roleMessage(role, `${theme.error('SCOPE VIOLATION')} — ${violations.length} file${violations.length > 1 ? 's' : ''} outside declared scope`);
    this.writeln();
    for (const v of violations) {
      const ownerNote = v.owner ? theme.dim(` (owned by: ${v.owner})`) : '';
      this.writeln(`${INDENT}${' '.repeat(ROLE_LABEL_WIDTH)}${v.file}${ownerNote}`);
    }
    this.writeln();
    this.writeln(`${INDENT}${' '.repeat(ROLE_LABEL_WIDTH)}${theme.dim(`Declared scope: ${scope.join(', ')}`)}`);
    this.writeln(`${INDENT}${' '.repeat(ROLE_LABEL_WIDTH)}${theme.dim('Reverting changes, retrying with feedback...')}`);
  }

  warn(message: string): void {
    this.writeln(`${INDENT}${theme.warning('⚠')} ${message}`);
  }

  async presentGatePrompt(
    gateDef: GateDefinition,
    model: GatePromptModel,
    renderedInputs: Record<string, unknown>,
  ): Promise<GateResolution> {
    // Test overrides — must match the old gate-prompt.ts behavior exactly.
    const testResult = resolveTestGateDecision(gateDef);
    if (testResult) return testResult;

    // Build box content
    const boxLines: string[] = [];
    boxLines.push(`${theme.gate.label('Job:')}    ${model.title}`);
    if (model.description && model.description !== model.title) {
      boxLines.push(`${theme.gate.label('Req:')}    ${model.description}`);
    }
    if (model.subtitle) boxLines.push(`${theme.gate.label('Audience:')} ${model.subtitle.replace(/^Gate audience:\\s*/i, '')}`);

    // Reduce redundancy: prefer a single transition/outcomes line.
    if (model.transition?.includes('->__END__')) {
      boxLines.push(`${theme.gate.label('Trigger:')} ${model.transition}`);
    } else if (model.currentPhase && model.approveNext) {
      boxLines.push(`${theme.gate.label('Transition:')} ${model.currentPhase} ${theme.arrow} ${model.approveNext}`);
    } else if (model.transition) {
      boxLines.push(`${theme.gate.label('Trigger:')} ${model.transition}`);
    }
    if (model.approveNext || model.rejectNext) {
      const approve = model.approveNext ? `approve ${theme.arrow} ${model.approveNext}` : '';
      const reject = model.rejectNext ? `reject ${theme.arrow} ${model.rejectNext}` : '';
      const combined = `${approve}${approve && reject ? theme.dim('  |  ') : ''}${reject}`.trim();
      if (combined) boxLines.push(`${theme.gate.label('Outcomes:')} ${combined}`);
    }
    if (model.approvalScope) {
      boxLines.push(`${theme.gate.label('Approval Scope:')} ${model.approvalScope}`);
    }
    boxLines.push('');

    if (model.team && model.team.length > 0) {
      boxLines.push(theme.bold('Team:'));
      const maxRoleLen = Math.max(...model.team.map((t) => t.roleId.length), 4);
      for (const t of model.team) {
        const roleColor = theme.role(t.roleId);
        const scope = Array.isArray(t.scope) ? t.scope : [];
        const scopeStr =
          scope.length <= 3 ? scope.join(', ') : `${scope.slice(0, 2).join(', ')} +${scope.length - 2} more`;
        boxLines.push(`  ${roleColor(theme.bold(t.roleId.padEnd(maxRoleLen + 2)))}${theme.dim(scopeStr)}`);
      }
      boxLines.push('');
    }

    if (model.completionCriteria && model.completionCriteria.length > 0) {
      const criteriaTitle = model.approvalScope === 'build_requirements' ? 'Verification Checks:' : 'Acceptance Criteria:';
      boxLines.push(theme.bold(criteriaTitle));
      for (const line of model.completionCriteria) {
        boxLines.push(`  ${theme.check} ${line}`);
      }
      boxLines.push('');
    }

    if (model.approvalExpectations && model.approvalExpectations.length > 0) {
      boxLines.push(theme.bold('Build Expectations:'));
      for (const line of model.approvalExpectations) boxLines.push(`  ${theme.bullet} ${line}`);
      boxLines.push('');
    }

    if (model.businessOutcomes && model.businessOutcomes.length > 0) {
      boxLines.push(theme.bold('Business Outcomes:'));
      for (const line of model.businessOutcomes) boxLines.push(`  ${theme.bullet} ${line}`);
      boxLines.push('');
    }

    if (model.functionalScope && model.functionalScope.length > 0) {
      boxLines.push(theme.bold('Functional Scope:'));
      for (const line of model.functionalScope) boxLines.push(`  ${theme.bullet} ${line}`);
      boxLines.push('');
    }

    if (model.outOfScope && model.outOfScope.length > 0) {
      boxLines.push(theme.bold('Out of Scope:'));
      for (const line of model.outOfScope) boxLines.push(`  ${theme.bullet} ${line}`);
      boxLines.push('');
    }

    if (model.outputExpectations && model.outputExpectations.length > 0) {
      boxLines.push(theme.bold('Output Expectations:'));
      for (const r of model.outputExpectations) {
        const color = theme.role(r.roleId);
        const shown = r.expectations.slice(0, 3);
        boxLines.push(`  ${color(theme.bold(r.roleId))}`);
        for (const e of shown) boxLines.push(`    ${theme.bullet} ${e}`);
        if (r.expectations.length > shown.length) {
          boxLines.push(`    ${theme.dim(`+${r.expectations.length - shown.length} more`)}`);
        }
      }
      boxLines.push('');
    }

    if (model.artifacts.length > 0) {
      boxLines.push(theme.bold('Artifacts:'));
      for (const a of model.artifacts) {
        const status = a.exists === false ? theme.error('missing') : theme.success('ok');
        const displayPath = a.path ?? a.name;
        const previewLines = a.preview ? countLines(a.preview) : 0;
        const previewHint =
          a.preview && previewLines > 0
            ? theme.dim(` (preview: ${previewLines} line${previewLines === 1 ? '' : 's'})`)
            : '';
        const globHint =
          a.matchesCount != null
            ? theme.dim(` (glob: ${a.matchesCount} match${a.matchesCount === 1 ? '' : 'es'}${a.exampleMatch ? `, ex: ${a.exampleMatch}` : ''})`)
            : '';
        boxLines.push(`  ${displayPath}  ${status}${previewHint}${globHint}`);
      }
      boxLines.push('');
    }

    if (model.rolesCompleted && model.rolesRemaining) {
      const done = model.rolesCompleted.length;
      const total = done + model.rolesRemaining.length;
      boxLines.push(`${theme.gate.label('Progress:')} ${done}/${total} roles completed`);
    }

    const box = drawBox(`PO Gate: ${gateDef.id.toUpperCase()}`, boxLines, RULE_WIDTH);
    this.writeln();
    this.writeln(box);
    this.writeln();

    while (true) {
      const action = await promptSelect({
        message: 'Decision',
        choices: [
          { name: `${chalk.green('Approve')}`, value: 'approve' as const },
          { name: `${chalk.red('Reject')}`, value: 'reject' as const },
          { name: `${chalk.dim('View artifact')}`, value: 'artifact' as const },
          { name: `${chalk.dim('View inputs')}`, value: 'view' as const },
        ],
      });

      if (action === 'approve') {
        const notes = await promptInput({ message: 'Notes (optional)', default: '' });
        return { decision: 'approve', notes: notes.trim() || undefined };
      }

      if (action === 'reject') {
        const notes = await promptInput({ message: 'Rejection reason', default: '' });
        return { decision: 'reject', notes: notes.trim() || undefined };
      }

      if (action === 'artifact') {
        const candidates = [
          { name: `${chalk.dim('Back')}`, value: '__back__' },
          ...model.artifacts
            .filter((a) => a.exists !== false)
            .map((a) => {
              const label = a.path ?? a.name;
              const suffix = a.preview ? theme.dim(` (${countLines(a.preview)} lines)`) : theme.dim(' (no preview)');
              return { name: `${label}${suffix}`, value: a.name };
            }),
        ];

        if (!candidates.length) {
          this.writeln();
          this.writeln(`${INDENT}${theme.dim('No artifacts available to preview.')}`);
          this.writeln();
          continue;
        }

        const chosen = await promptSelect<string>({
          message: 'Select artifact',
          choices: candidates,
        });
        if (chosen === '__back__') continue;

        const artifact = model.artifacts.find((a) => a.name === chosen);
        this.writeln();
        this.writeln(INDENT + theme.dim('── Artifact Preview ──'));
        this.writeln(INDENT + theme.bold(artifact?.path ?? artifact?.name ?? chosen));
        if (artifact?.preview) {
          const preview = truncateLines(artifact.preview, 160);
          this.writeln(preview.endsWith('\n') ? preview.trimEnd() : preview);
        } else {
          this.writeln(INDENT + theme.dim('(no preview available)'));
        }
        this.writeln(INDENT + theme.dim('── end ──'));
        this.writeln();
        continue;
      }

      // View inputs
      this.writeln();
      this.writeln(INDENT + theme.dim('── Gate Inputs ──'));
      this.writeln(safeJson(renderedInputs));
      this.writeln(INDENT + theme.dim('── end ──'));
      this.writeln();
    }
  }

  spinner(message: string): SpinnerHandle {
    return startSpinner(message);
  }

  jobComplete(info: {
    jobId: string;
    durationMs: number;
    roles: string[];
    commits: number;
    filesChanged: number;
    linesAdded: number;
    linesRemoved: number;
    branch: string;
    evidencePath: string;
    ledgerPath: string;
  }): void {
    this.writeln();
    this.writeln(INDENT + phaseBanner('Complete'));
    this.writeln();
    this.writeln(`${INDENT}${theme.success('Job ' + info.jobId + ' completed successfully')}`);
    this.writeln();
    this.writeln(keyValue('Duration', formatMs(info.durationMs)));
    this.writeln(keyValue('Roles', `${info.roles.length} (${info.roles.join(', ')})`));
    this.writeln(keyValue('Commits', String(info.commits)));
    this.writeln(keyValue('Files', `${info.filesChanged} changed (+${info.linesAdded} / -${info.linesRemoved})`));
    this.writeln(keyValue('Branch', info.branch));
    this.writeln();
    this.writeln(keyValue('Evidence', info.evidencePath));
    this.writeln(keyValue('Ledger', info.ledgerPath));
    this.writeln();
    this.writeln(`${INDENT}${theme.dim('Next: review the branch and merge when ready.')}`);
    this.writeln();
  }

  text(message: string): void {
    this.writeln(message);
  }

  blank(): void {
    this.writeln();
  }

  info(message: string): void {
    this.writeln(`${INDENT}${theme.info('ℹ')} ${message}`);
  }

  success(message: string): void {
    this.writeln(`${INDENT}${theme.check} ${message}`);
  }

  dim(message: string): void {
    this.writeln(`${INDENT}${theme.dim(message)}`);
  }
}

function countLines(text: string): number {
  if (!text) return 0;
  // Normalize newline handling; keep it cheap.
  return text.replace(/\n$/g, '').split('\n').length;
}

function truncateLines(text: string, maxLines: number): string {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text;
  return lines.slice(0, maxLines).join('\n') + '\n... (truncated)\n';
}

// ── Quiet Renderer (JSON Lines) ─────────────────────────────────────────────

export class QuietRenderer implements Renderer {
  private emit(type: string, data: Record<string, unknown> = {}): void {
    const event = { type, timestamp: new Date().toISOString(), ...data };
    process.stderr.write(JSON.stringify(event) + '\n');
  }

  brand(): void { /* no-op in quiet mode */ }
  welcome(): void { /* no-op */ }
  initExplanation(): void { /* no-op */ }

  workspaceScan(info: Parameters<typeof workspaceSummary>[0]): void {
    this.emit('workspace_scan', { ...info });
  }

  artifactQualityReport(reports: ArtifactQualityReport[]): void {
    this.emit('artifact_quality', { reports });
  }

  contractSummary(contract: Parameters<typeof contractSummary>[0]): void {
    this.emit('contract_summary', {
      roles: contract.roles.map((r) => ({
        id: r.id,
        scope: r.scope,
        outputExpectations: r.outputExpectations ?? [],
      })),
      phases: contract.phases.map((p) => ({
        id: p.id,
        actors: p.actors,
        completionCriteria: p.completionCriteria,
        successors: p.successors ?? [],
        isTerminal: p.isTerminal ?? false,
      })),
      gates: contract.gates.map((g) => ({
        id: g.id,
        audience: String(g.audience),
        trigger: g.trigger,
        requiredInputs: g.requiredInputs ?? [],
        outcomes: g.outcomes ?? {},
      })),
    });
  }

  phaseBanner(phase: string): void {
    this.emit('phase_start', { phase });
  }

  statusLine(info: { jobId: string; phase: string; role?: string }): void {
    this.emit('status', info);
  }

  roleMessage(role: string, message: string): void {
    this.emit('role_message', { role, message });
  }

  roleWorking(role: string, taskDescription: string): void {
    this.emit('role_working', { role, task: taskDescription });
  }

  roleComplete(role: string, summary: string, durationMs?: number): void {
    this.emit('role_complete', { role, summary, duration_ms: durationMs });
  }

  roleFailed(role: string, reason: string): void {
    this.emit('role_failed', { role, reason });
  }

  roleEscalation(role: string, reason: string): void {
    this.emit('role_escalation', { role, reason });
  }

  roleRetry(role: string, attempt: number, maxAttempts: number, reason?: string): void {
    this.emit('role_retry', { role, attempt, max_attempts: maxAttempts, reason });
  }

  handoff(fromRole: string, toRole: string): void {
    this.emit('handoff', { from: fromRole, to: toRole });
  }

  verificationStart(role: string): void {
    this.emit('verification_start', { role });
  }

  verificationResult(role: string, items: VerificationLine[]): void {
    this.emit('verification_result', { role, items });
  }

  commitSuccess(role: string, commitHash: string): void {
    this.emit('commit', { role, hash: commitHash });
  }

  error(title: string, details: string, tip?: string): void {
    this.emit('error', { title, details, tip });
  }

  scopeViolation(role: string, violations: Array<{ file: string; owner?: string }>, scope: string[]): void {
    this.emit('scope_violation', { role, violations, scope });
  }

  warn(message: string): void {
    this.emit('warning', { message });
  }

  async presentGatePrompt(
    gateDef: GateDefinition,
    _model: GatePromptModel,
    _renderedInputs: Record<string, unknown>,
  ): Promise<GateResolution> {
    // Test overrides
    const testResult = resolveTestGateDecision(gateDef);
    if (testResult) return testResult;

    // Emit useful gate context for non-interactive consumers.
    // Avoid emitting large file previews in quiet mode.
    this.emit('gate_waiting', {
      gate: gateDef.id,
      trigger: gateDef.trigger,
      audience: String(gateDef.audience),
      requiredInputs: gateDef.requiredInputs ?? [],
      outcomes: gateDef.outcomes ?? {},
      model: {
        title: (_model as any)?.title,
        description: (_model as any)?.description,
        transition: (_model as any)?.transition,
        currentPhase: (_model as any)?.currentPhase,
        approveNext: (_model as any)?.approveNext,
        rejectNext: (_model as any)?.rejectNext,
        approvalScope: (_model as any)?.approvalScope,
        approvalExpectations: (_model as any)?.approvalExpectations,
        businessOutcomes: (_model as any)?.businessOutcomes,
        functionalScope: (_model as any)?.functionalScope,
        outOfScope: (_model as any)?.outOfScope,
        completionCriteria: (_model as any)?.completionCriteria,
        outputExpectations: (_model as any)?.outputExpectations,
        rolesCompleted: (_model as any)?.rolesCompleted,
        rolesRemaining: (_model as any)?.rolesRemaining,
        artifacts: Array.isArray((_model as any)?.artifacts)
          ? (_model as any).artifacts.map((a: any) => ({
              name: a?.name,
              path: a?.path,
              exists: a?.exists,
              matchesCount: a?.matchesCount,
              exampleMatch: a?.exampleMatch,
            }))
          : [],
      },
    });
    // In non-interactive quiet mode, default to approve.
    return { decision: 'approve', notes: 'auto-approved (quiet mode)' };
  }

  spinner(message: string): SpinnerHandle {
    this.emit('spinner', { message });
    return {
      update: () => {},
      succeed: () => {},
      fail: () => {},
      warn: () => {},
      info: () => {},
      stop: () => {},
    };
  }

  jobComplete(info: {
    jobId: string;
    durationMs: number;
    roles: string[];
    commits: number;
    filesChanged: number;
    linesAdded: number;
    linesRemoved: number;
    branch: string;
    evidencePath: string;
    ledgerPath: string;
  }): void {
    this.emit('job_complete', info);
  }

  text(message: string): void {
    this.emit('text', { message });
  }

  blank(): void { /* no-op */ }

  info(message: string): void {
    this.emit('info', { message });
  }

  success(message: string): void {
    this.emit('success', { message });
  }

  dim(message: string): void {
    this.emit('dim', { message });
  }
}

// ── Test Gate Decision Helper ────────────────────────────────────────────────

let _rejectOnceUsed = false;
let _lastForcedGate: string | undefined = undefined;

/**
 * Resolve gate decisions from test environment variables.
 * Supports: NIBBLER_TEST_AUTO_APPROVE, NIBBLER_TEST_GATE_DECISION (approve|reject|reject_once).
 */
function resolveTestGateDecision(gateDef: GateDefinition): GateResolution | null {
  if (process.env.NIBBLER_TEST_AUTO_APPROVE === '1') {
    return { decision: 'approve', notes: 'auto-approved (test)' };
  }
  const forced = process.env.NIBBLER_TEST_GATE_DECISION?.trim();
  if (forced !== _lastForcedGate) {
    _rejectOnceUsed = false;
    _lastForcedGate = forced;
  }
  if (forced === 'approve' || forced === 'reject') {
    return { decision: forced, notes: `forced (${forced}) (test)` };
  }
  if (forced === 'reject_once') {
    if (!_rejectOnceUsed) {
      _rejectOnceUsed = true;
      return { decision: 'reject', notes: `forced reject_once gate=${gateDef.id} (test)` };
    }
    return { decision: 'approve', notes: `forced approve after reject_once (test)` };
  }
  return null;
}

// ── Factory ─────────────────────────────────────────────────────────────────

let _instance: Renderer | null = null;

/**
 * Get the global Renderer instance.
 * Defaults to InteractiveRenderer; use `setRenderer` to override.
 */
export function getRenderer(): Renderer {
  if (!_instance) {
    _instance = process.env.NIBBLER_QUIET === '1'
      ? new QuietRenderer()
      : new InteractiveRenderer();
  }
  return _instance;
}

/**
 * Override the global Renderer (e.g., for testing or --quiet mode).
 */
export function setRenderer(renderer: Renderer): void {
  _instance = renderer;
}

/**
 * Create the appropriate renderer based on flags.
 */
export function createRenderer(opts: { quiet?: boolean } = {}): Renderer {
  const r = opts.quiet ? new QuietRenderer() : new InteractiveRenderer();
  _instance = r;
  return r;
}
