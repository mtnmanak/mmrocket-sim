import { vi } from 'vitest';

// Collection exercises the real reference resolver with synthetic directories.
// Treat Python as available without executing probes or test bodies.
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal(),
  spawnSync: () => ({ status: 0, stdout: '', stderr: '' }),
}));
