import type { Confidence, IngestedContext, ProjectType } from './types.js';

function hasDep(ctx: IngestedContext, name: string): boolean {
  const deps = ctx.signals.packageJson?.dependencies ?? {};
  const dev = ctx.signals.packageJson?.devDependencies ?? {};
  return Object.prototype.hasOwnProperty.call(deps, name) || Object.prototype.hasOwnProperty.call(dev, name);
}

function textBlob(ctx: IngestedContext): string {
  const fromProvided = ctx.provided.map((f) => f.content).join('\n');
  const fromExisting = [ctx.existingVision?.content, ctx.existingArchitecture?.content].filter(Boolean).join('\n');
  return `${fromProvided}\n${fromExisting}`.toLowerCase();
}

export function classifyProjectType(context: IngestedContext): ProjectType | null {
  return classifyProjectTypeDetailed(context).projectType;
}

export interface ProjectTypeClassification {
  projectType: ProjectType | null;
  confidence: Confidence;
  reasons: string[];
}

export function classifyProjectTypeDetailed(context: IngestedContext): ProjectTypeClassification {
  const blob = textBlob(context);
  const top = new Set(context.signals.topLevelEntries.map((s) => s.toLowerCase()));

  // Strong signals from package.json deps
  if (hasDep(context, 'react') || hasDep(context, 'next') || hasDep(context, 'vue') || hasDep(context, 'svelte')) {
    return { projectType: 'web-app', confidence: 'high', reasons: ['dependency:web-framework'] };
  }
  if (hasDep(context, 'express') || hasDep(context, 'fastify') || hasDep(context, '@nestjs/core') || hasDep(context, 'koa')) {
    return { projectType: 'api-service', confidence: 'high', reasons: ['dependency:api-framework'] };
  }
  if (hasDep(context, 'commander') || hasDep(context, 'yargs') || hasDep(context, 'oclif')) {
    return { projectType: 'cli-tool', confidence: 'high', reasons: ['dependency:cli-framework'] };
  }

  // File structure heuristics
  if (top.has('android') || top.has('ios')) return { projectType: 'mobile-app', confidence: 'medium', reasons: ['fs:android_ios_dirs'] };
  if (top.has('bin') && context.signals.packageJson?.bin) return { projectType: 'cli-tool', confidence: 'medium', reasons: ['fs:bin_plus_package_bin'] };

  // Keyword scoring from docs — score each type and pick the highest.
  // This prevents generic words like "api" (present in nearly all web-app docs) from
  // overriding stronger web-app signals like "react" or "web application".
  const scored: Array<{ type: ProjectType; score: number; reasons: string[] }> = [];

  function score(type: ProjectType, keywords: string[], weight: number, reason: string): void {
    const hits = keywords.filter((kw) => blob.includes(kw));
    if (hits.length > 0) {
      const existing = scored.find((s) => s.type === type);
      const points = hits.length * weight;
      if (existing) {
        existing.score += points;
        if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
      } else {
        scored.push({ type, score: points, reasons: [reason] });
      }
    }
  }

  // Web-app: strong signals from frameworks/UI mentioned in docs
  score('web-app', ['react', 'next.js', 'nextjs', 'vue', 'svelte', 'angular', 'nuxt', 'remix', 'tailwind', 'css'], 3, 'docs:web-framework');
  score('web-app', ['web application', 'web app', 'webapp', 'frontend', 'dashboard', 'saas', 'landing page', 'ui component', 'responsive'], 2, 'docs:web_keywords');
  score('web-app', ['browser', 'html'], 1, 'docs:browser_keywords');

  // API service
  score('api-service', ['rest api', 'graphql', 'grpc', 'openapi', 'swagger'], 3, 'docs:api_strong');
  score('api-service', ['api service', 'microservice', 'endpoint', 'api gateway'], 2, 'docs:api_keywords');
  // "api" alone is weak — almost every web app mentions it
  score('api-service', ['api'], 0.5, 'docs:api_generic');

  // CLI tool
  score('cli-tool', ['command-line', 'command line', 'cli tool', 'terminal'], 3, 'docs:cli_strong');
  score('cli-tool', ['flags', 'argv', 'subcommand'], 2, 'docs:cli_keywords');

  // Mobile
  score('mobile-app', ['ios app', 'android app', 'react native', 'flutter', 'swift', 'kotlin'], 3, 'docs:mobile_strong');
  score('mobile-app', ['mobile app', 'mobile application'], 2, 'docs:mobile_keywords');

  // Library
  score('library', ['sdk', 'library', 'npm package', 'publishable'], 2, 'docs:library_keywords');

  // Data pipeline
  score('data-pipeline', ['etl', 'pipeline', 'data warehouse', 'batch job', 'data processing'], 2, 'docs:pipeline_keywords');

  if (scored.length > 0) {
    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];
    const confidence: Confidence = best.score >= 6 ? 'medium' : 'low';
    return { projectType: best.type, confidence, reasons: best.reasons };
  }

  // If we have code but no good signal, prefer asking.
  return { projectType: null, confidence: 'low', reasons: ['insufficient_signals'] };
}


