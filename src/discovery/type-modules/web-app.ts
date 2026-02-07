import type { Question } from '../types.js';

export function webAppQuestions(): Question[] {
  return [
    { id: 'web_auth_model', ask: 'Authentication model (public, invite-only, SSO, etc.)?', status: 'gap' },
    { id: 'web_multitenancy', ask: 'Is this multi-tenant? If yes, what is the tenant model?', status: 'gap' },
    { id: 'web_responsive', ask: 'Responsive requirements (mobile/tablet/desktop)?', status: 'gap' },
    { id: 'web_realtime', ask: 'Any real-time/collaboration needs?', status: 'gap' },
    { id: 'web_seo', ask: 'SEO requirements (public pages, indexable content)?', status: 'gap' }
  ];
}

