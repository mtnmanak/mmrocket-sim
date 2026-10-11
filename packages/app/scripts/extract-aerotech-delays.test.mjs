import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * extract-aerotech-delays.py reads each test motor's measured ejection delay by
 * WORD COORDINATES: in a NAR report's motor table, the word standing under the
 * table's own Delay heading, never the n-th cell of the row. CLAUDE.md, "NEVER
 * READ A TABLE FROM FLATTENED TEXT": real reports leave the delay cell empty
 * ("FIX CURVE", "NO DATA", a blank), and in flattened text the next column (the
 * motor's initial mass) slides into its place.
 * Checked here on synthetic reports laid out as NAR's are, and against the
 * document's own second print (its averages, and its per-motor summary), which
 * a value read from the wrong column cannot pass.
 *
 * RUNS ONLY WHERE THE EXTRACTOR CAN, Python with PyMuPDF, as
 * extract-aerotech-certified.test.mjs does; CI has neither. The last case also
 * needs the local-only docs/RCS Schematics, and proves the committed
 * src/data/aerotechDelays.json is what those documents give.
 */
const here = dirname(fileURLToPath(import.meta.url));
const extractor = join(here, 'extract-aerotech-delays.py');
const python = process.env.PYTHON ?? 'python';
const hasPyMuPDF = spawnSync(python, ['-c', 'import pymupdf'], { stdio: 'ignore' }).status === 0;
const realDocs = join(here, '..', '..', '..', 'docs', 'RCS Schematics', 'Cert Docs');

/** One PDF per spec entry: a list of visual lines, each a list of [x, text]. */
const MAKE_PDFS = `
import json, os, sys, pymupdf
for path, lines in json.load(open(sys.argv[1], encoding='utf-8')).items():
    os.makedirs(os.path.dirname(path), exist_ok=True)
    doc = pymupdf.open()
    page = doc.new_page()
    y = 72
    for line in lines:
        for x, text in line:
            page.insert_text((x, y), text, fontname='helv', fontsize=10)
        y += 15
    doc.save(path)
`;

/** A NAR report for an "E99W" sold at 4 and 7 s: its averages, then its motor table. `edit` replaces lines by name. */
function report(edit = {}) {
  const parts = {
    averages: [
      [[72, 'Delay Time(sec.)'], [200, '4'], [250, '7']],
      [[72, 'Delay(sec.)'], [200, '4.50'], [250, '7.00']],
    ],
    header: [[[72, 'Data File'], [140, 'Engine'], [200, 'Total'], [260, 'Burn'], [320, 'Delay'], [380, 'Initial']]],
    motors: [
      [[72, '0001W01'], [140, 'E99-4W'], [200, '35.0'], [260, '1.50'], [320, '4.40'], [380, '48.0']],
      [[72, '0001W02'], [140, 'E99-4W'], [200, '35.1'], [260, '1.52'], [320, '4.60'], [380, '48.2']],
      [[72, '0001W03'], [140, 'E99-7W'], [200, '35.2'], [260, '1.49'], [320, '6.90'], [380, '48.5']],
      // Nothing under the Delay heading: in flattened text 48.6, the motor's
      // initial mass, is the fifth number after the designation.
      [[72, '0001W04'], [140, 'E99-7W'], [200, '35.0'], [260, '1.51'], [380, '48.6']],
      [[72, '0001W05'], [140, 'E99-7W'], [200, '34.9'], [260, '1.50'], [320, '7.10'], [380, '48.4']],
    ],
    end: [[[72, 'Average'], [200, '35.04']]],
    summary: [
      [[72, 'Range'], [140, 'Indicated'], [200, 'Actual'], [240, 'Actual'], [280, 'Average']],
      [[72, '4'], [100, '2.5 to 5.5'], [200, '4.40'], [240, '4.60'], [280, '4.50']],
      [[72, '7'], [100, '5.5 to 8.5'], [200, '6.90'], [240, '7.10'], [280, '7.00']],
    ],
    ...edit,
  };
  return Object.values(parts).flat();
}

let dir;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

/** A Cert Docs folder holding `docs` (NAR/... paths -> lines), a one-motor catalogue, and a JOIN naming every doc. */
function run(docs) {
  dir = mkdtempSync(join(tmpdir(), 'delay-docs-'));
  const certDocs = join(dir, 'Cert Docs');
  const spec = Object.fromEntries(Object.entries(docs).map(([p, lines]) => [join(certDocs, p), lines]));
  writeFileSync(join(dir, 'spec.json'), JSON.stringify(spec));
  const made = spawnSync(python, ['-c', MAKE_PDFS, join(dir, 'spec.json')], { encoding: 'utf8' });
  expect(made.status, made.stderr).toBe(0);
  const entries = Object.keys(docs).map((rel, i) => {
    const folder = rel.slice(0, rel.lastIndexOf('/')).replace(/\//g, '\\');
    return `    @{ Case = '${folder}'; Name = '${rel.slice(rel.lastIndexOf('/') + 1, -4)}'; Url = 'https://example.invalid/${i}.pdf' }`;
  });
  writeFileSync(join(certDocs, 'Download-CertDocs.ps1'), `$Docs = @(\n${entries.join('\n')}\n)\n`);
  writeFileSync(join(dir, 'motors.json'), JSON.stringify({
    generated: '2026-10-11',
    motors: [{ motorId: 'id-e99w', manufacturerAbbrev: 'AeroTech', designation: 'E99W' }],
  }));
  writeFileSync(join(dir, 'join.json'), JSON.stringify(Object.fromEntries(Object.keys(docs).map((p) => [p, ['AeroTech', 'E99W']]))));
  const out = join(dir, 'out.json');
  const res = spawnSync(python, [extractor, '--source', dir, '--motors', join(dir, 'motors.json'),
    '--join', join(dir, 'join.json'), '--out', out], { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  return { ...res, json: existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : null };
}

// Each case spawns Python twice (build the PDFs, then extract); under a full-suite
// load that has run past Vitest's 5 s default (extract-aerotech-certified.test.mjs).
describe.skipIf(!hasPyMuPDF)('extract-aerotech-delays.py reads each motor\'s delay by position', { timeout: 30_000 }, () => {
  it('reads the delay under the Delay heading, and leaves a motor with none out rather than taking its mass', () => {
    const { status, stderr, json } = run({ 'NAR/Test/E99W.pdf': report() });
    expect(status, stderr).toBe(0);
    expect(json.motors['id-e99w']).toMatchObject({
      designation: 'E99W', manufacturer: 'AeroTech', document: 'NAR/Test/E99W.pdf', form: 'nar',
      url: 'https://example.invalid/0.pdf',
      delays: [{ nominalS: 4, measuredS: [4.4, 4.6] }, { nominalS: 7, measuredS: [6.9, 7.1] }],
    });
    expect(json).toMatchObject({ motorCount: 1, pairCount: 2, documents: { nar: 1 } });
  });

  it('stops when a value does not average to what the document prints, rather than shipping it', () => {
    const { status, stdout, stderr, json } = run({
      'NAR/Test/E99W.pdf': report({ averages: [
        [[72, 'Delay Time(sec.)'], [200, '4'], [250, '7']],
        [[72, 'Delay(sec.)'], [200, '4.50'], [250, '7.40']],
      ] }),
    });
    expect(status).not.toBe(0);
    expect(stdout + stderr).toMatch(/NAR\/Test\/E99W\.pdf: AVERAGE_DISAGREES lists \[\], the document gives \[7\]/);
    expect(json).toBeNull();
  });

  it('stops when the summary prints different delays from the motor table for the same setting', () => {
    const { status, stdout, stderr } = run({
      'NAR/Test/E99W.pdf': report({ summary: [
        [[72, 'Range'], [140, 'Indicated'], [200, 'Actual'], [240, 'Actual'], [280, 'Average']],
        [[72, '4'], [100, '2.5 to 5.5'], [200, '4.40'], [240, '4.60'], [280, '4.50']],
        [[72, '7'], [100, '5.5 to 8.5'], [200, '6.40'], [240, '7.60'], [280, '7.00']],
      ] }),
    });
    expect(status).not.toBe(0);
    expect(stdout + stderr).toMatch(/DISPUTED lists \[\], the document gives \[7\]/);
  });

  it('reads a TMT letter\'s "Delay Time Data" lines, and counts them against the motors tested', () => {
    const letter = [
      [[72, 'Number of Motors Tested'], [288, '6']],
      [[216, 'Nominal'], [360, 'Measured']],
      [[72, 'Delay Time Data'], [216, '5 s'], [324, '4.946, 4.507, 5.158 s']],
      [[216, '8 s'], [324, '7.239, 6.558 7.341 s']],
      [[72, 'Casing Temp.'], [360, 'Passed']],
    ];
    const ok = run({ 'TRA/Test/E99W.pdf': letter });
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.json.motors['id-e99w'].delays).toEqual([
      { nominalS: 5, measuredS: [4.946, 4.507, 5.158] },
      { nominalS: 8, measuredS: [7.239, 6.558, 7.341] },
    ]);
    const tooMany = run({ 'TRA/Test/E99W.pdf': letter.map((l) => (l[0][1] === 'Number of Motors Tested' ? [l[0], [288, '5']] : l)) });
    expect(tooMany.status).not.toBe(0);
    expect(tooMany.stdout + tooMany.stderr).toMatch(/6 delays read, 5 motors tested/);
  });
});

describe.skipIf(!hasPyMuPDF || !existsSync(realDocs))('src/data/aerotechDelays.json', { timeout: 30_000 }, () => {
  it('is what the certification documents give', () => {
    const res = spawnSync(python, [extractor, '--check'], { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    expect(res.status, res.stdout + res.stderr).toBe(0);
  });
});
