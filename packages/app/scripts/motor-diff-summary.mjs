#!/usr/bin/env node
/**
 * What ACTUALLY changed between two copies of the bundled motor data — the decider for
 * .github/workflows/motors-refresh.yml, which opens a pull request only when this script
 * says a motor moved.
 *
 * WHY IT EXISTS: `git diff` cannot answer the question. Two measured reasons.
 *
 *  1. Both refresh scripts stamp the day into their output UNCONDITIONALLY —
 *     fetch-motor-db.mjs:64 and fetch-motor-curves.mjs:133 are both
 *     `generated: new Date().toISOString().slice(0, 10)`. So the bytes of both files
 *     change on EVERY run whether or not thrustcurve.org moved a single row. A
 *     `git diff`-driven Action would open a pull request every Monday for ever, and
 *     the third one gets merged unread.
 *  2. Both files are single-line minified JSON (`wc -l` = 0 on each, measured
 *     2026-09-07). `git diff --stat` on a whole-file rewrite of a one-line file reports
 *     `1 insertion(+), 1 deletion(-)` — the SAME output for "one availability flag
 *     flipped" and "the API changed shape and all 1,155 rows moved". It is not even a
 *     scale indicator.
 *
 * So this compares the 18 catalogue fields row by row and the curve bundle file by file,
 * ignoring the two date stamps and the three derived counts, and renders the result as a
 * PR body a person can read in a minute.
 *
 * A no-op refresh is not free, which is why the default is NO pull request. motors.json's
 * `generated` is motorDb.ts:24's MOTOR_DB_DATE, and catalogueOverlay.ts:139 DELETES a
 * stored overlay whose `baseGenerated` no longer matches it. Shipping a date-only bump
 * therefore throws away every tester's v0.110 "check thrustcurve.org" results for zero
 * data gain. See FRESHNESS_FLOOR_DAYS for the one narrow exception.
 *
 * READ-ONLY with respect to the repo. It writes ONLY the files named on the command line
 * (all of them under $RUNNER_TEMP in the workflow) and never touches src/data — the
 * refresh scripts own those, this one only reads them.
 *
 * Usage:
 *   node packages/app/scripts/motor-diff-summary.mjs \
 *     --before <dir> --after <dir> \
 *     [--markdown <file>] [--title <file>] [--commit-message <file>] [--github-output <file>]
 *
 * Each <dir> must hold a motors.json and a motorCurves.json.
 *
 * EXIT CODES — and note where this DIVERGES from scripts/check-upstream.mjs:
 *   0  the summary was produced. INCLUDING when everything changed. check-upstream.mjs
 *      exits 1 for "something moved" because there it is a finding; here "something
 *      moved" is the normal, expected weekly outcome, and a non-zero exit would abort
 *      the workflow step under `set -e` before the pull request could be opened. The
 *      verdict travels in the `open-pr` output, never in `$?`.
 *   2  could not run: a missing or unparseable file, a bad or missing argument. Not a
 *      data verdict — the same meaning as check-upstream.mjs's 2.
 *   1  deliberately unused. Every data-INTEGRITY threshold (the 120-day age limit, the
 *      85 % curve-coverage floor, orphaned curve ids) belongs to
 *      packages/app/scripts/motor-db-age.test.mjs, which the workflow runs before this
 *      script. Duplicating one here is how two copies of a number drift apart.
 *
 * The CLI lives in main() behind an entry-point guard so the helpers can be imported and
 * unit-tested; importing this module must never run the CLI or call process.exit.
 */
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * The 18 fields the catalogue projects. There are two other copies of this list — FIELDS
 * in fetch-motor-db.mjs (the WRITER, and therefore the authority) and CATALOGUE_FIELDS in
 * src/services/catalogueOverlay.ts (the in-app differ) — and three copies of a list is how
 * a list drifts. It cannot be imported from either: fetch-motor-db.mjs does its work at
 * module top level and exports nothing, and the .ts is browser source. So it is copied
 * here and PINNED — motor-diff-summary.test.mjs reads both of those files as text and
 * fails if the three lists disagree.
 */
export const CATALOGUE_FIELDS = [
  'motorId', 'manufacturerAbbrev', 'designation', 'commonName', 'impulseClass',
  'diameter', 'length', 'type', 'avgThrustN', 'maxThrustN', 'totImpulseNs',
  'burnTimeS', 'totalWeightG', 'propWeightG', 'delays', 'availability',
  'propInfo', 'caseInfo',
];

/**
 * The 8 catalogue fields that are numbers — the only ones the float tolerance applies to.
 * The same set as catalogueOverlay.ts's NUMERIC_FIELDS, for the same reason: a string
 * compared with a tolerance is a bug waiting to happen.
 */
const NUMERIC_FIELDS = new Set([
  'diameter', 'length', 'avgThrustN', 'maxThrustN', 'totImpulseNs', 'burnTimeS',
  'totalWeightG', 'propWeightG',
]);

/**
 * Relative float tolerance, lifted verbatim from catalogueOverlay.ts's `same()`:
 * 13668.3 vs 13668.300000000001 is a serialisation artefact, not a certification change,
 * and the shipped catalogue already carries such values (motors.json's first row has
 * totalWeightG 23.900000000000002). NEVER widen it — a real certified-impulse correction
 * is orders of magnitude larger than this, and widening it is how a real change gets
 * silently dropped from a PR body that somebody then merges.
 */
const FLOAT_TOL = 1e-9;

/**
 * Top-level keys excluded from the verdict because they are a clock or are derived from
 * the rows: `generated` (in BOTH files — written unconditionally from new Date() at
 * fetch-motor-db.mjs:64 and fetch-motor-curves.mjs:133), `catalogueGenerated` (a copy of
 * the first), `count` / `motors` / `files` (counts of the rows, so a change in one means a
 * row changed and the row diff has already seen it), and `source` (a fixed description
 * string). A difference confined to these is what `dateOnly` means.
 */
export const IGNORED_TOP_LEVEL = ['generated', 'catalogueGenerated', 'count', 'motors', 'files', 'source'];

/**
 * How stale the SHIPPED catalogue may get before a date-only refresh is worth a pull
 * request of its own. 90 = 120 - 30: motor-db-age.test.mjs FAILS a deploy at 120 days and
 * check-upstream.mjs's flag window is 30, so 90 leaves a full month — four more weekly
 * runs — of slack for network failures before the backstop can fire.
 *
 * Why the default is NOT to open one. A date-only bump moves motors.json's `generated`,
 * which is motorDb.ts:24's MOTOR_DB_DATE, and catalogueOverlay.ts:139 DELETES a stored
 * overlay whose baseGenerated no longer matches it. So a cosmetic refresh silently throws
 * away every tester's v0.110 "check thrustcurve.org" results for no data gain. It is only
 * worth that once the alternative — a deploy blocked at 120 days — is worse.
 */
export const FRESHNESS_FLOOR_DAYS = 90;

/**
 * Rows listed per section before the body says "…and N more". The largest real movement on
 * record is the 26 new motors, one certified-impulse correction and 17 availability
 * changes that accumulated in 63 unrefreshed days (check-upstream.mjs's
 * CATALOGUE_MAX_AGE_DAYS docblock). A weekly run should see single digits; 40 covers a
 * month's catch-up after an outage and still leaves a body a person will read to the end.
 */
export const MAX_ROWS = 40;

/**
 * Above this fraction of the catalogue moving in ONE refresh, the body opens with a
 * REVIEW CAREFULLY banner. 26 changes in 63 days is 2.3 % of 1,155 rows; a quarter of the
 * catalogue moving in a week is not motor certification, it is an API shape change or a
 * truncated fetch. It WARNS rather than refusing: a genuine mass availability update must
 * still reach a human.
 */
export const MASS_CHANGE_WARN_FRACTION = 0.25;

/**
 * GitHub rejects a pull-request body over 65,536 characters ("body is too long"). Render
 * to 60,000 and keep the rest as headroom, so a body that grows a little between the
 * budget check and the API call cannot cross the hard limit.
 */
export const PR_BODY_MAX = 65536;
export const BODY_BUDGET = 60000;

// ------------------------------------------------------------------ comparison

/**
 * Whether two values of the same catalogue field are the same fact. Numeric fields get
 * FLOAT_TOL; everything else is compared as JSON, with `?? null` so a field that is absent
 * on one side and explicitly null on the other compares EQUAL — matching catalogueOverlay,
 * and matching reality: thrustcurve.org omits caseInfo for single-use motors.
 */
export function sameValue(field, a, b) {
  if (NUMERIC_FIELDS.has(field) && typeof a === 'number' && typeof b === 'number') {
    return Math.abs(a - b) <= FLOAT_TOL * Math.max(1, Math.abs(a), Math.abs(b));
  }
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** How a motor is named everywhere in this file: "AeroTech F52T". */
const nameOf = (m) => `${m?.manufacturerAbbrev ?? '?'} ${m?.designation ?? m?.motorId ?? '?'}`.trim();

const byName = (a, b) => String(a.name).localeCompare(String(b.name)) || String(a.motorId).localeCompare(String(b.motorId));

/**
 * Added / removed / changed, by motorId, over CATALOGUE_FIELDS only.
 *
 * Every list is sorted by name so the body is stable week to week: an unsorted list would
 * re-order on every render and make a re-run of the same data look like a change.
 */
export function diffCatalogue(beforeMotors, afterMotors) {
  const beforeById = new Map((beforeMotors ?? []).map((m) => [m?.motorId, m]));
  const afterById = new Map((afterMotors ?? []).map((m) => [m?.motorId, m]));

  const added = [];
  const changed = [];
  for (const m of afterMotors ?? []) {
    const b = beforeById.get(m?.motorId);
    if (!b) { added.push(m); continue; }
    const fields = CATALOGUE_FIELDS
      .filter((f) => !sameValue(f, b[f], m[f]))
      .map((f) => ({ field: f, before: b[f], after: m[f] }));
    if (fields.length) changed.push({ motorId: m.motorId, name: nameOf(m), fields });
  }
  const removed = (beforeMotors ?? []).filter((m) => !afterById.has(m?.motorId));

  const withName = (rows) => rows.map((m) => ({ ...m, name: nameOf(m) })).sort(byName);
  return { added: withName(added), removed: withName(removed), changed: changed.sort(byName) };
}

/**
 * A curve list keyed by simfileId, each value the stringified compact file. Comparing the
 * STRING is what catches a re-uploaded curve at an unchanged simfileId — samples rounded
 * differently, or the header masses fetch-motor-curves.mjs extracts having moved.
 *
 * A file with no simfileId gets a positional key rather than being dropped: the runtime
 * picks between files by their metadata, so an unidentifiable file still counts as one.
 */
function fileMap(files) {
  return new Map((files ?? []).map((f, i) => [String(f?.simfileId ?? `#${i}`), JSON.stringify(f)]));
}

/**
 * The curve bundle's `curves` maps compared motor by motor.
 *
 * `gained` = motorIds with at least one file now and none before (a newly certified motor
 * whose curve arrived, or one whose curve upload finally appeared); `lost` = the reverse,
 * which is the one that matters — a motor a tester's saved design references losing its
 * bundled curve means that design needs the network to fly.
 */
export function diffCurves(beforeCurves, afterCurves) {
  const before = beforeCurves ?? {};
  const after = afterCurves ?? {};
  const ids = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();

  const gained = [];
  const lost = [];
  const revised = [];
  for (const motorId of ids) {
    const b = before[motorId];
    const a = after[motorId];
    const bHas = Array.isArray(b) && b.length > 0;
    const aHas = Array.isArray(a) && a.length > 0;
    if (!bHas && aHas) { gained.push(motorId); continue; }
    if (bHas && !aHas) { lost.push(motorId); continue; }
    if (!bHas && !aHas) continue;

    const bm = fileMap(b);
    const am = fileMap(a);
    let addedFiles = 0;
    let changedFiles = 0;
    let removedFiles = 0;
    for (const [key, json] of am) {
      if (!bm.has(key)) addedFiles++;
      else if (bm.get(key) !== json) changedFiles++;
    }
    for (const key of bm.keys()) if (!am.has(key)) removedFiles++;
    if (addedFiles || removedFiles || changedFiles) {
      revised.push({ motorId, addedFiles, removedFiles, changedFiles });
    }
  }
  return { gained, lost, revised };
}

/** Shape of a curve bundle, for the headline line. `bytes` is passed in by the caller. */
export function curveStats(curvesDoc, bytes = 0) {
  const curves = curvesDoc?.curves ?? {};
  let files = 0;
  let points = 0;
  for (const list of Object.values(curves)) {
    if (!Array.isArray(list)) continue;
    files += list.length;
    for (const f of list) points += Array.isArray(f?.samples) ? f.samples.length : 0;
  }
  return { motors: Object.keys(curves).length, files, points, bytes };
}

// -------------------------------------------------------------------- verdict

/** True when any of the ignored top-level keys differs — i.e. the bytes moved. */
function stampsMoved(before, after) {
  for (const doc of ['motors', 'curves']) {
    const b = before?.[doc] ?? {};
    const a = after?.[doc] ?? {};
    for (const key of IGNORED_TOP_LEVEL) {
      if (JSON.stringify(b[key] ?? null) !== JSON.stringify(a[key] ?? null)) return true;
    }
  }
  return false;
}

/**
 * The whole verdict, in one object.
 *
 * `before` / `after` are each `{ motors: <motors.json>, curves: <motorCurves.json> }`.
 * `bytes` is `{ before: { motors, curves }, after: { motors, curves } }` from statSync —
 * optional, and the size clause is left out of the copy when it is missing.
 *
 * `shippedAgeDays` is computed from **before.motors.generated** — what is COMMITTED — and
 * never from `after`, which is always today by construction. An unreadable date is treated
 * as infinitely old: a catalogue whose date cannot be parsed is exactly the case where a
 * refresh is overdue and a human should see it.
 *
 * Easy to miss: `changed` is true for a CURVE-ONLY difference with an untouched catalogue.
 * The catalogue is what people look at, but a re-uploaded thrust curve moves apogee too.
 */
export function summarise({ before, after, now = Date.now(), bytes = {} }) {
  const beforeMotors = before?.motors?.motors ?? [];
  const afterMotors = after?.motors?.motors ?? [];

  const catalogue = diffCatalogue(beforeMotors, afterMotors);
  const curves = diffCurves(before?.curves?.curves, after?.curves?.curves);

  // motorId -> display name, for the curve sections, which carry ids and nothing else.
  // `after` wins, so a motor renamed upstream shows its new name.
  const names = {};
  for (const m of beforeMotors) names[m?.motorId] = nameOf(m);
  for (const m of afterMotors) names[m?.motorId] = nameOf(m);

  const beforeDate = before?.motors?.generated;
  const afterDate = after?.motors?.generated;
  const parsed = Date.parse(String(beforeDate));
  const shippedAgeDays = Number.isFinite(parsed)
    ? Math.floor((now - parsed) / 86_400_000)
    : Number.POSITIVE_INFINITY;

  const catalogueMoved = catalogue.added.length + catalogue.removed.length + catalogue.changed.length;
  const curvesMoved = curves.gained.length + curves.lost.length + curves.revised.length;
  const changed = catalogueMoved + curvesMoved > 0;
  const dateOnly = !changed && stampsMoved(before, after);
  const bumpAnyway = dateOnly && shippedAgeDays >= FRESHNESS_FLOOR_DAYS;

  return {
    catalogue: {
      added: catalogue.added,
      removed: catalogue.removed,
      changed: catalogue.changed,
      counts: { before: beforeMotors.length, after: afterMotors.length },
    },
    curves: {
      ...curves,
      stats: {
        before: curveStats(before?.curves, bytes.before?.curves ?? 0),
        after: curveStats(after?.curves, bytes.after?.curves ?? 0),
      },
    },
    names,
    dates: { before: beforeDate, after: afterDate, shippedAgeDays },
    changed,
    dateOnly,
    bumpAnyway,
    openPr: changed || bumpAnyway,
    massChange: beforeMotors.length > 0
      && catalogueMoved / beforeMotors.length > MASS_CHANGE_WARN_FRACTION,
  };
}

// --------------------------------------------------------------------- render

/** 1155 -> "1,155". Done by hand rather than toLocaleString, which is locale-dependent. */
const n = (v) => String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

const kb = (bytes) => `${Math.round(bytes / 1024)} KB`;

/** "1 motor" / "2 motors" — a body that says "1 motors" reads as generated slop. */
const plural = (k, one, many = `${one}s`) => `${n(k)} ${k === 1 ? one : many}`;

/**
 * A date, or a safe stand-in. Everything renderTitle emits passes through here, because
 * the workflow interpolates the title through `$(cat …)` in a shell — see renderTitle.
 */
const asDate = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(String(s)) ? String(s) : 'an unknown date');

/** A field value as the body prints it. */
const val = (v) => {
  if (v === null || v === undefined) return '(none)';
  if (typeof v === 'string') return v.replace(/\s+/g, ' ').trim() || '(blank)';
  return String(v);
};

/** Markdown table cells: a pipe in a motor name would otherwise open a new column. */
const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

/**
 * The PR title — and it is shell-safe BY CONSTRUCTION, not by escaping.
 *
 * .github/workflows/motors-refresh.yml passes it as `--title "$(cat …)"`, so a backtick,
 * a `$(` or a quote in a motor designation would be a command-injection hole with
 * `contents: write` in scope. The title is therefore assembled ONLY from an ISO date that
 * has been through asDate(), integers, and fixed ASCII words — it carries NO motor
 * designation at all. motor-diff-summary.test.mjs pins that with a fixture motor named
 * with a backtick, a quote and a `$` in it.
 *
 * The removed count uses an ASCII hyphen, never U+2212.
 */
export function renderTitle(summary) {
  const to = asDate(summary.dates.after);
  if (!summary.changed && summary.bumpAnyway) {
    return `chore(motors): re-date the catalogue, ${asDate(summary.dates.before)} -> ${to} (no motor changed)`;
  }
  const { added, removed, changed } = summary.catalogue;
  return `chore(motors): refresh catalogue to ${to} (+${added.length} -${removed.length} ~${changed.length})`;
}

/** The commit message on the refresh branch: the title, then the numbers behind it. */
export function renderCommitMessage(summary) {
  const c = summary.catalogue;
  const s = summary.curves.stats;
  const lines = [
    renderTitle(summary),
    '',
    'Regenerated by .github/workflows/motors-refresh.yml from thrustcurve.org API v1',
    '(`npm run motors:refresh` — the catalogue, then the curve bundle keyed to it).',
    '',
    `Catalogue: ${n(c.counts.before)} -> ${n(c.counts.after)} motors `
      + `(+${c.added.length} added, -${c.removed.length} removed, ${c.changed.length} changed).`,
    `Curve bundle: ${n(s.before.motors)} -> ${n(s.after.motors)} motors with a curve, `
      + `${n(s.before.files)} -> ${n(s.after.files)} files.`,
    '',
    'Merging this pushes to main, and a push to main is the production deploy.',
  ];
  return `${lines.join('\n')}\n`;
}

/** stdout, in check-upstream.mjs's voice: aligned labels, one measured line each. */
export function renderPlain(summary) {
  const c = summary.catalogue;
  const s = summary.curves.stats;
  const age = Number.isFinite(summary.dates.shippedAgeDays)
    ? `${summary.dates.shippedAgeDays} days old`
    : 'age unreadable';
  const out = [
    'Motor data diff — SEMANTIC. The date stamps both refresh scripts rewrite on every run',
    'are ignored, and so is `git diff`: both files are single-line JSON, so it reports the',
    'same "1 insertion, 1 deletion" for one flipped flag and for a whole new API shape.',
    '',
    `  catalogue   ${n(c.counts.before)} -> ${n(c.counts.after)} motors: `
      + `${c.added.length} added, ${c.removed.length} removed, ${c.changed.length} changed`,
    `  curves      ${n(s.before.motors)} -> ${n(s.after.motors)} motors with a curve, `
      + `${n(s.before.files)} -> ${n(s.after.files)} files, `
      + `${summary.curves.gained.length} gained / ${summary.curves.lost.length} lost / `
      + `${summary.curves.revised.length} revised`,
    `  generated   ${summary.dates.before} -> ${summary.dates.after} (shipped catalogue ${age})`,
    '',
  ];
  if (summary.massChange) {
    out.push('  WARN   over a quarter of the catalogue moved in one refresh — read the rows before merging.');
  }
  if (summary.openPr && summary.changed) {
    out.push('  verdict open a pull request: motor data moved.');
  } else if (summary.bumpAnyway) {
    out.push(`  verdict open a pull request: nothing moved, but the shipped catalogue is `
      + `${summary.dates.shippedAgeDays} days old (floor ${FRESHNESS_FLOOR_DAYS}).`);
  } else if (summary.dateOnly) {
    out.push('  verdict NO pull request: only the date stamp moved. Merging it would delete every');
    out.push('          tester\'s stored catalogue overlay for no data gain.');
  } else {
    out.push('  verdict NO pull request: the two copies are identical.');
  }
  return `${out.join('\n')}\n`;
}

/**
 * The one line that is in every body and survives every truncation path, in the two forms
 * the body is read in: as a pull request, and as the workflow's job summary on a quiet week
 * when nothing was opened. The second clause is identical in both, because it is the fact —
 * a push to main runs deploy.yml — and the first clause only has to stay honest about
 * whether a PR exists to merge.
 */
const DEPLOY_LINE = 'Merging this PR pushes to main, and a push to main is the production deploy.';
const NO_PR_LINE = 'No pull request was opened. (Merging one would push to main, and a push to '
  + 'main is the production deploy.)';
const FOOTER = '<sub>Opened by .github/workflows/motors-refresh.yml · data from thrustcurve.org API v1</sub>';

/**
 * `items` rendered, capped at maxRows, with the "…and N more" line when it bites.
 * The blank line before that line matters: it is what ends a Markdown table, so the
 * count reads as a paragraph rather than being swallowed as a malformed row.
 */
function capped(items, maxRows, render) {
  const lines = items.slice(0, maxRows).map(render);
  if (items.length > maxRows) lines.push('', `…and ${n(items.length - maxRows)} more`);
  return lines;
}

/**
 * The pull-request body.
 *
 * Two-stage truncation, because a PR body GitHub refuses is worse than a short one:
 * every list is first capped at `maxRows`, and then, if the whole body still exceeds
 * `budget`, whole detail sections are dropped from the BOTTOM up — each replaced by a
 * line saying how many rows it held. The deploy warning and the footer are never
 * droppable: they are the two lines the reader must see whatever else is cut.
 */
export function renderMarkdown(summary, { maxRows = MAX_ROWS, budget = BODY_BUDGET } = {}) {
  const c = summary.catalogue;
  const s = summary.curves.stats;
  const name = (id) => summary.names[id] ?? id;

  const head = [];
  if (summary.massChange) {
    const moved = c.added.length + c.removed.length + c.changed.length;
    head.push(`> **REVIEW CAREFULLY — ${n(moved)} of ${n(c.counts.before)} rows moved in one refresh.**`);
    head.push('> That is far more than motor certification produces in a week. Check whether the API'
      + ' changed shape or the fetch was truncated before merging any of it.');
    head.push('');
  }

  const sizes = s.before.bytes && s.after.bytes ? ` · ${kb(s.before.bytes)} → ${kb(s.after.bytes)}` : '';
  head.push(`**Catalogue** ${n(c.counts.before)} → ${n(c.counts.after)} motors `
    + `(+${c.added.length} added, -${c.removed.length} removed, ${c.changed.length} changed)`);
  head.push('');
  head.push(`**Curve bundle** ${n(s.before.motors)} → ${n(s.after.motors)} motors with a curve · `
    + `${n(s.before.files)} → ${n(s.after.files)} files${sizes}`);
  head.push('');
  head.push(`**generated** ${summary.dates.before} → ${summary.dates.after}`);
  head.push('');
  head.push(summary.openPr ? DEPLOY_LINE : NO_PR_LINE);
  head.push('');

  const sections = [];
  const section = (heading, rows, lines) => {
    if (!lines.length) return;
    sections.push({ heading, rows, lines, omitted: false });
  };

  if (summary.changed) {
    section('### Added', c.added.length, c.added.length ? [
      '| Motor | Class | Total impulse (Ns) | Avg thrust (N) | Availability |',
      '| --- | --- | --- | --- | --- |',
      ...capped(c.added, maxRows, (m) =>
        `| ${cell(m.name)} | ${cell(val(m.impulseClass))} | ${cell(val(m.totImpulseNs))} `
        + `| ${cell(val(m.avgThrustN))} | ${cell(val(m.availability))} |`),
    ] : []);

    section('### Removed', c.removed.length, c.removed.length ? [
      'A motor a saved design references disappearing is user-visible — this is the section'
      + ' most worth a look.',
      '',
      ...capped(c.removed, maxRows, (m) =>
        `- **${cell(m.name)}** (${cell(val(m.impulseClass))}, was ${cell(val(m.availability))})`),
    ] : []);

    section('### Changed', c.changed.length, c.changed.length ? capped(c.changed, maxRows, (ch) =>
      `- **${cell(ch.name)}** ` + ch.fields
        .map((f) => `${f.field} ${cell(val(f.before))} → ${cell(val(f.after))}`).join(', '),
    ) : []);

    const cv = summary.curves;
    const curveLines = [];
    if (cv.gained.length || cv.lost.length || cv.revised.length) {
      curveLines.push(`${plural(cv.gained.length, 'motor')} gained a curve · `
        + `${cv.lost.length} lost theirs · ${cv.revised.length} had a file added, removed `
        + 'or re-uploaded.');
      curveLines.push('');
      if (cv.lost.length) {
        curveLines.push('**Lost a curve** (these now need the network to fly):');
        curveLines.push('');
        curveLines.push(...capped([...cv.lost].map(name).sort(), maxRows, (t) => `- ${cell(t)}`));
        curveLines.push('');
      }
      if (cv.gained.length) {
        curveLines.push('**Gained a curve:**');
        curveLines.push('');
        curveLines.push(...capped([...cv.gained].map(name).sort(), maxRows, (t) => `- ${cell(t)}`));
        curveLines.push('');
      }
      if (cv.revised.length) {
        curveLines.push('**Files changed** (a re-uploaded curve at the same simfileId moves apogee):');
        curveLines.push('');
        curveLines.push(...capped(
          [...cv.revised].sort((a, b) => name(a.motorId).localeCompare(name(b.motorId))),
          maxRows,
          (r) => `- ${cell(name(r.motorId))} — `
            + `+${r.addedFiles} / -${r.removedFiles} / ${r.changedFiles} re-uploaded`,
        ));
      }
    }
    section('### Curve bundle', cv.gained.length + cv.lost.length + cv.revised.length, curveLines);
  }

  const tail = [];
  if (!summary.changed) {
    // Nothing moved. This body is rendered EITHER as a date-only pull request (the
    // catalogue aged past the floor) OR straight into the workflow's job summary with no
    // PR at all — so it must not claim a PR exists when none was opened.
    const age = `the committed catalogue is ${summary.dates.shippedAgeDays} days old`;
    tail.push('### No motor changed');
    tail.push('');
    tail.push('Not one catalogue field and not one curve file moved — only the date stamps both'
      + ' refresh scripts rewrite on every run.');
    tail.push('');
    tail.push('**Re-dating is not free.** It moves `motors.json`\'s `generated`, which is'
      + ' `motorDb.ts`\'s `MOTOR_DB_DATE`, and `catalogueOverlay.ts` discards a stored overlay'
      + ' whose base no longer matches. Every tester who used "check thrustcurve.org for newer'
      + ' motors" loses that overlay and has to press it again.');
    tail.push('');
    tail.push(summary.bumpAnyway
      ? `That cost is now worth paying: ${age}, past the ${FRESHNESS_FLOOR_DAYS}-day floor, and`
        + ' at 120 days `packages/app/scripts/motor-db-age.test.mjs` blocks a deploy outright.'
      : `So nothing was opened and the re-dated files were discarded — ${age}, well inside the`
        + ` ${FRESHNESS_FLOOR_DAYS}-day floor at which a re-date becomes worth a pull request.`);
    tail.push('');
  }
  // Skipped entirely when no pull request is opened: this same body goes into the
  // workflow's job summary on a quiet week, and a merge checklist for a merge that will
  // never happen is the kind of noise that teaches a reader to stop reading these.
  if (summary.openPr) {
    tail.push('### Before merging');
    tail.push('');
    if (summary.changed) {
      tail.push('- [ ] The changed rows above are plausible — an impulse or mass that jumped by'
        + ' an order of magnitude is upstream data trouble, not a certification.');
      tail.push('- [ ] CHANGELOG line, ready to paste: `Motor catalogue refreshed to '
        + `${asDate(summary.dates.after)} — ${n(c.counts.after)} motors (+${c.added.length} new, `
        + `-${c.removed.length} withdrawn, ${c.changed.length} corrected).\``);
    } else {
      // A date-only PR has no rows to check and nothing to claim it gave anyone. The
      // CHANGELOG line says what it really did, including the part that costs the reader
      // something — CLAUDE.md's rule is that known limits ship stated, not hidden.
      tail.push('- [ ] CHANGELOG line, ready to paste: `Motor catalogue re-dated to '
        + `${asDate(summary.dates.after)} — thrustcurve.org had no changes. If you had used `
        + '"check thrustcurve.org for newer motors", press it again after this update.`');
    }
    tail.push('- [ ] `version.json` and `APP_VERSION` are untouched by this PR — bump them in'
      + ' the release commit, not here.');
    tail.push('');
  }
  tail.push(FOOTER);

  const assemble = () => [
    ...head,
    ...sections.flatMap((sec) => (sec.omitted
      ? [sec.heading, '', `(${n(sec.rows)} rows omitted — see the diff)`, '']
      : [sec.heading, '', ...sec.lines, ''])),
    ...tail,
  ].join('\n');

  let body = assemble();
  for (let i = sections.length - 1; i >= 0 && body.length > budget; i--) {
    sections[i].omitted = true;
    body = assemble();
  }
  return body;
}

// ------------------------------------------------------------------------ CLI

/** Print and exit 2: could not run. Never a data verdict — see the exit-code block above. */
function cannotRun(message) {
  console.error(message);
  process.exit(2);
}

function loadSide(label, dir) {
  if (!dir) {
    cannotRun(`Missing --${label}.\n`
      + 'usage: node packages/app/scripts/motor-diff-summary.mjs --before <dir> --after <dir>\n'
      + '       [--markdown <file>] [--title <file>] [--commit-message <file>] [--github-output <file>]\n'
      + 'Each <dir> must hold a motors.json and a motorCurves.json.');
  }
  const read = (file) => {
    const path = join(dir, file);
    if (!existsSync(path)) {
      cannotRun(`--${label} ${dir}: ${file} is not there.\n`
        + 'Both motors.json and motorCurves.json must exist on each side. '
        + 'Run `npm run motors:refresh` first (it writes the catalogue, then the curve bundle).');
    }
    try {
      return { doc: JSON.parse(readFileSync(path, 'utf8')), bytes: statSync(path).size };
    } catch (e) {
      cannotRun(`--${label} ${dir}: ${file} is not readable JSON — ${e.message}\n`
        + 'A truncated file is what a half-finished fetch leaves behind; '
        + 're-run `npm run motors:refresh`.');
      return null; // unreachable; cannotRun exits
    }
  };
  const motors = read('motors.json');
  const curves = read('motorCurves.json');
  if (!Array.isArray(motors.doc?.motors) || motors.doc.motors.length === 0) {
    cannotRun(`--${label} ${dir}: motors.json has no \`motors\` array. `
      + 'That is an empty or wrong-shaped catalogue, not a diff. Run `npm run motors:refresh`.');
  }
  if (!curves.doc?.curves || typeof curves.doc.curves !== 'object') {
    cannotRun(`--${label} ${dir}: motorCurves.json has no \`curves\` object. `
      + 'Run `npm run motors:refresh` (fetch-motor-curves.mjs writes it).');
  }
  return {
    side: { motors: motors.doc, curves: curves.doc },
    bytes: { motors: motors.bytes, curves: curves.bytes },
  };
}

function main(argv) {
  const arg = (flag) => {
    const i = argv.indexOf(flag);
    return i > 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const before = loadSide('before', arg('--before'));
  const after = loadSide('after', arg('--after'));

  const summary = summarise({
    before: before.side,
    after: after.side,
    bytes: { before: before.bytes, after: after.bytes },
  });

  process.stdout.write(renderPlain(summary));

  const markdown = arg('--markdown');
  if (markdown) writeFileSync(markdown, renderMarkdown(summary), 'utf8');
  const title = arg('--title');
  if (title) writeFileSync(title, renderTitle(summary), 'utf8');
  const commit = arg('--commit-message');
  if (commit) writeFileSync(commit, renderCommitMessage(summary), 'utf8');

  const out = arg('--github-output');
  if (out) {
    // One key=value per line. Every value here is a single-line scalar, so none of them
    // needs GitHub's heredoc delimiter form — and none may ever grow into one.
    const age = Number.isFinite(summary.dates.shippedAgeDays) ? summary.dates.shippedAgeDays : 'unknown';
    appendFileSync(out, [
      `open-pr=${summary.openPr}`,
      `changed=${summary.changed}`,
      `date-only=${summary.dateOnly}`,
      `bump-anyway=${summary.bumpAnyway}`,
      `shipped-age-days=${age}`,
      `added=${summary.catalogue.added.length}`,
      `removed=${summary.catalogue.removed.length}`,
      `motors-changed=${summary.catalogue.changed.length}`,
      '',
    ].join('\n'), 'utf8');
  }
  // Exit 0 even when everything changed — the verdict is `open-pr`, not `$?`. See the
  // exit-code block at the top of this file for why that diverges from check-upstream.mjs.
}

// Run the CLI only when invoked directly. Importing this module for its helpers must not
// execute any of the above — bbcode-from-blurb.mjs shipped for months with an unguarded
// CLI body that called process.exit(1) on import, which is why its rules had no test.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv);
