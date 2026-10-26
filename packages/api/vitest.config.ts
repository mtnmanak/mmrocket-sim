import { defineConfig } from 'vitest/config';
import { assertWorkspaceLinks } from '../../scripts/check-workspace-links.mjs';

assertWorkspaceLinks();

export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.test.ts'], maxWorkers: 1,
    testTimeout: 120_000, hookTimeout: 120_000 },
});
