import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * extract-aerotech-certified.py reads a letter by WORD COORDINATES, and tells a
 * figure's SI cell from its imperial one by UNIT, never by its place in the row.
 * CLAUDE.md, "NEVER READ A TABLE FROM FLATTENED TEXT": in flattened text an empty
 * cell is simply not there and the next column slides into its place, which is
 * how five of Loki's commercial throat figures came out wrong and the L930's and
 * M1882's nozzles swapped.
 * Checked here on synthetic letters laid out as TMT's are — the label at 72 pt,
 * the imperial figure at 288, the SI figure at 432 — with a cell left empty.
 *
 * The run also reads the thirteen scanned letters from the script's own
 * transcriptions, so the synthetic folder carries a blank page at each of their
 * paths: a scan has no text, and one that has text must be read instead.
 *
 * RUNS ONLY WHERE THE EXTRACTOR CAN, Python with PyMuPDF, as
 * extract-nozzle-pdfs.test.mjs does; CI has neither.
 */
const here = dirname(fileURLToPath(import.meta.url));
const extractor = join(here, 'extract-aerotech-certified.py');
const python = process.env.PYTHON ?? 'python';
const pythonProbe = spawnSync(python, ['-c', 'import pymupdf'], { encoding: 'utf8' });
const hasPyMuPDF = pythonProbe.status === 0;
// A stub `python` (the Windows Store alias, an unconfigured pyenv shim) starts and exits non-zero: probe that it RUNS.
const hasPython = hasPyMuPDF || spawnSync(python, ['-c', 'pass'], { stdio: 'ignore' }).status === 0;

it.skipIf(!hasPython)('resolves Python references in env/profile/docs order, rejecting foreign profiles and files', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'python-references-'));
  try {
    const repo = join(scratch, 'repo'), envRoot = join(scratch, 'env'), profileRoot = join(scratch, 'profile');
    const profilePath = join(scratch, 'machine.json');
    const docs = join(repo, 'docs');
    for (const root of [envRoot, profileRoot, docs]) mkdirSync(join(root, 'RCS Schematics'), { recursive: true });
    writeFileSync(profilePath, JSON.stringify({ hostname: hostname().toUpperCase(),
      repos: { online_open_rocket: { referenceDocs: profileRoot } } }));
    const driver = `import json, os, sys\nsys.path.insert(0, sys.argv[1])\nimport reference_docs\nif 'REFERENCE_TEST_HOSTNAME' in os.environ: reference_docs.socket.gethostname = lambda: os.environ['REFERENCE_TEST_HOSTNAME']\nprint(json.dumps(reference_docs.reference_dir('RCS Schematics', sys.argv[2])))`;
    const env = { ...process.env, MMRSIM_REFERENCE_ROOT: envRoot, MACHINE_PROFILE: profilePath, PYTHONDONTWRITEBYTECODE: '1' };
    const resolve = () => {
      const run = spawnSync(python, ['-c', driver, here, repo], { encoding: 'utf8', env, cwd: docs });
      expect(run.status, run.stderr).toBe(0);
      return JSON.parse(run.stdout);
    };
    expect(resolve()).toBe(join(envRoot, 'RCS Schematics'));
    rmSync(join(envRoot, 'RCS Schematics'), { recursive: true });
    writeFileSync(join(envRoot, 'RCS Schematics'), 'not a directory');
    expect(resolve()).toBe(join(profileRoot, 'RCS Schematics'));
    writeFileSync(profilePath, JSON.stringify({ hostname: 'foreign', repos: { online_open_rocket: { referenceDocs: profileRoot } } }));
    expect(resolve()).toBe(join(docs, 'RCS Schematics'));
    writeFileSync(profilePath, '{');
    expect(resolve()).toBe(join(docs, 'RCS Schematics'));
    for (const referenceDocs of ['', 42, join(scratch, 'missing')]) {
      writeFileSync(profilePath, JSON.stringify({ hostname: hostname(), repos: { online_open_rocket: { referenceDocs } } }));
      expect(resolve()).toBe(join(docs, 'RCS Schematics'));
    }
    // Even an empty host returned by the OS must not validate a missing/empty hostname.
    env.REFERENCE_TEST_HOSTNAME = '';
    for (const host of [undefined, '', 42]) {
      writeFileSync(profilePath, JSON.stringify({ hostname: host, repos: { online_open_rocket: { referenceDocs: profileRoot } } }));
      expect(resolve()).toBe(join(docs, 'RCS Schematics'));
    }
    delete env.REFERENCE_TEST_HOSTNAME;
    rmSync(join(docs, 'RCS Schematics'), { recursive: true });
    expect(resolve()).toBeNull();
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

it.skipIf(!hasPython)('resolves both extractor defaults at main time and ignores empty legacy overrides', () => {
  // No PDFs or PyMuPDF needed: stop at read_all after argparse chooses the source.
  const driver = `import importlib.util, os, sys, types
sys.path.insert(0, sys.argv[1])
sys.modules['pymupdf'] = types.SimpleNamespace(set_messages=lambda **kwargs: None)
for name in ['extract-aerotech-certified', 'extract-aerotech-delays']:
    spec = importlib.util.spec_from_file_location(name, os.path.join(sys.argv[1], name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    chosen = []
    class Stop(Exception): pass
    def read_all(source, *args):
        chosen.append(source)
        raise Stop()
    module.read_all = read_all
    for legacy, flags, expected in [('', [], 'resolved-late'), ('legacy', [], 'legacy'), ('legacy', ['--source', 'flag'], 'flag')]:
        os.environ['RCS_SCHEMATICS'] = legacy
        module.reference_dir = lambda *args: 'resolved-late'
        try: module.main(flags)
        except Stop: pass
        assert chosen[-1] == expected, (name, chosen, expected)
print('both extractor defaults resolved at main time')`;
  const run = spawnSync(python, ['-c', driver, here], { encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  expect(run.status, run.stderr).toBe(0);
  expect(run.stdout).toContain('both extractor defaults resolved at main time');
});

/** One PDF per spec entry: a list of visual lines, each a list of [x, text]; null is a page with no text at all. */
const MAKE_PDFS = `
import json, os, sys, pymupdf
for path, lines in json.load(open(sys.argv[1], encoding='utf-8')).items():
    os.makedirs(os.path.dirname(path), exist_ok=True)
    doc = pymupdf.open()
    page = doc.new_page()
    y = 72
    for line in lines or []:
        for x, text in line:
            page.insert_text((x, y), text, fontname='helv', fontsize=10)
        y += 15
    doc.save(path)
`;

/** The scanned letters' paths, read out of the script so the two cannot part. */
const transcribed = [...readFileSync(extractor, 'utf8').matchAll(/^ {4}'([^']+\.pdf)': \{$/gm)].map((m) => m[1]);

/** A 2019-on letter, as its rows; `edit` replaces or drops a labelled row. */
function letter(edit = {}) {
  const rows = {
    "Manufacturer's Designation": [[288, 'X99T-P'], [366, '[single use]']],
    Propellant: [[288, 'Blue Thunder']],
    'TMT Nomenclature': [[288, '100 X99']],
    Diameter: [[288, '1.125"'], [432, '28.58 mm']],
    'Overall Length': [[288, '4.4"'], [432, '111.76 mm']],
    'Loaded Mass': [[288, '0.18 lb'], [432, '81.4 g']],
    'Propellant Mass': [[288, '0.066 lb*'], [432, '30.0 g*']],
    'Burnout Mass': [[288, '0.10 lb'], [432, '45.8 g']],
    'Burn time': [[288, '1.0 ± 0.05 sec']],
    // The imperial cell is EMPTY: only the SI figure is printed.
    'Total Impulse': [[432, '100.0 ± 1.0 N.s']],
    'Max Impulse': [[288, '33.72 ± 1.0 lbf'], [432, '150.0 ± 4.4 N']],
    'Average Impulse': [[288, '22.48 ± 0.5 lbf'], [432, '99.0 ± 2.2 N']],
    'Number of Motors Tested': [[288, '3']],
    ...edit,
  };
  return [
    [[324, 'Tripoli Motor Testing Division']],
    [[72, 'May 10, 2021']],
    [[108, 'The Aerotech X99T single-use motor was tested on May 8, 2021 and complies']],
    ...Object.entries(rows).filter(([, cells]) => cells).map(([label, cells]) => [[72, label], ...cells]),
    [[72, 'Alan C. Whitmore']],
    [[72, 'Chair, Tripoli Motor Testing']],
  ];
}

let dir;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

/** A Cert Docs folder holding `letters` (folder/name.pdf -> lines) and a blank page at every transcribed path. */
function run(letters, changedScan = false) {
  dir = mkdtempSync(join(tmpdir(), 'tmt-letters-'));
  const tra = join(dir, 'Cert Docs', 'TRA');
  const spec = Object.fromEntries([
    ...transcribed.map((p) => [join(tra, p), null]),
    ...Object.entries(letters).map(([p, lines]) => [join(tra, p), lines]),
  ]);
  writeFileSync(join(dir, 'spec.json'), JSON.stringify(spec));
  const made = spawnSync(python, ['-c', MAKE_PDFS, join(dir, 'spec.json')], { encoding: 'utf8' });
  expect(made.status, made.stderr).toBe(0);
  const entries = Object.keys(spec).map((abs, i) => {
    const rel = abs.slice(tra.length + 1).replace(/\\/g, '/');
    const folder = rel.slice(0, rel.lastIndexOf('/'));
    return `    @{ Case = 'TRA\\${folder}'; Name = '${rel.slice(folder.length + 1, -4)}'; Url = 'https://example.invalid/${i}.pdf' }`;
  });
  writeFileSync(join(dir, 'Cert Docs', 'Download-CertDocs.ps1'), `$Drawings = @(\n${entries.join('\n')}\n)\n`);
  const out = join(dir, 'out.json');
  // Synthetic scans stand in for reviewed bytes. Keep the production hash manifest immutable.
  const driver = `import importlib.util, hashlib, os, sys\nsys.path.insert(0, os.path.dirname(sys.argv[1]))\nspec = importlib.util.spec_from_file_location('certified', sys.argv[1])\nm = importlib.util.module_from_spec(spec)\nspec.loader.exec_module(m)\nroot = os.path.join(sys.argv[2], 'Cert Docs', 'TRA')\nm.TRANSCRIBED_HASHES = {p: hashlib.sha256(open(os.path.join(root, p), 'rb').read()).hexdigest() for p in m.TRANSCRIBED}\nif sys.argv[4] == 'changed':\n    p = os.path.join(root, next(iter(m.TRANSCRIBED)))\n    with open(p, 'ab') as f: f.write(b'\\n% revised scan bytes\\n')\nsys.argv = [sys.argv[1], '--source', sys.argv[2], '--out', sys.argv[3]]\nsys.exit(m.main(sys.argv[1:]))\n`;
  const res = spawnSync(python, ['-c', driver, extractor, dir, out, changedScan ? 'changed' : 'same'], { encoding: 'utf8' });
  return { ...res, json: existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : null };
}

// Each case spawns Python twice (build the PDFs, then extract); under a full-suite
// load that has run past Vitest's 5 s default on the desktop (2026-10-10, twice).
describe.skipIf(!hasPyMuPDF)('extract-aerotech-certified.py reads a letter by position and unit', { timeout: 30_000 }, () => {
  it('refuses changed image-only bytes at a transcribed path', () => {
    const { status, stdout, stderr, json } = run({}, true);
    expect(status).not.toBe(0);
    expect(stdout + stderr).toContain('source hash changed');
    expect(json).toBeNull();
  });
  it('reads the SI figure from its own column when the imperial cell beside it is empty', () => {
    const { status, stderr, json } = run({ 'Test/X99T.pdf': letter() });
    expect(status, stderr).toBe(0);
    const x = json.rows.find((r) => r.file === 'Test/X99T.pdf');
    expect(x).toMatchObject({
      read: 'text', designation: 'X99T-P', hardware: '[single use]', letterDate: 'May 10, 2021', testedOn: 'May 8, 2021',
      signedBy: 'Alan C. Whitmore', totImpulseNs: 100, maxThrustN: 150, avgThrustN: 99, burnTimeS: 1, length: 111.76,
      plusMinus: { totImpulseNs: 1, maxThrustN: 4.4, avgThrustN: 2.2, burnTimeS: 0.05 },
    });
    expect(x.imperial).toEqual({ maxThrustLbf: 33.72, avgThrustLbf: 22.48 });
    expect(json.letters).toBe(transcribed.length + 1);
    expect(json.readFromImage).toBe(transcribed.length);
  });

  it('refuses a row whose SI cell is empty, rather than taking the imperial figure beside it', () => {
    const { status, stdout, stderr, json } = run({
      'Test/X99T.pdf': letter({ 'Max Impulse': [[288, '33.72 ± 1.0 lbf']] }),
    });
    expect(status).not.toBe(0);
    expect(stdout + stderr).toMatch(/Test\/X99T\.pdf: "Max Impulse" has no SI cell/);
    expect(json).toBeNull();
  });

  it('refuses a figure in neither unit, and a letter missing a row, rather than dropping it', () => {
    const wrongUnit = run({ 'Test/X99T.pdf': letter({ 'Average Impulse': [[432, '99.0 kg']] }) });
    expect(wrongUnit.status).not.toBe(0);
    expect(wrongUnit.stdout + wrongUnit.stderr).toMatch(/"Average Impulse" cell '99\.0 kg' is neither SI/);
    const missing = run({ 'Test/X99T.pdf': letter({ 'Max Impulse': null }) });
    expect(missing.status).not.toBe(0);
    expect(missing.stdout + missing.stderr).toMatch(/Test\/X99T\.pdf: no "Max Impulse" row/);
  });

  it('passes over the older forms, which have no "Manufacturer\'s Designation" row', () => {
    const older = letter({ "Manufacturer's Designation": null });
    const { status, stderr, json } = run({ 'Test/X99T.pdf': older });
    expect(status, stderr).toBe(0);
    expect(json.rows.some((r) => r.file === 'Test/X99T.pdf')).toBe(false);
  });

  it('refuses a transcription for a letter that now has a text layer: it must be read', () => {
    const [scan] = transcribed;
    const { status, stdout, stderr } = run({ [scan]: letter() });
    expect(status).not.toBe(0);
    expect(stdout + stderr).toContain(`${scan} now has a text layer`);
  });
});
