import type { CompiledContext } from './types.js';

export function renderOverlay(ctx: CompiledContext): string {
  const role = ctx.identity.role;
  const phase = ctx.mission.phase;

  const lines: string[] = [];
  lines.push(`# Role: ${role.id}`);
  lines.push('');
  lines.push('## Identity');
  lines.push(`- Scope: ${role.scope.map((s) => `\`${s}\``).join(', ')}`);
  const allowedPaths = role.authority.allowedPaths ?? [];
  if (allowedPaths.length > 0) {
    lines.push(`- Allowed paths (extra write access): ${allowedPaths.map((s) => `\`${s}\``).join(', ')}`);
  }
  if (ctx.identity.sharedScope.length > 0) {
    lines.push(`- Shared scope: ${ctx.identity.sharedScope.map((s) => `\`${s}\``).join(', ')}`);
  }
  lines.push(`- Allowed commands: ${role.authority.allowedCommands.map((c) => `\`${c}\``).join(', ') || '(none)'}`);
  lines.push(`- Output expectations: ${role.outputExpectations.map((x) => `\`${x}\``).join(', ') || '(none)'}`);
  lines.push('');
  lines.push('### Scope enforcement (engine-verified)');
  lines.push('- You may ONLY modify files within: Scope + Shared scope + Allowed paths.');
  lines.push('- Any out-of-scope file change will be REVERTED and your session will be retried.');
  lines.push('- If you believe a change is needed outside scope, emit `NIBBLER_EVENT {"type":"NEEDS_ESCALATION",...}`.');
  if (ctx.mission.scopeOverrides && ctx.mission.scopeOverrides.length > 0) {
    lines.push('');
    lines.push('### Scope overrides (granted by Architect)');
    for (const o of ctx.mission.scopeOverrides) {
      const pats = o.patterns.map((p) => `\`${p}\``).join(', ');
      lines.push(`- ${o.kind}: ${pats || '(none)'}`);
      if (o.notes) lines.push(`  - notes: ${o.notes}`);
    }
  }
  if (role.behavioralGuidance && role.behavioralGuidance.trim().length > 0) {
    lines.push('');
    lines.push('### Behavioral guidance');
    lines.push(role.behavioralGuidance.trimEnd());
  }
  lines.push('');

  lines.push('## Mission');
  if (ctx.mission.sessionMode) {
    lines.push(`- Session mode: \`${ctx.mission.sessionMode}\``);
  }
  lines.push(`- Current phase: \`${ctx.mission.phaseId}\``);
  if (phase) {
    lines.push(`- Phase actors: ${phase.actors.map((a) => `\`${a}\``).join(', ')}`);
    lines.push(`- Completion criteria: ${phase.completionCriteria.map((c) => `\`${c.type}\``).join(', ')}`);
  }

  if (ctx.mission.delegatedTasks && ctx.mission.delegatedTasks.length > 0) {
    lines.push('');
    lines.push('### Assigned tasks (delegation)');
    for (const t of ctx.mission.delegatedTasks) {
      const hints = t.scopeHints?.length ? ` (scopeHints: ${t.scopeHints.join(', ')})` : '';
      lines.push(`- [${t.taskId}] ${t.description}${hints}`);
    }
  }

  if (ctx.mission.implementationPlanRel && ctx.mission.sessionMode === 'implement') {
    lines.push('');
    lines.push('### Implementation plan');
    lines.push(`- Read and follow: ${formatPathRef(ctx.mission.implementationPlanRel)}`);
  }

  if (ctx.mission.handoffWriteRel || ctx.mission.handoffReadDirRel) {
    lines.push('');
    lines.push('### Handoff (recommended)');
    if (ctx.mission.handoffReadDirRel) {
      lines.push(`- Read previous handoffs: ${formatPathRef(ctx.mission.handoffReadDirRel)}`);
    }
    if (ctx.mission.handoffWriteRel) {
      lines.push(`- Write your handoff to: \`${ctx.mission.handoffWriteRel}\``);
    }
    lines.push('');
    lines.push('Template (recommended):');
    lines.push('```md');
    lines.push('## Summary');
    lines.push('- What you changed and why');
    lines.push('');
    lines.push('## How to verify');
    lines.push('- Commands run (and results) / manual steps');
    lines.push('');
    lines.push('## Risks / follow-ups');
    lines.push('- Known risks, TODOs, or areas to double-check');
    lines.push('```');
  }

  const hasFeedback = ctx.mission.feedback !== undefined;
  const hasHistory = Array.isArray(ctx.mission.feedbackHistory) && ctx.mission.feedbackHistory.length > 0;
  if (hasFeedback || hasHistory) {
    lines.push('');
    lines.push('### Feedback from engine');
    lines.push('');
    lines.push('**You MUST satisfy BOTH scope AND completion checks to proceed.**');

    const feedbackObj = ctx.mission.feedback && typeof ctx.mission.feedback === 'object' ? (ctx.mission.feedback as any) : null;
    const latestHint =
      (feedbackObj && typeof feedbackObj.engineHint === 'string' ? feedbackObj.engineHint : undefined) ??
      (hasHistory ? ctx.mission.feedbackHistory![ctx.mission.feedbackHistory!.length - 1]?.engineHint : undefined);
    if (latestHint && latestHint.trim().length > 0) {
      lines.push('');
      lines.push('**Engine hint:**');
      for (const l of latestHint.trimEnd().split('\n')) lines.push(l);
    }

    if (hasHistory) {
      const historyRows = ctx.mission.feedbackHistory!.slice(-MAX_HISTORY_ROWS);
      lines.push('');
      lines.push('| Attempt | Scope | Completion | Hint |');
      lines.push('|--------:|:------|:-----------|:-----|');

      for (const h of historyRows) {
        const scopeCell = h.scope.passed ? 'PASS' : `FAIL: ${h.scope.violationCount ?? 0} violation(s)`;
        const completionCell = h.completion.passed
          ? 'PASS'
          : `FAIL${h.completion.failedCriteria?.length ? `: ${h.completion.failedCriteria[0]}` : ''}`;
        const decisionCell = h.scopeDecision
          ? `Decision=${h.scopeDecision.decision}${h.scopeDecision.patterns?.length ? ` (${h.scopeDecision.patterns.join(', ')})` : ''}`
          : '';
        const hintCell = [h.engineHint, decisionCell].filter(Boolean).join(' ').replaceAll('\n', ' ');
        lines.push(`| ${h.attempt} | ${scopeCell} | ${completionCell} | ${escapeTableCell(hintCell)} |`);
      }
      if (ctx.mission.feedbackHistory!.length > historyRows.length) {
        lines.push('');
        lines.push(
          `Showing last ${historyRows.length} attempts (of ${ctx.mission.feedbackHistory!.length} total).`
        );
      }
    }

    if (hasFeedback) {
      lines.push('');
      lines.push('**Latest failure details:**');
      lines.push('_(truncated for readability)_');
      lines.push('```json');
      lines.push(JSON.stringify(compactForPrompt(ctx.mission.feedback), null, 2));
      lines.push('```');
    }
  }
  lines.push('');

  lines.push('## World');
  lines.push(`- Always read: ${ctx.world.alwaysRead.map((p) => formatPathRef(p)).join(', ')}`);
  lines.push(`- Phase inputs: ${ctx.world.phaseInputs.map((p) => `\`${p}\``).join(', ') || '(none)'}`);
  lines.push(`- Phase outputs: ${ctx.world.phaseOutputs.map((p) => `\`${p}\``).join(', ') || '(none)'}`);
  lines.push('');

  lines.push('## Event protocol');
  lines.push('When ALL your work is done, signal completion by outputting ONE of these events as **plain text in your response** (NOT inside any file):');
  lines.push('');
  lines.push('```text');
  lines.push('NIBBLER_EVENT {"type":"PHASE_COMPLETE","summary":"<short summary>"}');
  lines.push('NIBBLER_EVENT {"type":"NEEDS_ESCALATION","reason":"<what blocked you>","context":"<optional>"}');
  lines.push('NIBBLER_EVENT {"type":"EXCEPTION","reason":"<product decision needed>","impact":"<impact>"}');
  lines.push('```');
  lines.push('');
  lines.push('**CRITICAL**: The NIBBLER_EVENT line must appear ONLY in your text response. NEVER write it into any file (README.md, source code, etc.). It is a protocol signal, not file content.');
  lines.push('');

  return `${lines.join('\n')}\n`;
}

function escapeTableCell(value: string): string {
  // Keep Markdown tables stable: pipes break cells.
  return String(value ?? '').replaceAll('|', '\\|');
}

function formatPathRef(path: string): string {
  const p = String(path ?? '').trim();
  if (!p) return '``';
  // Cursor `@` references should only be used for concrete paths, not glob patterns/placeholders.
  if (/[?*\[\]{}<>]/.test(p)) return `\`${p}\``;
  if (p.startsWith('@')) return `\`${p}\``;
  return `\`@${p}\``;
}

const MAX_HISTORY_ROWS = 8;
const MAX_FEEDBACK_DEPTH = 4;
const MAX_FEEDBACK_ARRAY_ITEMS = 6;
const MAX_FEEDBACK_OBJECT_KEYS = 14;
const MAX_FEEDBACK_STRING_CHARS = 300;
const OMITTED_FEEDBACK_KEYS = new Set([
  'delegatedTasks',
  'gates',
  'context',
  'raw',
  'fullDiff',
  'diff'
]);

function compactForPrompt(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (typeof value === 'string') {
    if (value.length <= MAX_FEEDBACK_STRING_CHARS) return value;
    return `${value.slice(0, MAX_FEEDBACK_STRING_CHARS)}… (+${value.length - MAX_FEEDBACK_STRING_CHARS} chars)`;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;

  if (depth >= MAX_FEEDBACK_DEPTH) return '[truncated]';

  if (Array.isArray(value)) {
    const out = value.slice(0, MAX_FEEDBACK_ARRAY_ITEMS).map((item) => compactForPrompt(item, depth + 1));
    if (value.length > MAX_FEEDBACK_ARRAY_ITEMS) {
      out.push(`... (+${value.length - MAX_FEEDBACK_ARRAY_ITEMS} more items)`);
    }
    return out;
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    const out: Record<string, unknown> = {};
    const omittedKeys: string[] = [];
    for (const [k, v] of entries) {
      if (OMITTED_FEEDBACK_KEYS.has(k)) {
        omittedKeys.push(k);
        continue;
      }
      if (Object.keys(out).length >= MAX_FEEDBACK_OBJECT_KEYS) break;
      out[k] = compactForPrompt(v, depth + 1);
    }
    const hiddenByKeyLimit = Math.max(0, entries.length - omittedKeys.length - Object.keys(out).length);
    if (hiddenByKeyLimit > 0) {
      out.__truncatedKeys = `+${hiddenByKeyLimit} more keys`;
    }
    if (omittedKeys.length > 0) {
      out.__omittedKeys = omittedKeys.join(', ');
    }
    return out;
  }

  return String(value);
}
