import { describe, expect, it } from 'vitest';

import { detectTraits } from '../src/discovery/traits.js';
import type { IngestedContext } from '../src/discovery/types.js';

function ctx(partial: Partial<IngestedContext>): IngestedContext {
  return {
    provided: [],
    repoState: 'has_code',
    signals: {
      hasPackageJson: true,
      packageJson: { dependencies: {}, devDependencies: {}, name: 'x' },
      hasReadme: false,
      topLevelEntries: [],
      srcEntries: []
    },
    ...partial
  };
}

describe('detectTraits', () => {
  it('detects auth/database/realtime/containerized from deps and fs signals', () => {
    const c = ctx({
      signals: {
        hasPackageJson: true,
        packageJson: {
          dependencies: { jsonwebtoken: '^9.0.0', prisma: '^5.0.0', 'socket.io': '^4.0.0' },
          devDependencies: {},
          name: 'x'
        },
        hasReadme: false,
        topLevelEntries: ['Dockerfile'],
        srcEntries: []
      }
    });

    const traits = detectTraits(c);
    expect(traits).toContain('auth');
    expect(traits).toContain('database');
    expect(traits).toContain('realtime');
    expect(traits).toContain('containerized');
  });
});

