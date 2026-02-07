import type { Question } from '../types.js';

export function cliToolQuestions(): Question[] {
  return [
    { id: 'cli_commands', ask: 'What are the top-level commands/subcommands?', status: 'gap' },
    { id: 'cli_io_model', ask: 'I/O model (stdin/stdout, files, interactive prompts)?', status: 'gap' },
    { id: 'cli_distribution', ask: 'Distribution method (npm, brew, binary releases, docker)?', status: 'gap' },
    { id: 'cli_config', ask: 'Configuration model (flags, config file, env vars)?', status: 'gap' },
    { id: 'cli_completion', ask: 'Shell completion required (bash/zsh/fish)?', status: 'gap' }
  ];
}

