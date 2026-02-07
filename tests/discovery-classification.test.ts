import { describe, expect, it } from 'vitest';

import { classifyProjectType } from '../src/discovery/classification.js';
import type { IngestedContext } from '../src/discovery/types.js';

function ctx(overrides: Partial<IngestedContext>): IngestedContext {
  return {
    provided: [],
    repoState: 'docs_only',
    signals: {
      hasPackageJson: false,
      hasReadme: false,
      topLevelEntries: [],
      srcEntries: []
    },
    ...overrides
  };
}

describe('discovery classification', () => {
  it('detects cli-tool from commander dependency', () => {
    const c = ctx({
      signals: {
        hasPackageJson: true,
        packageJson: { dependencies: { commander: '^1.0.0' } },
        hasReadme: false,
        topLevelEntries: [],
        srcEntries: []
      }
    });
    expect(classifyProjectType(c)).toBe('cli-tool');
  });

  it('returns null when ambiguous', () => {
    const c = ctx({
      signals: {
        hasPackageJson: true,
        packageJson: { dependencies: {} },
        hasReadme: true,
        topLevelEntries: ['docs'],
        srcEntries: []
      }
    });
    expect(classifyProjectType(c)).toBe(null);
  });
});

