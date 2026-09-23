import { defineConfig } from 'vitest/config';

// Both settings keep the suite what it was under vitest 2 (AUDIT row 528,
// vitest 2 -> 5); packages/app/vite.config.ts carries the same two.
export default defineConfig({
  test: {
    // Vitest 4 cut its default exclude to node_modules and .git. `tsc -p`
    // compiles src/*.test.ts into dist/ beside the package's entry, so without
    // dist/ here every engine test ran twice — 20 files and 224 tests where
    // there are 10 and 112. This is vitest 2's own list.
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/cypress/**',
      '**/.{idea,git,cache,output,temp}/**',
      '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*',
    ],
    // Vitest 5 picks its 'minimal' reporter when it detects an AI agent, and
    // that one swallows what a passing test prints. Vitest 2's choice, which
    // is also what CI still gets: 'default', plus 'github-actions' there.
    reporters: process.env['GITHUB_ACTIONS'] === 'true' ? ['default', 'github-actions'] : ['default'],
  },
});
