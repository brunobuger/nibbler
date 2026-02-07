import { join, resolve } from 'node:path';

import type { DiscoverySchema, IngestedContext, ProjectType } from './types.js';
import { ingestMaterials } from './ingestion.js';
import { classifyProjectType } from './classification.js';
import { answerQuestion, generateSchema, getNextBatch, isDiscoveryComplete, preFillSchema } from './schema.js';
import { writeJson } from '../utils/fs.js';
import { promptInput, promptSelect } from '../cli/ui/prompts.js';

export interface DiscoveryRunOptions {
  workspace: string;
  providedFiles: string[];
  planDir: string;
}

export interface DiscoveryResult {
  context: IngestedContext;
  projectType: ProjectType;
  schema: DiscoverySchema;
}

export async function runDiscovery(opts: DiscoveryRunOptions): Promise<DiscoveryResult> {
  const workspace = resolve(opts.workspace);
  const planDir = resolve(opts.planDir);
  const providedFiles = opts.providedFiles.map((p) => resolve(p));

  const context = await ingestMaterials(providedFiles, workspace);
  const guessed = classifyProjectType(context);
  const projectType = guessed ?? (await askProjectType());

  const schema = preFillSchema(generateSchema(projectType), context);

  let rounds = 0;
  while (!isDiscoveryComplete(schema)) {
    rounds += 1;
    if (rounds > 50) break; // hard-stop safety

    const batch = getNextBatch(schema, { max: 3 });
    if (batch.length === 0) break;

    for (const q of batch) {
      const message =
        q.status === 'inferred' && q.inferredAnswer
          ? `${q.ask}\n(Inferred: ${q.inferredAnswer})`
          : q.ask;

      const ans =
        process.env.NIBBLER_TEST_AUTO_APPROVE === '1' || process.env.NIBBLER_TEST_DISCOVERY_AUTO === '1'
          ? 'test'
          : await promptInput({ message });
      answerQuestion(schema, q.id, ans.trim());
    }
  }

  const outPath = join(planDir, 'discovery.json');
  await writeJson(outPath, {
    version: 1,
    projectType,
    repoState: context.repoState,
    providedFiles: context.provided.map((f) => f.path),
    schema
  });

  return { context, projectType, schema };
}

async function askProjectType(): Promise<ProjectType> {
  if (process.env.NIBBLER_TEST_AUTO_APPROVE === '1' || process.env.NIBBLER_TEST_DISCOVERY_AUTO === '1') return 'web-app';
  return await promptSelect<ProjectType>({
    message: 'Project type (discovery)',
    choices: [
      { name: 'Web application', value: 'web-app' },
      { name: 'API / service', value: 'api-service' },
      { name: 'CLI tool', value: 'cli-tool' },
      { name: 'Mobile app', value: 'mobile-app' },
      { name: 'Library / package', value: 'library' },
      { name: 'Data pipeline', value: 'data-pipeline' }
    ]
  });
}

