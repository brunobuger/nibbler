export type RepoState = 'empty' | 'docs_only' | 'has_code';

export type ProjectType =
  | 'web-app'
  | 'api-service'
  | 'cli-tool'
  | 'mobile-app'
  | 'library'
  | 'data-pipeline';

export type Confidence = 'low' | 'medium' | 'high';

export interface IngestedFile {
  path: string;
  content: string;
}

export interface CodebaseSignals {
  hasPackageJson: boolean;
  packageJson?: {
    name?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    bin?: Record<string, string> | string;
  };
  hasReadme: boolean;
  topLevelEntries: string[];
  srcEntries: string[];
}

export interface IngestedContext {
  provided: IngestedFile[];
  existingVision?: IngestedFile;
  existingArchitecture?: IngestedFile;
  repoState: RepoState;
  signals: CodebaseSignals;
}

