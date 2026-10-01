import { defineConfig } from 'vitest/config';

// Both settings keep the suite what it was under vitest 2 (AUDIT row 528,
// vitest 2 -> 5); packages/app/vite.config.ts carries the same two.
export default defineConfig({
  test: {
    // Vitest 4 cut its default exclude to node_modules and .git. This is
    // vitest 2's own list, and its dist/ still guards one case. The build
    // compiled src/*.test.ts into dist/ beside the entry, so every engine test
    // ran twice without it; since the 2026-09-30 audit's Step 8 it leaves them
    // out and empties dist/ first (tsconfig.json says how). A dist/ built
    // before that keeps the compiled copies, and the orphan of any test since
    // deleted, until its next engine build: every existing checkout has one,
    // and a build of an older commit makes one. Measured on one: 37 files
    // collected without this line, 18 with it.
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
