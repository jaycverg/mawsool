import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  target: 'node24',
  platform: 'node',
  clean: true,
  // Workspace packages export TypeScript source, so they are bundled in.
  noExternal: [/^@mawsool\//],
});
