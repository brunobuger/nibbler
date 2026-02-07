import type { IngestedContext } from './types.js';

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

/**
 * Best-effort trait detection from docs + repository signals.
 * Traits are intentionally coarse: they drive team composition and scope boundaries, not architecture decisions.
 */
export function detectTraits(ctx: IngestedContext): string[] {
  const traits = new Set<string>();
  const blob = textBlob(ctx);
  const top = new Set(ctx.signals.topLevelEntries.map((s) => s.toLowerCase()));

  // Auth
  if (
    hasDep(ctx, 'next-auth') ||
    hasDep(ctx, '@auth0/auth0-react') ||
    hasDep(ctx, '@auth0/nextjs-auth0') ||
    hasDep(ctx, 'passport') ||
    hasDep(ctx, 'passport-jwt') ||
    hasDep(ctx, 'jsonwebtoken') ||
    hasDep(ctx, 'bcrypt') ||
    hasDep(ctx, 'bcryptjs') ||
    blob.includes('authentication') ||
    blob.includes('login') ||
    blob.includes('signup') ||
    blob.includes('sso') ||
    blob.includes('oauth')
  ) {
    traits.add('auth');
  }

  // Realtime
  if (
    hasDep(ctx, 'socket.io') ||
    hasDep(ctx, 'ws') ||
    hasDep(ctx, '@supabase/realtime-js') ||
    blob.includes('websocket') ||
    blob.includes('realtime') ||
    blob.includes('real-time')
  ) {
    traits.add('realtime');
  }

  // Database / persistence
  if (
    hasDep(ctx, 'prisma') ||
    hasDep(ctx, 'mongoose') ||
    hasDep(ctx, 'sequelize') ||
    hasDep(ctx, 'typeorm') ||
    hasDep(ctx, 'pg') ||
    hasDep(ctx, 'mysql2') ||
    hasDep(ctx, 'better-sqlite3') ||
    blob.includes('database') ||
    blob.includes('postgres') ||
    blob.includes('mysql') ||
    blob.includes('sqlite')
  ) {
    traits.add('database');
  }

  // Queue / background jobs
  if (hasDep(ctx, 'bull') || hasDep(ctx, 'bullmq') || hasDep(ctx, 'amqplib') || blob.includes('queue') || blob.includes('background job')) {
    traits.add('queue');
  }

  // Containerization
  if (top.has('dockerfile') || top.has('docker-compose.yml') || top.has('docker-compose.yaml') || blob.includes('docker')) {
    traits.add('containerized');
  }

  // Monorepo
  const workspaces = ctx.signals.packageJson && (ctx.signals.packageJson as any).workspaces;
  if (top.has('pnpm-workspace.yaml') || top.has('lerna.json') || (Array.isArray(workspaces) && workspaces.length > 0)) {
    traits.add('monorepo');
  }

  // i18n
  if (hasDep(ctx, 'i18next') || hasDep(ctx, 'react-i18next') || blob.includes('i18n') || blob.includes('localization') || blob.includes('translation')) {
    traits.add('i18n');
  }

  // Payments
  if (hasDep(ctx, 'stripe') || blob.includes('payments') || blob.includes('billing') || blob.includes('stripe')) {
    traits.add('payments');
  }

  // File storage
  if (hasDep(ctx, '@aws-sdk/client-s3') || hasDep(ctx, 'aws-sdk') || blob.includes('s3') || blob.includes('file upload') || blob.includes('object storage')) {
    traits.add('file-storage');
  }

  // Search
  if (hasDep(ctx, '@elastic/elasticsearch') || blob.includes('elasticsearch') || blob.includes('search') || blob.includes('full-text')) {
    traits.add('search');
  }

  // ML
  if (blob.includes('machine learning') || blob.includes('ml ') || blob.includes('model training') || blob.includes('inference')) {
    traits.add('ml');
  }

  return Array.from(traits).sort((a, b) => a.localeCompare(b));
}

