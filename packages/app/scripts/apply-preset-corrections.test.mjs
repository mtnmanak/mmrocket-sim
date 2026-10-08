import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { presetKey } from './manufacturers.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const shipped = JSON.parse(readFileSync(join(here, '../src/data/presets.json'), 'utf8'));
const retiredMasses = {
  'Transition|semroc|ta5055lr': [0.020128161401],
  'BodyTube|quest|10311': [0.001417476155],
  'EngineBlock|quest|14005': [0.000283495231],
  'Transition|semroc|bc1050r': [0.030900980179],
  'NoseCone|fliskits|ncb201o': [0.000283495231],
  'NoseCone|fliskits|ncb25p': [0.000283495231],
  'EngineBlock|quest|14101': [0.00001],
  'BodyTube|quest|10315': [0.000283495231],
  'BodyTube|fliskits|bt50529': [0.0005953399851],
  'NoseCone|semroc|bnc3a': [0.000283495231],
  'BodyTube|quest|9527': [0.001417476155],
  'NoseCone|rocketarium|bt80knosecone825long': [0.076],
  'NoseCone|rocketarium|bt70nosecone75long': [0.059],
  'NoseCone|aerotech|11261': [0.0680389],
};
const replacementMasses = {
  'NoseCone|rocketarium|bt80knosecone825long': 0.072,
  'NoseCone|rocketarium|bt70nosecone75long': 0.062,
  'NoseCone|aerotech|11261': 0.106,
};
const serialize = (db) => JSON.stringify(db, null, 1) + '\n';

describe.each(Object.entries(retiredMasses))('%s mass correction CLI', (key, [bad]) => {
  const good = replacementMasses[key];
  const isTarget = (p) => presetKey(p) === key;
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
    expect(db.presets.filter(isTarget)).toHaveLength(1);
    db.presets.find(isTarget).mass = bad;
  });
  afterEach(() => {
    if (dir && dirname(dir) === here) rmSync(dir, { recursive: true, force: true });
  });
  const run = () => spawnSync(process.execPath, [script], { encoding: 'utf8' });

  it('corrects only the known bad mass and is byte-stable on a second run', () => {
    writeFileSync(path, serialize(db));
    const first = run();
    expect(first.status, first.stdout + first.stderr).toBe(0);
    if (good === undefined) delete db.presets.find(isTarget).mass;
    else db.presets.find(isTarget).mass = good;
    expect(readFileSync(path, 'utf8')).toBe(serialize(db));
    const retiredPath = join(dir, 'src/data/retiredPresetMasses.json');
    const retired = readFileSync(retiredPath, 'utf8');
    expect(JSON.parse(retired)).toEqual(retiredMasses);
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
    // Scope the replacement to this entry: three parts share the 0.01 oz value.
    const source = readFileSync(script, 'utf8');
    const start = source.indexOf(`key: '${key}',`);
    writeFileSync(script, source.slice(0, start) + source.slice(start).replace(
      `mass: { bad: ${bad}, good: ${good} }`,
      `mass: { bad: ${bad}, good: 0.004 }`,
    ));
    db.presets.find(isTarget).mass = 0.004;
    writeFileSync(path, serialize(db));
    const result = run();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, 'src/data/retiredPresetMasses.json'), 'utf8')))
      .toEqual(retiredMasses);
    expect(readFileSync(path, 'utf8')).toBe(serialize(db));
  });

  it.each(['unexpected mass', 'missing row', 'duplicate key'])('refuses %s without writing', (surprise) => {
    const row = db.presets.find(isTarget);
    if (surprise === 'unexpected mass') row.mass = 0.01;
    if (surprise === 'missing row') db.presets = db.presets.filter((p) => !isTarget(p));
    if (surprise === 'duplicate key') db.presets.push({ ...row });
    const raw = serialize(db);
    writeFileSync(path, raw);
    const result = run();
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain(key);
    expect(readFileSync(path, 'utf8')).toBe(raw);
    expect(existsSync(join(dir, 'src/data/retiredPresetMasses.json'))).toBe(false);
  });
});
