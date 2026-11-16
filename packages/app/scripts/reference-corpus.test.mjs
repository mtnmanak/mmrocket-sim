import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

// Match every optional static-corpus group, without executing synthetic tests
// again. Collection executes the real file-level discovery and skip guards.
const manifest = {
  app: {
    'src/App.simulate.test.tsx': 'FC-[45] LEM|K[1-4]:|LW real LEM|CFG-2 LEM',
    'src/components/NoticeBar.groups.test.tsx': 'LEM-1-2026_2.ork',
    'src/services/asymmetricThrust.tester.test.ts': '.',
    'src/services/batchDisclosure.corpus.test.ts': '.',
    'src/tree/motorRoom.tester.test.ts': '.',
    'src/tree/solidContext.tester.test.ts': '.',
    'src/services/importApply.repick.test.ts': 'the owner’s designs',
    'src/services/importNotes.test.ts': 'LEM-1-2026_2.ork:',
    'src/services/lemivSweep.test.ts': '.',
    'src/services/rocksimFile.lossNotes.test.ts': 'same parts and built mass',
    'src/services/rocksimFile.test.ts': 'his own Wildman file|corpus airfoil caution',
    'src/services/rocksimLaunchSite.test.ts': 'the corpus:',
    'src/services/statedLaunchWeight.test.ts': 'against the author’s own|PePe2:',
    'src/services/xmlParse.corpus.test.ts': 'the local corpus:',
    'src/services/motorClosureCompatibility.test.ts': 'admits user motor files',
    'scripts/cdFromFlight.test.mjs': 'Adamson F10, 2023|Adamson G12, 2024|the refusals, proven',
    'scripts/aerotech-certified.test.mjs': 'reads from the letters today',
    'scripts/extract-aerotech-delays.test.mjs': 'src/data/aerotechDelays.json',
  },
  api: {
    'src/incompleteFlight.test.ts': 'reports the real time-capped tester flight',
    'src/index.test.ts': 'marks a time-capped descent incomplete',
    'src/xmlBudget.test.ts': 'accepts the largest measured real',
  },
};

it('collects every static corpus test as skipped when referenceDir returns null', () => {
  const driver = fileURLToPath(new URL('./reference-corpus-collect.testSupport.mjs', import.meta.url));
  const env = { ...process.env, ROCKSIM_DESIGNS: '', LEMIV: '1' };
  delete env.RCS_SCHEMATICS;
  const child = spawnSync(process.execPath, [driver, JSON.stringify(manifest)], { encoding: 'utf8', timeout: 120_000,
    env, maxBuffer: 4 * 1024 * 1024 });
  expect(child.error, child.stderr).toBeUndefined();
  expect(child.status, child.stdout + child.stderr).toBe(0);
  const line = child.stdout.split('\n').find(line => line.startsWith('MMRSIM_MISSING_CORPORA='));
  expect(line, child.stdout).toBeDefined();
  const modules = JSON.parse(line.slice('MMRSIM_MISSING_CORPORA='.length));
  for (const [packageName, cases] of Object.entries(manifest)) {
    for (const [file, pattern] of Object.entries(cases)) {
      const module = modules.find(module => module.packageName === packageName && module.file === file);
      expect(module, `${packageName}/${file} collected`).toBeDefined();
      const corpus = module.tests.filter(test => new RegExp(pattern).test(test.name));
      expect(corpus.length, `${packageName}/${file} corpus cases`).toBeGreaterThan(0);
      for (const test of corpus) expect(test.mode, `${packageName}/${file}: ${test.name}`).toBe('skip');
    }
  }
}, 150_000);

it('enables both RCS corpora through the resolver when the legacy override is empty', () => {
  const root = mkdtempSync(join(tmpdir(), 'rcs-corpus-'));
  try {
    mkdirSync(join(root, 'RCS Schematics', 'Cert Docs', 'TRA'), { recursive: true });
    const rcsManifest = { app: Object.fromEntries(Object.entries(manifest.app).filter(([file]) =>
      ['scripts/aerotech-certified.test.mjs', 'scripts/extract-aerotech-delays.test.mjs'].includes(file))) };
    const driver = fileURLToPath(new URL('./reference-corpus-collect.testSupport.mjs', import.meta.url));
    const child = spawnSync(process.execPath, [driver, JSON.stringify(rcsManifest), 'reference-corpus-available.testSupport.mjs'], {
      encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, RCS_SCHEMATICS: '', MMRSIM_REFERENCE_ROOT: root, MACHINE_PROFILE: join(root, 'absent.json') },
    });
    expect(child.error, child.stderr).toBeUndefined();
    expect(child.status, child.stdout + child.stderr).toBe(0);
    const line = child.stdout.split('\n').find(line => line.startsWith('MMRSIM_MISSING_CORPORA='));
    expect(line, child.stdout).toBeDefined();
    const modules = JSON.parse(line.slice('MMRSIM_MISSING_CORPORA='.length));
    for (const [file, pattern] of Object.entries(rcsManifest.app)) {
      const module = modules.find(module => module.file === file);
      expect(module, file).toBeDefined();
      const corpus = module.tests.filter(test => new RegExp(pattern).test(test.name));
      expect(corpus.length, file).toBeGreaterThan(0);
      for (const test of corpus) expect(test.mode, test.name).not.toBe('skip');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 150_000);
