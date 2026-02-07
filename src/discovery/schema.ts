import type { DiscoverySchema, IngestedContext, ProjectType, Question, QuestionSection } from './types.js';
import { apiServiceQuestions } from './type-modules/api-service.js';
import { cliToolQuestions } from './type-modules/cli-tool.js';
import { dataPipelineQuestions } from './type-modules/data-pipeline.js';
import { libraryQuestions } from './type-modules/library.js';
import { mobileAppQuestions } from './type-modules/mobile-app.js';
import { webAppQuestions } from './type-modules/web-app.js';

function q(id: string, ask: string): Question {
  return { id, ask, status: 'gap' };
}

function section(id: string, label: string, questions: Question[]): QuestionSection {
  return { id, label, questions };
}

export function generateSchema(projectType: ProjectType): DiscoverySchema {
  const tier1: QuestionSection[] = [
    section('problem_context', 'Problem & Context', [
      q('t1_problem', 'What problem are we solving? For whom?'),
      q('t1_workaround', "What’s the current workaround (how do people handle this today)?"),
      q('t1_why_now', 'Why now — what triggered building this?')
    ]),
    section('solution_concept', 'Solution Concept', [
      q('t1_one_sentence', "What’s the product in one sentence?"),
      q('t1_core_loop', 'What’s the core interaction loop — the one thing users do repeatedly?')
    ]),
    section('personas_access', 'Personas & Access', [
      q('t1_personas', 'Who are the distinct user types (personas)?'),
      q('t1_hierarchy', 'Is there a hierarchy between user types (admin/manager/user), or flat?'),
      q('t1_auth', 'Authentication model — open, invite-only, SSO, public/private areas?')
    ]),
    section('core_workflows', 'Core Workflows (MVP)', [
      q('t1_workflows', 'What are the 3–5 core workflows for v1? (trigger → steps → outcome)'),
      q('t1_most_important', 'Which single workflow is the most important?')
    ]),
    section('scope_boundaries', 'Scope Boundaries', [
      q('t1_not_in_v1', "What’s explicitly NOT in v1?"),
      q('t1_constraints', 'Any hard constraints (budget, timeline, regulatory, etc.)?')
    ])
  ];

  const tier2: QuestionSection[] = [
    section('nfrs', 'Non-Functional Requirements', [
      q('t2_perf', 'Performance expectations?'),
      q('t2_availability', 'Availability needs?'),
      q('t2_security', 'Security & compliance requirements?'),
      q('t2_offline', 'Offline/connectivity requirements?')
    ]),
    section('constraints_integrations', 'Technical Constraints & Integrations', [
      q('t2_stack', 'Required/preferred tech stack (or “pick best”)?'),
      q('t2_integrations', 'Integrations with existing systems?'),
      q('t2_deploy', 'Deployment target/constraints (cloud, on-prem, etc.)?')
    ]),
    section('data_model', 'Data Model (conceptual)', [
      q('t2_entities', 'What are the core entities (“things”) in the system?'),
      q('t2_relationships', 'Key relationships between them?')
    ])
  ];

  const tier3: QuestionSection[] = [
    section('journeys', 'User Journeys', [
      q('t3_first_time', 'First-time user experience (signup → first value)?'),
      q('t3_daily_driver', 'Daily driver path (returning user flow)?'),
      q('t3_edge_cases', 'Known edge cases?')
    ]),
    section('success_metrics', 'Success Metrics', [
      q('t3_metrics', 'How will you know this is working (success metrics)?'),
      q('t3_success_3m', 'What would make v1 a success in 3 months?')
    ]),
    section('roadmap', 'Roadmap Awareness', [
      q('t3_roadmap', 'What’s coming in v2/v3 we should design for now?'),
      q('t3_scaling', 'Known scaling inflection points?')
    ])
  ];

  // Type-specific adjustments: append questions into Tier 1/2 depending on type.
  const extra = typeSpecific(projectType);
  // Keep v1 simple: place extras into Tier 1 as a dedicated section if they are blocking-ish,
  // otherwise into Tier 2. For now, keep a single Tier 1 section for visibility.
  if (extra.length) {
    tier1.push(section('type_specific', `Type-specific (${projectType})`, extra));
  }

  return { projectType, tiers: { tier1, tier2, tier3 } };
}

export function preFillSchema(schema: DiscoverySchema, context: IngestedContext): DiscoverySchema {
  // v1: lightweight keyword-based inference from provided + existing docs.
  const blob = [
    ...context.provided.map((f) => f.content),
    context.existingVision?.content,
    context.existingArchitecture?.content
  ]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();

  const infer = (questionId: string, answer: string, confidence: 'low' | 'medium' | 'high' = 'low') => {
    const q = findQuestion(schema, questionId);
    if (!q) return;
    if (q.status !== 'gap') return;
    q.status = 'inferred';
    q.inferredAnswer = answer;
    q.confidence = confidence;
  };

  if (blob.includes('sso')) infer('t1_auth', 'SSO (mentioned in docs)', 'medium');
  if (blob.includes('hipaa')) infer('t2_security', 'HIPAA compliance likely required (mentioned in docs)', 'high');
  if (blob.includes('gdpr')) infer('t2_security', 'GDPR compliance likely required (mentioned in docs)', 'high');
  if (blob.includes('kubernetes')) infer('t2_deploy', 'Kubernetes (mentioned in docs)', 'medium');
  if (blob.includes('react')) infer('t2_stack', 'React (mentioned in docs)', 'high');

  return schema;
}

export function getNextBatch(schema: DiscoverySchema, opts: { max?: number } = {}): Question[] {
  const max = opts.max ?? 3;
  const ordered = [...allQuestions(schema.tiers.tier1), ...allQuestions(schema.tiers.tier2), ...allQuestions(schema.tiers.tier3)];

  const candidates = ordered.filter((q) => q.status === 'gap' || q.status === 'inferred');
  return candidates.slice(0, Math.max(1, Math.min(max, 3)));
}

export function isDiscoveryComplete(schema: DiscoverySchema): boolean {
  const tier1 = allQuestions(schema.tiers.tier1);
  const tier2 = allQuestions(schema.tiers.tier2);

  const tier1Ok = tier1.every((q) => q.status === 'answered' || q.status === 'confirmed');
  if (!tier1Ok) return false;

  // Tier2 “sufficient” heuristic for v1: allow up to 2 gaps remaining.
  const tier2Gaps = tier2.filter((q) => q.status === 'gap').length;
  return tier2Gaps <= 2;
}

export function answerQuestion(schema: DiscoverySchema, questionId: string, answer: string): boolean {
  const q = findQuestion(schema, questionId);
  if (!q) return false;
  q.answer = answer;
  q.status = 'answered';
  return true;
}

function allQuestions(sections: QuestionSection[]): Question[] {
  return sections.flatMap((s) => s.questions);
}

function findQuestion(schema: DiscoverySchema, id: string): Question | null {
  for (const tier of [schema.tiers.tier1, schema.tiers.tier2, schema.tiers.tier3]) {
    for (const sec of tier) {
      const q = sec.questions.find((qq) => qq.id === id);
      if (q) return q;
    }
  }
  return null;
}

function typeSpecific(projectType: ProjectType): Question[] {
  switch (projectType) {
    case 'web-app':
      return webAppQuestions();
    case 'api-service':
      return apiServiceQuestions();
    case 'cli-tool':
      return cliToolQuestions();
    case 'mobile-app':
      return mobileAppQuestions();
    case 'library':
      return libraryQuestions();
    case 'data-pipeline':
      return dataPipelineQuestions();
    default: {
      const _exhaustive: never = projectType;
      return _exhaustive;
    }
  }
}

