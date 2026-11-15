import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
    scan = isinstance(lines, dict)
    if scan: lines = lines['scan']
    doc = pymupdf.open()
    page = doc.new_page()
    y = 72
    for line in lines:
        for x, text in line:
            page.insert_text((x, y), text, fontname='helv', fontsize=10)
        y += 15
    if scan:
        image = page.get_pixmap().tobytes('png')
        doc.close()
        doc = pymupdf.open()
        page = doc.new_page()
        page.insert_image(page.rect, stream=image)
    with open(path, 'wb') as fh: fh.write(doc.tobytes())
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

/** A Cert Docs folder holding `docs`, a one-motor catalogue, and a JOIN naming text-layer docs. */
function run(docs, transcriptions = { documents: [], unread: [] }, averageDisputed = [], hardwareType = 'SU') {
  dir = mkdtempSync(join(tmpdir(), 'delay-docs-'));
  const certDocs = join(dir, 'Cert Docs');
  const spec = Object.fromEntries(Object.entries(docs).map(([p, lines]) => [join(certDocs, p), lines]));
  writeFileSync(join(dir, 'spec.json'), JSON.stringify(spec));
  const made = spawnSync(python, ['-c', MAKE_PDFS, join(dir, 'spec.json')], { encoding: 'utf8' });
  expect(made.status, made.stderr).toBe(0);
  for (const entry of [...transcriptions.documents, ...transcriptions.unread]) {
    entry.sha256 ??= createHash('sha256').update(readFileSync(join(certDocs, entry.document))).digest('hex');
  }
  writeFileSync(join(dir, 'transcriptions.json'), JSON.stringify(transcriptions));
  const entries = Object.keys(docs).map((rel, i) => {
    const folder = rel.slice(0, rel.lastIndexOf('/')).replace(/\//g, '\\');
    return `    @{ Case = '${folder}'; Name = '${rel.slice(rel.lastIndexOf('/') + 1, -4)}'; Url = 'https://example.invalid/${i}.pdf' }`;
  });
  writeFileSync(join(certDocs, 'Download-CertDocs.ps1'), `$Docs = @(\n${entries.join('\n')}\n)\n`);
  writeFileSync(join(dir, 'motors.json'), JSON.stringify({
    generated: '2026-10-11',
    motors: [{ motorId: 'id-e99w', manufacturerAbbrev: 'AeroTech', designation: 'E99W', type: hardwareType }],
  }));
  writeFileSync(join(dir, 'join.json'), JSON.stringify(Object.fromEntries(Object.entries(docs)
    .filter(([_path, lines]) => !lines.scan).map(([p]) => [p, ['AeroTech', 'E99W']]))));
  const out = join(dir, 'out.json');
  const averageJoin = Object.fromEntries(transcriptions.unread.filter(e => e.printedAverages)
    .map(e => [e.document, ['AeroTech', 'E99W']]));
  writeFileSync(join(dir, 'average-join.json'), JSON.stringify(averageJoin));
  // Test-only injection keeps the production dispute table hand-reviewed.
  const bootstrap = `import sys, importlib.util, json
sys.path.insert(0, ${JSON.stringify(here)})
spec = importlib.util.spec_from_file_location('delays', ${JSON.stringify(extractor)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
m.AVERAGE_DISPUTED = {tuple(e[:2]): set(e[2]) for e in json.loads(sys.argv.pop(1))}
sys.exit(m.main(sys.argv[1:]))`;
  const res = spawnSync(python, ['-c', bootstrap, JSON.stringify(averageDisputed), '--source', dir, '--motors', join(dir, 'motors.json'),
    '--join', join(dir, 'join.json'), '--average-join', join(dir, 'average-join.json'),
    '--transcriptions', join(dir, 'transcriptions.json'), '--out', out],
    // Synthetic sources replace both hand-join tables.
  { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  return { ...res, json: existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : null };
}

function averageTranscription(document = scanPath, printed = '4.34') {
  return { document, category: 'average-only', reason: 'Average only, no individual measurements or spread.',
    printedAverages: [{ nominalS: 4, printed, label: 'Avg. Measured Delay',
      position: { page: 1, row: 'Avg. Measured Delay', column: 1 } }] };
}

describe.skipIf(!hasPyMuPDF)('printed scan averages', { timeout: 30_000 }, () => {
  it('ships a printed average separately, never as a measured sample', () => {
    const result = run({ [scanPath]: { scan: report() } }, { documents: [], unread: [averageTranscription()] });
    expect(result.status, result.stderr).toBe(0);
    expect(result.json.motors).toEqual({});
    expect(result.json).toMatchObject({ averageMotorCount: 1, averagePairCount: 1, scanReview: { averagesRead: 1 } });
    expect(result.json.averages['id-e99w']).toMatchObject({ form: 'scan-average', documents: [scanPath],
      delays: [{ nominalS: 4, averageS: 4.34 }] });
    expect(JSON.stringify(result.json.averages)).not.toContain('measuredS');
  });

  it.each([
    ['average outside half the nominal', e => { e.printedAverages[0].printed = '6.00'; }, /outside half the nominal/],
    ['average at the lower half-nominal bound', e => { e.printedAverages[0].printed = '2.00'; }, /outside half the nominal/],
    ['missing source position', e => { delete e.printedAverages[0].position; }, /source position/],
    ['out-of-range source page', e => { e.printedAverages[0].position.page = 2; }, /source position/],
    ['invalid source column', e => { e.printedAverages[0].position.column = -1; }, /source position/],
    ['fractional source column', e => { e.printedAverages[0].position.column = 1.5; }, /source position/],
    ['string source column', e => { e.printedAverages[0].position.column = '1'; }, /source position/],
    ['boolean source column', e => { e.printedAverages[0].position.column = true; }, /source position/],
    ['non-integer nominal', e => { e.printedAverages[0].nominalS = 4.1; }, /average nominal/],
    ['boolean nominal', e => { e.printedAverages[0].nominalS = true; }, /average nominal/],
    ['string nominal', e => { e.printedAverages[0].nominalS = '4'; }, /average nominal/],
    ['duplicate nominal', e => { e.printedAverages.push(e.printedAverages[0]); }, /average nominal/],
    ['non-positive average', e => { e.printedAverages[0].printed = '0'; }, /positive printed seconds/],
  ])('refuses %s', (_name, edit, message) => {
    const entry = averageTranscription();
    edit(entry);
    const result = run({ [scanPath]: { scan: report() } }, { documents: [], unread: [entry] });
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(message);
    expect(result.json).toBeNull();
  });

  it('refuses an average joined to a motor with individual measurements', () => {
    const result = run({ [scanPath]: { scan: report() }, 'NAR/Test/Measured.pdf': report() },
      { documents: [], unread: [averageTranscription()] });
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('measured data wins');
    expect(result.json).toBeNull();
  });

  it.each([
    ['NAR/29mm Model Rocket Single-Use/E99W.pdf', 'reload'],
    ['TRA/29mm Model Rocket Single Use/E99W.pdf', 'reload'],
    ['NAR/RMS-29-120/E99W.pdf', 'SU'],
    ['TRA/29mm Reload/E99W.pdf', 'SU'],
  ])('refuses the hardware mismatch %s -> %s', (document, hardwareType) => {
    const result = run({ [document]: { scan: report() } },
      { documents: [], unread: [averageTranscription(document)] }, [], hardwareType);
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain('HARDWARE_MISMATCH');
    expect(result.json).toBeNull();
  });

  it('leaves the discontinued single-use G25W unjoined to the catalogue reload', () => {
    const bootstrap = `import importlib.util, json, sys
sys.path.insert(0, ${JSON.stringify(here)})
spec = importlib.util.spec_from_file_location('delays', ${JSON.stringify(extractor)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
rel = 'NAR/29mm Model Rocket Single-Use/G25W.pdf'
row = {'motorId': 'catalogue-reload', 'manufacturerAbbrev': 'AeroTech', 'designation': 'G25W', 'type': 'reload'}
print(json.dumps(m.join_averages({rel: {4: 4.34}}, {('AeroTech', 'G25W'): [row]}, {}, {rel: 'https://example.invalid/G25W.pdf'}, {rel: m.AVERAGE_JOIN[rel]}, {})))`;
    const result = spawnSync(python, ['-c', bootstrap], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({});
  });

  it.each([false, true])('chooses the sorted duplicate source for its URL and value (reversed=%s)', reverse => {
    const other = 'TRA/Test Single-Use/E99W.pdf';
    const unread = [averageTranscription(), averageTranscription(other, '4.344')];
    if (reverse) unread.reverse();
    const result = run({ [scanPath]: { scan: report() }, [other]: { scan: report() } }, { documents: [], unread });
    expect(result.status, result.stderr).toBe(0);
    expect(result.json.averages['id-e99w']).toMatchObject({
      documents: [scanPath, other], url: 'https://example.invalid/0.pdf',
      delays: [{ nominalS: 4, averageS: 4.34 }],
    });
  });

  it.each([
    ['4.34', [], true],
    ['4.35', [], false],
    ['4.35', [['AeroTech', 'E99W', [4]]], true],
    ['4.34', [['AeroTech', 'E99W', [4]]], false],
  ])('checks duplicate averages and stale disputes both ways (%s, %j)', (printed, disputes, ok) => {
    const other = 'TRA/Test Single-Use/E99W.pdf';
    const result = run({ [scanPath]: { scan: report() }, [other]: { scan: report() } },
      { documents: [], unread: [averageTranscription(), averageTranscription(other, printed)] }, disputes);
    expect(result.status, result.stderr).toBe(ok ? 0 : 1);
    if (!ok) {
      expect(result.stdout + result.stderr).toContain('AVERAGE_DISPUTED');
      expect(result.json).toBeNull();
    } else if (!disputes.length) {
      expect(result.json.averages['id-e99w'].documents).toEqual([scanPath, other]);
    } else {
      expect(result.json.averages).toEqual({});
    }
  });
});

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

const scanPath = 'NAR/Test Single-Use/E99W.pdf';
const position = { page: 1, row: '4 s', column: 'Delay (seconds)' };
function transcription() {
  return { documents: [{ document: scanPath, manufacturer: 'AeroTech', designation: 'E99W', delays: [{
    nominalS: 4,
    measurements: ['4.40', '4.60'].map((printed, i) => ({ printed, position: { ...position, row: `Motor ${i + 1}` } })),
    crossChecks: [
      { kind: 'average', printed: ['4.50'], position },
      { kind: 'summary', printed: ['4.40', '4.60'], position: { ...position, column: 'Actual' } },
    ],
  }] }], unread: [] };
}

describe.skipIf(!hasPyMuPDF)('reviewed scan transcriptions', { timeout: 30_000 }, () => {
  it.each([
    ['a new scan without any inventory', []],
    ['a scan omitted from a partial inventory', [{ document: 'TRA/Test/Listed.pdf', reason: 'No agreeing delay summary' }]],
  ])('refuses %s without writing output', (_name, unread) => {
    const docs = { [scanPath]: { scan: report() } };
    for (const entry of unread) docs[entry.document] = { scan: report() };
    const result = run(docs, { documents: [], unread });
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(`${scanPath}: scan has no unread review entry`);
    expect(result.json).toBeNull();
  });

  it('accounts separately for accepted and unread scans in a complete inventory', () => {
    const unreadPath = 'TRA/Test/Unread.pdf';
    const data = transcription();
    data.unread.push({ document: unreadPath, reason: 'No agreeing delay summary' });
    const result = run({ [scanPath]: { scan: report() }, [unreadPath]: { scan: report() } }, data);
    expect(result.status, result.stderr).toBe(0);
    expect(result.json).toMatchObject({
      motorCount: 1, pairCount: 1,
      documents: { 'scan-reviewed': 1, scan: 1 },
      scanReview: { reviewed: 2, accepted: 1, unreadForMerge: 1 },
    });
    expect(Object.values(result.json.motors).map((m) => m.document)).toEqual([scanPath]);
  });

  it('merges source-positioned measurements from a scan only after its own average and summary agree', () => {
    const result = run({ [scanPath]: { scan: report() } }, transcription());
    expect(result.status, result.stderr).toBe(0);
    expect(result.json.motors['id-e99w']).toMatchObject({
      form: 'scan-reviewed', delays: [{ nominalS: 4, measuredS: [4.4, 4.6] }],
    });
    expect(result.json).toMatchObject({ motorCount: 1, pairCount: 1, documents: { 'scan-reviewed': 1, scan: 0 } });
  });

  it.each([
    ['missing cross-check', (d) => { d.crossChecks = []; }, /missing cross-check/],
    ['conflicting average', (d) => { d.crossChecks[0].printed = ['4.70']; }, /average disagrees/],
    ['conflicting summary with the same mean', (d) => { d.crossChecks[1].printed = ['4.20', '4.80']; }, /summary disagrees/],
    ['missing value position', (d) => { delete d.measurements[0].position; }, /source position/],
    ['missing cross-check position', (d) => { delete d.crossChecks[0].position; }, /source position/],
    ['extra summary value', (d) => { d.crossChecks[1].printed.push('4.50'); }, /summary disagrees/],
  ])('refuses %s without writing output', (_name, edit, message) => {
    const data = transcription();
    edit(data.documents[0].delays[0]);
    const result = run({ [scanPath]: { scan: report() } }, data);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(message);
    expect(result.json).toBeNull();
  });

  it('refuses a changed PDF rather than trusting a transcription of its previous bytes', () => {
    const data = transcription();
    data.documents[0].sha256 = '0'.repeat(64);
    const result = run({ [scanPath]: { scan: report() } }, data);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/source hash changed/);
  });

  it('does not override the coordinate reader with a manual entry for a text-layer PDF', () => {
    const result = run({ [scanPath]: report() }, transcription());
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/not a scan/);
  });
});

describe.skipIf(!hasPyMuPDF || !existsSync(realDocs))('src/data/aerotechDelays.json', { timeout: 30_000 }, () => {
  it('is what the certification documents give', () => {
    const res = spawnSync(python, [extractor, '--check', '--watch-out', join(here, 'aerotech-delay-sources.json')],
      { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    expect(res.status, res.stdout + res.stderr).toBe(0);
  });
});
