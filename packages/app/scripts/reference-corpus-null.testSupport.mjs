import { vi } from 'vitest';

// Model missing static references while living docs/testing remains available.
// The external RockSim corpus is independently optional.
vi.mock('../../../scripts/reference-docs.mjs', () => ({
  referenceDir: () => null, referenceFile: () => null,
}));
vi.mock('../src/services/rocksimCorpusPath.testSupport.mjs', () => ({ rocksimCorpusPath: () => null }));
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal(),
  // Model available Python so only the missing reference skips PDF corpora.
  // Collection never executes test bodies or launches the extractor.
  spawnSync: () => ({ status: 0, stdout: '', stderr: '' }),
}));
