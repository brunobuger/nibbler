import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    cli: 'src/cli/index.ts'
  },
  outDir: 'dist',
  format: ['esm'],
  target: 'es2022',
  platform: 'node',
  sourcemap: true,
  clean: true,
  dts: true,
  splitting: false,
  treeshake: true,
  banner: {
    js: '#!/usr/bin/env node'
  }
});

