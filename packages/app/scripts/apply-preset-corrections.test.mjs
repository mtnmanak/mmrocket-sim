import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const shipped = JSON.parse(readFileSync(join(here, '../src/data/presets.json'), 'utf8'));
const isReducer = (p) => p.kind === 'Transition' && p.manufacturer === 'SEMROC' && p.partNo === 'TA-5055L [R]';
const serialize = (db) => JSON.stringify(db, null, 1) + '\n';

describe('SEMROC TA-5055L [R] mass correction CLI', () => {
  let dir, path, script, db;
  beforeEach(() => {
    dir = mkdtempSync(join(here, '.preset-corrections-'));
    mkdirSync(join(dir, 'scripts'));
    mkdirSync(join(dir, 'src/data'), { recursive: true });
    for (const file of ['apply-preset-corrections.mjs', 'manufacturers.mjs']) {
      copyFileSync(join(here, file), join(dir, 'scripts', file));
    }
    script = join(dir, 'scripts/apply-preset-corrections.mjs');
    path = join(dir, 'src/data/presets.json');
    db = structuredClone(shipped);
    expect(db.presets.filter(isReducer)).toHaveLength(1);
    db.presets.find(isReducer).mass = 0.020128161401;
  });
  afterEach(() => {
    if (dir && dirname(dir) === here) rmSync(dir, { recursive: true, force: true });
  });
  const run = () => spawnSync(process.execPath, [script], { encoding: 'utf8' });

  it('removes only the known bad mass and is byte-stable on a second run', () => {
    writeFileSync(path, serialize(db));
    const first = run();
    expect(first.status, first.stdout + first.stderr).toBe(0);
    delete db.presets.find(isReducer).mass;
    expect(readFileSync(path, 'utf8')).toBe(serialize(db));
    const retiredPath = join(dir, 'src/data/retiredPresetMasses.json');
    const retired = readFileSync(retiredPath, 'utf8');
    expect(JSON.parse(retired)).toEqual({ 'Transition|semroc|ta5055lr': [0.020128161401] });
    // The committed browser input must stay in sync with the correction table.
    expect(readFileSync(join(here, '../src/data/retiredPresetMasses.json'), 'utf8')).toBe(retired);
    const second = run();
    expect(second.status, second.stdout + second.stderr).toBe(0);
    expect(second.stdout).toContain('0 field(s) applied');
    expect(readFileSync(path, 'utf8')).toBe(serialize(db));
    expect(readFileSync(retiredPath, 'utf8')).toBe(retired);
  });

  it('generates retired masses for replacement corrections and for already corrected data', () => {
    // Exercise the actual CLI with a replacement correction, not only removal.
    writeFileSync(script, readFileSync(script, 'utf8').replace(
      'mass: { bad: 0.020128161401, good: undefined }',
      'mass: { bad: 0.020128161401, good: 0.004 }',
    ));
    db.presets.find(isReducer).mass = 0.004;
    writeFileSync(path, serialize(db));
    const result = run();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, 'src/data/retiredPresetMasses.json'), 'utf8')))
      .toEqual({ 'Transition|semroc|ta5055lr': [0.020128161401] });
    expect(readFileSync(path, 'utf8')).toBe(serialize(db));
  });

  it.each(['unexpected mass', 'missing row', 'duplicate key'])('refuses %s without writing', (surprise) => {
    const row = db.presets.find(isReducer);
    if (surprise === 'unexpected mass') row.mass = 0.01;
    if (surprise === 'missing row') db.presets = db.presets.filter((p) => !isReducer(p));
    if (surprise === 'duplicate key') db.presets.push({ ...row });
    const raw = serialize(db);
    writeFileSync(path, raw);
    const result = run();
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain('Transition|semroc|ta5055lr');
    expect(readFileSync(path, 'utf8')).toBe(raw);
    expect(existsSync(join(dir, 'src/data/retiredPresetMasses.json'))).toBe(false);
  });
});
