import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
const hasPyMuPDF = spawnSync(python, ['-c', 'import pymupdf'], { stdio: 'ignore' }).status === 0;

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
function run(letters) {
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
  const res = spawnSync(python, [extractor, '--source', dir, '--out', out], { encoding: 'utf8' });
  return { ...res, json: existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : null };
}

describe.skipIf(!hasPyMuPDF)('extract-aerotech-certified.py reads a letter by position and unit', () => {
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
