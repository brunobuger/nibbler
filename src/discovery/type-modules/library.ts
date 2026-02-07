import type { Question } from '../types.js';

export function libraryQuestions(): Question[] {
  return [
    { id: 'lib_runtime', ask: 'Target runtime/language versions to support?', status: 'gap' },
    { id: 'lib_api_surface', ask: 'Public API surface (main entrypoints, key abstractions)?', status: 'gap' },
    { id: 'lib_versioning', ask: 'Versioning/backwards compatibility expectations?', status: 'gap' },
    { id: 'lib_docs', ask: 'Documentation expectations (README, examples, API docs)?', status: 'gap' }
  ];
}

