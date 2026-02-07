import type { Question } from '../types.js';

export function dataPipelineQuestions(): Question[] {
  return [
    { id: 'pipe_sources', ask: 'Data sources?', status: 'gap' },
    { id: 'pipe_sinks', ask: 'Data sinks/consumers?', status: 'gap' },
    { id: 'pipe_volume', ask: 'Volume/velocity expectations?', status: 'gap' },
    { id: 'pipe_schedule', ask: 'Scheduling (batch interval / triggers)?', status: 'gap' },
    { id: 'pipe_idempotency', ask: 'Idempotency & backfill requirements?', status: 'gap' },
    { id: 'pipe_monitoring', ask: 'Monitoring/alerting requirements?', status: 'gap' }
  ];
}

