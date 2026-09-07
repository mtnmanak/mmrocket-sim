import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BODY_BUDGET,
  CATALOGUE_FIELDS,
  FRESHNESS_FLOOR_DAYS,
  MAX_ROWS,
  PR_BODY_MAX,
  diffCatalogue,
  diffCurves,
  renderCommitMessage,
  renderMarkdown,
  renderTitle,
  sameValue,
  summarise,
} from './motor-diff-summary.mjs';

/**
 * Tests for motor-diff-summary.mjs — the script that decides whether
 * .github/workflows/motors-refresh.yml opens a pull request.
 *
 * The one that matters most is "the weekly no-op opens nothing". Both refresh scripts
 * stamp today's date into their output unconditionally, so the FILES change every single
 * week whether or not a motor moved; if this script ever calls that a change, the workflow
 * opens a pull request every Monday for ever and the third one gets merged unread. Test 14
 * below is that case.
 *
 * The second is the anti-drift pair at the bottom: the 18-field catalogue projection exists
 * in THREE places and cannot be imported into all of them, so it is pinned by reading the
 * other two as text.
 *
 * Importing this module runs no CLI: motor-diff-summary.mjs keeps its main() behind an
 * entry-point guard, for the reason written above that guard — bbcode-from-blurb.mjs
 * shipped for months with a top-level CLI body that called process.exit(1) on import, so
 * none of its rules could be tested at all.
 */
const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, 'motor-diff-summary.mjs');
const DAY = 86_400_000;

/** A plausible 18-field catalogue row. `over` replaces any field. */
function motor(id, over = {}) {
  return {
    motorId: id,
    manufacturerAbbrev: 'AeroTech',
    designation: `F52T-${id}`,
    commonName: 'F52',
    impulseClass: 'F',
    diameter: 29,
    length: 98,
    type: 'reload',
    avgThrustN: 52.4,
    maxThrustN: 78.1,
    totImpulseNs: 78.2,
    burnTimeS: 1.5,
    totalWeightG: 23.9,
    propWeightG: 5.2,
    delays: '4,7,10',
    availability: 'regular',
    propInfo: 'Blue Thunder',
    caseInfo: 'RMS-29/40-120',
    ...over,
  };
}

/** One compact simulator file, the shape fetch-motor-curves.mjs writes. */
const curve = (simfileId, samples) => ({ simfileId, source: 'cert', format: 'RASP', samples });

const db = (motors, generated = '2026-09-14') => ({
  generated, source: 'thrustcurve.org API v1', count: motors.length, motors,
});

const bundle = (curves, generated = '2026-09-14') => ({
  generated,
  source: 'thrustcurve.org API v1 download.json (data: both), every simulator file per motor',
  catalogueGenerated: generated,
  motors: Object.keys(curves).length,
  files: Object.values(curves).reduce((k, list) => k + list.length, 0),
  curves,
});

const side = (motors, curves = {}, generated) => ({
  motors: db(motors, generated), curves: bundle(curves, generated),
});

const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

describe('sameValue', () => {
  // The exact case catalogueOverlay.ts documents, and the reason FLOAT_TOL exists at all:
  // motors.json's first row really does carry totalWeightG 23.900000000000002.
  it('treats a JSON round-trip artefact as the same number', () => {
    expect(sameValue('totImpulseNs', 13668.3, 13668.300000000001)).toBe(true);
    expect(sameValue('totalWeightG', 23.9, 23.900000000000002)).toBe(true);
  });

  it('does not treat a real certified-impulse correction as noise', () => {
    expect(sameValue('totImpulseNs', 8.96, 9.10)).toBe(false);
  });

  it('compares strings exactly, and null the same as absent', () => {
    expect(sameValue('availability', 'regular', 'OOP')).toBe(false);
    expect(sameValue('caseInfo', null, undefined)).toBe(true);
    // Not numeric, so no tolerance: a delay string is a list, not a measurement.
    expect(sameValue('delays', '4,7', '4,7,10')).toBe(false);
  });
});

describe('diffCatalogue', () => {
  it('reports a new motor as added and nothing as changed', () => {
    const d = diffCatalogue([motor('a')], [motor('a'), motor('b')]);
    expect(d.added.map((m) => m.motorId)).toEqual(['b']);
    expect(d.changed).toEqual([]);
    expect(d.removed).toEqual([]);
  });

  it('reports a withdrawn motor as removed', () => {
    const d = diffCatalogue([motor('a'), motor('b')], [motor('a')]);
    expect(d.removed.map((m) => m.motorId)).toEqual(['b']);
    expect(d.added).toEqual([]);
  });

  it('names the field that moved, with its before and after', () => {
    const d = diffCatalogue([motor('a')], [motor('a', { availability: 'OOP' })]);
    expect(d.changed).toHaveLength(1);
    expect(d.changed[0].fields).toEqual([{ field: 'availability', before: 'regular', after: 'OOP' }]);
    expect(d.changed[0].name).toBe('AeroTech F52T-a');
  });

  // The regression this whole script exists to prevent at the row level: JSON
  // round-tripping re-serialises a float and every week would look like a change.
  it('ignores a re-serialised float', () => {
    const d = diffCatalogue(
      [motor('a', { totalWeightG: 23.9 })],
      [motor('a', { totalWeightG: 23.900000000000002 })],
    );
    expect(d.changed).toEqual([]);
  });

  it('sorts every list by name, so a re-run of the same data renders identically', () => {
    const rows = [motor('c'), motor('a'), motor('b')];
    const shuffled = [rows[2], rows[0], rows[1]];
    const one = diffCatalogue([], rows).added.map((m) => m.name);
    const two = diffCatalogue([], shuffled).added.map((m) => m.name);
    expect(one).toEqual(two);
    expect(one).toEqual(['AeroTech F52T-a', 'AeroTech F52T-b', 'AeroTech F52T-c']);
  });
});

describe('diffCurves', () => {
  it('reports a motor that now has a curve as gained', () => {
    expect(diffCurves({}, { a: [curve('s1', [[0, 1]])] }).gained).toEqual(['a']);
  });

  it('reports a motor that lost its only curve', () => {
    expect(diffCurves({ a: [curve('s1', [[0, 1]])] }, {}).lost).toEqual(['a']);
  });

  // A re-uploaded curve keeps its simfileId, so only the CONTENT says it moved — and it
  // moves apogee, which is why the bundle is compared file by file rather than by count.
  it('catches a re-uploaded file at an unchanged simfileId', () => {
    const d = diffCurves(
      { a: [curve('s1', [[0, 1], [1, 2]])] },
      { a: [curve('s1', [[0, 1], [1, 2.5]])] },
    );
    expect(d.revised).toEqual([{ motorId: 'a', addedFiles: 0, removedFiles: 0, changedFiles: 1 }]);
  });

  it('counts a second simulator file appearing for an existing motor', () => {
    const d = diffCurves(
      { a: [curve('s1', [[0, 1]])] },
      { a: [curve('s1', [[0, 1]]), curve('s2', [[0, 1]])] },
    );
    expect(d.revised).toEqual([{ motorId: 'a', addedFiles: 1, removedFiles: 0, changedFiles: 0 }]);
  });
});

describe('summarise', () => {
  it('says nothing changed when the two copies are identical', () => {
    const s = summarise({ before: side([motor('a')]), after: side([motor('a')]) });
    expect(s.changed).toBe(false);
    expect(s.dateOnly).toBe(false);
    expect(s.openPr).toBe(false);
  });

  // THE central case. Both refresh scripts rewrite `generated` on every run, so this is
  // what a quiet week looks like on disk. It must not open a pull request.
  it('opens nothing when only the date stamps moved', () => {
    const s = summarise({
      before: side([motor('a')], {}, '2026-09-07'),
      after: side([motor('a')], {}, '2026-09-14'),
      now: Date.parse('2026-09-14T00:00:00Z'),
    });
    expect(s.changed).toBe(false);
    expect(s.dateOnly).toBe(true);
    expect(s.openPr).toBe(false);
  });

  it(`bumps a date-only refresh once the shipped catalogue is ${FRESHNESS_FLOOR_DAYS} days old`, () => {
    const now = Date.parse('2026-09-14T00:00:00Z');
    const at = (days) => summarise({
      before: side([motor('a')], {}, iso(now - days * DAY)),
      after: side([motor('a')], {}, '2026-09-14'),
      now,
    });
    expect(at(95).bumpAnyway).toBe(true);
    expect(at(95).openPr).toBe(true);
    expect(at(30).bumpAnyway).toBe(false);
    expect(at(30).openPr).toBe(false);
    // The floor sits below motor-db-age.test.mjs's 120-day deploy block, on purpose.
    expect(FRESHNESS_FLOOR_DAYS).toBeLessThan(120);
  });

  // Easy to miss: the catalogue is what people look at, but a curve moves apogee too.
  it('opens a pull request for a curve-only difference', () => {
    const s = summarise({
      before: side([motor('a')], { a: [curve('s1', [[0, 1], [1, 2]])] }),
      after: side([motor('a')], { a: [curve('s1', [[0, 1], [1, 2.5]])] }),
    });
    expect(s.changed).toBe(true);
    expect(s.openPr).toBe(true);
    expect(s.catalogue.changed).toEqual([]);
  });

  it('warns when a quarter of the catalogue moves in one refresh', () => {
    const rows = Array.from({ length: 1000 }, (_, i) => motor(`m${i}`));
    const moved = (k) => rows.map((m, i) => (i < k ? motor(m.motorId, { availability: 'OOP' }) : m));
    expect(summarise({ before: side(rows), after: side(moved(300)) }).massChange).toBe(true);
    expect(summarise({ before: side(rows), after: side(moved(20)) }).massChange).toBe(false);
  });
});

describe('renderTitle and renderCommitMessage', () => {
  // A SAFETY test, not a cosmetic one: the workflow passes the title as `--title "$(cat …)"`,
  // so a backtick or a `$(` in a motor designation would be command injection in a job that
  // holds `contents: write`. The title carries no designation at all — this pins that.
  it('is shell-safe even when a motor designation is hostile', () => {
    const hostile = motor('x', { designation: 'Est`es "C6" $B', manufacturerAbbrev: "$(id)'" });
    const s = summarise({ before: side([]), after: side([hostile]) });
    expect(renderTitle(s)).toMatch(/^[A-Za-z0-9 ():,.+~>_-]+$/);
  });

  it('carries the counts, and says so plainly on a date-only bump', () => {
    const now = Date.parse('2026-09-14T00:00:00Z');
    const changedSummary = summarise({
      before: side([motor('a'), motor('b')]),
      after: side([motor('a'), motor('c'), motor('d')]),
    });
    expect(renderTitle(changedSummary)).toBe('chore(motors): refresh catalogue to 2026-09-14 (+2 -1 ~0)');
    expect(renderCommitMessage(changedSummary)).toContain('2 -> 3 motors');

    const stale = summarise({
      before: side([motor('a')], {}, iso(now - 95 * DAY)),
      after: side([motor('a')], {}, '2026-09-14'),
      now,
    });
    expect(renderTitle(stale)).toContain('no motor changed');
    expect(renderTitle(stale)).toMatch(/^[A-Za-z0-9 ():,.+~>_-]+$/);
  });
});

describe('renderMarkdown', () => {
  const changedBody = renderMarkdown(summarise({
    before: side([motor('a'), motor('b')], { a: [curve('s1', [[0, 1]])] }),
    after: side([motor('a', { availability: 'OOP' }), motor('c')], {
      a: [curve('s1', [[0, 1]])], c: [curve('s2', [[0, 1]])],
    }),
  }));

  it('leads with the before and after counts for both files', () => {
    expect(changedBody).toContain('2 → 2 motors');
    expect(changedBody).toContain('1 → 2 motors with a curve');
    expect(changedBody).toContain('availability regular → OOP');
  });

  // The line that must survive every truncation path: merging is deploying.
  it('always says that merging deploys, in both forms', () => {
    const now = Date.parse('2026-09-14T00:00:00Z');
    const dateOnlyBody = renderMarkdown(summarise({
      before: side([motor('a')], {}, iso(now - 95 * DAY)),
      after: side([motor('a')], {}, '2026-09-14'),
      now,
    }));
    // …and in the third form the spec did not anticipate: the same renderer feeds the
    // workflow's job summary on a quiet week, when there is no PR to merge. The fact
    // survives; only the sentence around it changes, so the summary cannot claim a
    // pull request that was never opened.
    const quietBody = renderMarkdown(summarise({
      before: side([motor('a')], {}, '2026-09-07'),
      after: side([motor('a')], {}, '2026-09-14'),
      now,
    }));
    for (const body of [changedBody, dateOnlyBody, quietBody]) {
      expect(body).toContain('a push to main is the production deploy');
    }
    expect(changedBody).toContain('Merging this PR pushes to main');
    expect(quietBody).toContain('No pull request was opened.');
    expect(quietBody).not.toContain('Merging this PR');
    expect(quietBody).not.toContain('### Before merging');
  });

  it(`caps a long list at ${MAX_ROWS} rows`, () => {
    const rows = Array.from({ length: 500 }, (_, i) => motor(`m${String(i).padStart(3, '0')}`));
    const body = renderMarkdown(summarise({ before: side([]), after: side(rows) }));
    expect(body).toContain('…and 460 more');
    expect(body.match(/^\| AeroTech /gm) ?? []).toHaveLength(MAX_ROWS);
  });

  it('stays inside GitHub\'s body limit even when the whole catalogue moves', () => {
    const rows = Array.from({ length: 1155 }, (_, i) => motor(`m${String(i).padStart(4, '0')}`));
    const after = rows.map((m) => motor(m.motorId, { availability: 'OOP', totImpulseNs: 99.9 }));
    const body = renderMarkdown(summarise({ before: side(rows), after: side(after) }));
    expect(body.length).toBeLessThanOrEqual(BODY_BUDGET);
    expect(body.length).toBeLessThan(PR_BODY_MAX);
    expect(body.trimEnd().endsWith('</sub>')).toBe(true);
  });

  it('puts the mass-change banner where it cannot be scrolled past', () => {
    const rows = Array.from({ length: 100 }, (_, i) => motor(`m${i}`));
    const after = rows.map((m, i) => (i < 40 ? motor(m.motorId, { availability: 'OOP' }) : m));
    const body = renderMarkdown(summarise({ before: side(rows), after: side(after) }));
    expect(body.slice(0, 200)).toContain('REVIEW CAREFULLY');
  });

  // A date-only merge is not free — it deletes every tester's stored v0.110 overlay — and
  // the body has to say so, because that is the only cost of merging it.
  it('names the overlay cost on a date-only pull request', () => {
    const now = Date.parse('2026-09-14T00:00:00Z');
    const body = renderMarkdown(summarise({
      before: side([motor('a')], {}, iso(now - 95 * DAY)),
      after: side([motor('a')], {}, '2026-09-14'),
      now,
    }));
    expect(body).toMatch(/overlay/i);
    // …and does not ask the reader to check rows that do not exist.
    expect(body).not.toContain('The changed rows above are plausible');
    expect(body).toContain('re-dated to 2026-09-14');
  });
});

/**
 * The highest-value tests in this file. The 18-field catalogue projection lives in THREE
 * places and cannot be imported into all of them: fetch-motor-db.mjs does its work at
 * module top level and exports nothing, and catalogueOverlay.ts is browser TypeScript. So
 * the copies are pinned by reading the other two as text.
 */
describe('the 18-field catalogue projection has not drifted', () => {
  const namesIn = (text, re) => (re.exec(text)?.[1].match(/'([^']+)'/g) ?? [])
    .map((q) => q.slice(1, -1));

  it('matches FIELDS in fetch-motor-db.mjs, which is the writer and the authority', () => {
    const src = readFileSync(join(here, 'fetch-motor-db.mjs'), 'utf8');
    const fields = namesIn(src, /const FIELDS\s*=\s*\[([\s\S]*?)\];/);
    expect(fields.length, 'could not parse FIELDS out of fetch-motor-db.mjs').toBe(18);
    expect(
      fields,
      'fetch-motor-db.mjs WRITES motors.json, so its FIELDS list is the authority: copy it into '
      + 'CATALOGUE_FIELDS in motor-diff-summary.mjs and in src/services/catalogueOverlay.ts.',
    ).toEqual(CATALOGUE_FIELDS);
  });

  it('matches CATALOGUE_FIELDS in src/services/catalogueOverlay.ts, the in-app differ', () => {
    const src = readFileSync(join(here, '..', 'src', 'services', 'catalogueOverlay.ts'), 'utf8');
    const fields = namesIn(src, /CATALOGUE_FIELDS\s*=\s*\[([\s\S]*?)\]\s*as const;/);
    expect(fields.length, 'could not parse CATALOGUE_FIELDS out of catalogueOverlay.ts').toBe(18);
    expect(
      fields,
      'All three copies must agree, and fetch-motor-db.mjs (the writer) is the authority. '
      + 'A field only catalogueOverlay.ts knows about is a field this diff would never report.',
    ).toEqual(CATALOGUE_FIELDS);
  });
});

describe('the command line', () => {
  const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

  /** A temp directory holding one motors.json and one motorCurves.json. */
  const fixtureDir = (motors, curves, generated) => {
    const dir = mkdtempSync(join(tmpdir(), 'motor-diff-'));
    writeFileSync(join(dir, 'motors.json'), JSON.stringify(db(motors, generated)));
    writeFileSync(join(dir, 'motorCurves.json'), JSON.stringify(bundle(curves, generated)));
    return dir;
  };

  it('refuses to run with no arguments, and says which ones it needs', () => {
    const r = run([]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--before');
    expect(r.stderr).toContain('--after');
  });

  it('names the missing file and the command that writes it', () => {
    const empty = mkdtempSync(join(tmpdir(), 'motor-diff-empty-'));
    const good = fixtureDir([motor('a')], {});
    try {
      const r = run(['--before', empty, '--after', good]);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('motors.json');
      expect(r.stderr).toContain('npm run motors:refresh');
    } finally {
      rmSync(empty, { recursive: true, force: true });
      rmSync(good, { recursive: true, force: true });
    }
  });

  it('exits 0 and opens nothing when only the date stamp moved', () => {
    // Dates relative to today, so the fixture cannot age past FRESHNESS_FLOOR_DAYS and
    // start failing on a calendar boundary.
    const before = fixtureDir([motor('a')], {}, iso(Date.now() - 3 * DAY));
    const after = fixtureDir([motor('a')], {}, iso(Date.now()));
    const out = join(after, 'gh-output.txt');
    try {
      const r = run(['--before', before, '--after', after, '--github-output', out]);
      expect(r.status).toBe(0);
      expect(readFileSync(out, 'utf8')).toContain('open-pr=false');
    } finally {
      rmSync(before, { recursive: true, force: true });
      rmSync(after, { recursive: true, force: true });
    }
  });

  it('exits 0, says open-pr, and writes all three files when a motor is added', () => {
    const before = fixtureDir([motor('a')], {}, iso(Date.now() - 3 * DAY));
    const after = fixtureDir([motor('a'), motor('b')], {}, iso(Date.now()));
    const out = join(after, 'gh-output.txt');
    const md = join(after, 'pr-body.md');
    const title = join(after, 'pr-title.txt');
    const msg = join(after, 'commit-msg.txt');
    try {
      const r = run([
        '--before', before, '--after', after,
        '--markdown', md, '--title', title, '--commit-message', msg, '--github-output', out,
      ]);
      expect(r.status).toBe(0);
      expect(readFileSync(out, 'utf8')).toContain('open-pr=true');
      expect(readFileSync(out, 'utf8')).toContain('added=1');
      for (const f of [md, title, msg]) expect(readFileSync(f, 'utf8').length).toBeGreaterThan(0);
      expect(readFileSync(md, 'utf8')).toContain('a push to main is the production deploy');
    } finally {
      rmSync(before, { recursive: true, force: true });
      rmSync(after, { recursive: true, force: true });
    }
  });
});
