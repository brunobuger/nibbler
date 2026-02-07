import type { Question } from '../types.js';

export function apiServiceQuestions(): Question[] {
  return [
    { id: 'api_consumers', ask: 'Who are the API consumers (internal teams, external devs, partners)?', status: 'gap' },
    { id: 'api_style', ask: 'API style (REST, GraphQL, gRPC, events/webhooks)?', status: 'gap' },
    { id: 'api_rate_limits', ask: 'Rate limiting / quotas needed?', status: 'gap' },
    { id: 'api_versioning', ask: 'Versioning strategy (URL, headers, semver releases)?', status: 'gap' },
    { id: 'api_sdk', ask: 'Do you need an SDK? If so, which languages?', status: 'gap' }
  ];
}

