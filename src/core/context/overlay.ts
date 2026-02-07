import type { CompiledContext } from './types.js';

export function renderOverlay(ctx: CompiledContext): string {
  const role = ctx.identity.role;
  const phase = ctx.mission.phase;

  const lines: string[] = [];
  lines.push(`# Role: ${role.id}`);
  lines.push('');
  lines.push('## Identity');
  lines.push(`- Scope: ${role.scope.map((s) => `\`${s}\``).join(', ')}`);
  if (ctx.identity.sharedScope.length > 0) {
    lines.push(`- Shared scope: ${ctx.identity.sharedScope.map((s) => `\`${s}\``).join(', ')}`);
  }
  lines.push(`- Allowed commands: ${role.authority.allowedCommands.map((c) => `\`${c}\``).join(', ') || '(none)'}`);
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
    lines.push(`- Read and follow: \`${ctx.mission.implementationPlanRel}\``);
  }

  if (ctx.mission.feedback !== undefined) {
    lines.push('');
    lines.push('### Feedback from engine');
    lines.push('```json');
    lines.push(JSON.stringify(ctx.mission.feedback, null, 2));
    lines.push('```');
  }
  lines.push('');

  lines.push('## World');
  lines.push(`- Always read: ${ctx.world.alwaysRead.map((p) => `\`${p}\``).join(', ')}`);
  lines.push(`- Phase inputs: ${ctx.world.phaseInputs.map((p) => `\`${p}\``).join(', ') || '(none)'}`);
  lines.push(`- Phase outputs: ${ctx.world.phaseOutputs.map((p) => `\`${p}\``).join(', ') || '(none)'}`);
  lines.push('');

  lines.push('## Event protocol');
  lines.push('When you are done, emit ONE of the following single-line events exactly:');
  lines.push('');
  lines.push('```text');
  lines.push('NIBBLER_EVENT {"type":"PHASE_COMPLETE","summary":"<short summary>"}');
  lines.push('NIBBLER_EVENT {"type":"NEEDS_ESCALATION","reason":"<what blocked you>","context":"<optional>"}');
  lines.push('NIBBLER_EVENT {"type":"EXCEPTION","reason":"<product decision needed>","impact":"<impact>"}');
  lines.push('```');
  lines.push('');

  return `${lines.join('\n')}\n`;
}

