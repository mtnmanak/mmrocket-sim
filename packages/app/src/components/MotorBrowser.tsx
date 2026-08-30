import { useEffect, useMemo, useState } from 'react';
import { clickable } from './clickable.js';
import { useDialog } from './useDialog.js';
import type { MotorSpec } from '@online-openrocket/engine';
import {
  MOTOR_DB, MOTOR_DB_DATE, classLabel, classesFittingMount, diameterClass,
  displayDesignation, filterMotors, hasMassData, impulseClassesForMount, isHighPower,
  manufacturersForMount, propellantsForMount, rangesForMount,
  sortMotors, type MotorDbEntry, type MotorSortKey,
} from '../services/motorDb.js';
import {
  addExMotors, deleteExMotor, exToDbEntry, loadExMotors, parseMotorFile,
} from '../services/exMotors.js';
import { delayOptions, delayTag, fetchMotorSpec } from '../services/thrustcurve.js';
import { usePrefs } from '../prefs/PrefsContext.js';
import { siToUi } from '../prefs/units.js';
import { NumField } from './NumField.js';
import { UnitChip } from './UnitChip.js';
import type { MotorMeta } from '../services/simReport.js';

/**
 * Full-database motor browser: manufacturer + diameter-class toggles (motors
 * larger than the mount never show; smaller classes ride in adapters), OOP
 * toggle, free-text search, and a sortable table. Motors longer than the
 * rocket's max motor length (set in the main Motor panel — it's a property
 * of the rocket, not a browser filter) are flagged ⚠ but stay selectable —
 * the length limit is a heads-up (hidden internal components), not a hard rule.
 */

const FILTERS_KEY = 'online-openrocket.motor-filters.v1';
const ROW_CAP = 400;

interface StoredFilters {
  manufacturers: string[];
  classes: number[];
  /** Impulse letters, e.g. ["H","I"]; empty = all. */
  impulse: string[];
  /** Propellant names; empty = all. Behind "more filters". */
  propellants: string[];
  includeOOP: boolean;
  /** Hide motors longer than the mount's stated room. */
  fitsOnly: boolean;
  /** Inclusive windows; null = unbounded that end. Behind "All filters". */
  burnMin: number | null;
  burnMax: number | null;
  impulseMin: number | null;
  impulseMax: number | null;
  /** Whether the second filter row is open. */
  showAll: boolean;
  sortKey: MotorSortKey;
  sortDir: 1 | -1;
}

const DEFAULT_FILTERS: StoredFilters = {
  manufacturers: [],
  classes: [],
  impulse: [],
  propellants: [],
  includeOOP: false,
  fitsOnly: false,
  burnMin: null,
  burnMax: null,
  impulseMin: null,
  impulseMax: null,
  showAll: false,
  sortKey: 'totImpulseNs',
  sortDir: -1,
};

function loadFilters(): StoredFilters {
  try {
    const raw = localStorage.getItem(FILTERS_KEY);
    return raw ? { ...DEFAULT_FILTERS, ...(JSON.parse(raw) as Partial<StoredFilters>) } : DEFAULT_FILTERS;
  } catch {
    return DEFAULT_FILTERS;
  }
}

const SORTABLE: { key: MotorSortKey; label: string }[] = [
  { key: 'designation', label: 'Motor' },
  { key: 'manufacturerAbbrev', label: 'Mfr' },
  { key: 'diameter', label: 'Diam' },
  { key: 'length', label: 'Length' },
  { key: 'burnTimeS', label: 'Burn (s)' },
  { key: 'totImpulseNs', label: 'Impulse (Ns)' },
];

export function MotorBrowser({ mountDiameterMm, maxMotorLengthM, onSelect, onClose }: {
  mountDiameterMm: number;
  /** Rocket-level max motor length (SI m); null = no limit. */
  maxMotorLengthM: number | null;
  onSelect: (label: string, spec: MotorSpec, meta: MotorMeta) => void;
  onClose: () => void;
}) {
  const { prefs } = usePrefs();
  const motorSym = prefs.units.motorDimensions;

  const [filters, setFiltersRaw] = useState<StoredFilters>(loadFilters);
  const [text, setText] = useState('');
  const [picked, setPicked] = useState<MotorDbEntry | null>(null);
  const [delay, setDelay] = useState<number | 'auto' | 'custom'>(0);
  const [customDelay, setCustomDelay] = useState(6);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [exMotors, setExMotors] = useState(() => loadExMotors());

  const setFilters = (next: StoredFilters) => {
    setFiltersRaw(next);
    try {
      localStorage.setItem(FILTERS_KEY, JSON.stringify(next));
    } catch { /* best-effort */ }
  };

  // Bundled thrustcurve DB + imported EX motors under manufacturer "EX".
  const allMotors = useMemo(
    () => [...MOTOR_DB, ...exMotors.map(exToDbEntry)],
    [exMotors],
  );

  const fittingClasses = useMemo(
    () => classesFittingMount(mountDiameterMm, allMotors),
    [mountDiameterMm, allMotors]);
  const impulseClasses = useMemo(
    () => impulseClassesForMount(mountDiameterMm, filters.includeOOP, allMotors),
    [mountDiameterMm, filters.includeOOP, allMotors],
  );
  const propellants = useMemo(
    () => propellantsForMount(mountDiameterMm, filters.includeOOP, allMotors),
    [mountDiameterMm, filters.includeOOP, allMotors],
  );
  /** What this mount's motors actually span — the placeholders say so. */
  const ranges = useMemo(
    () => rangesForMount(mountDiameterMm, filters.includeOOP, allMotors),
    [mountDiameterMm, filters.includeOOP, allMotors],
  );
  const manufacturers = useMemo(
    () => manufacturersForMount(mountDiameterMm, filters.includeOOP, allMotors),
    [mountDiameterMm, filters.includeOOP, allMotors],
  );

  const rows = useMemo(() => {
    const filtered = filterMotors({
      manufacturers: new Set(filters.manufacturers),
      classes: new Set(filters.classes.filter((c) => fittingClasses.includes(c))),
      impulse: new Set(filters.impulse),
      propellants: new Set(filters.propellants),
      // Only enforceable when the rocket actually states its room; the
      // checkbox is disabled and explained when it does not.
      maxLengthM: filters.fitsOnly ? maxMotorLengthM : null,
      burnS: { min: filters.burnMin, max: filters.burnMax },
      impulseNs: { min: filters.impulseMin, max: filters.impulseMax },
      boreMm: mountDiameterMm,
      includeOOP: filters.includeOOP,
      text,
    }, allMotors);
    return sortMotors(filtered, filters.sortKey, filters.sortDir);
  }, [filters, text, mountDiameterMm, fittingClasses, allMotors, maxMotorLengthM]);

  // Single files or a whole EX-motor folder (2026-08-05e): every .eng/.rse
  // found is parsed and added to the persistent library; unreadable files are
  // reported by name instead of aborting the batch.
  const importMotorFiles = async (files: File[]) => {
    setError(null);
    setNotice(null);
    const motorFiles = files.filter((f) => /\.(eng|rse|txt)$/i.test(f.name));
    if (motorFiles.length === 0) {
      setError('No .eng or .rse files found in that selection.');
      return;
    }
    const imported: string[] = [];
    const failed: string[] = [];
    let next = exMotors;
    for (const f of motorFiles) {
      try {
        const motors = parseMotorFile(f.name, await f.text());
        next = addExMotors(motors);
        imported.push(...motors.map((m) => m.designation));
      } catch (e) {
        failed.push(`${f.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (imported.length) {
      setExMotors(next);
      setText('');
      // Clear the maker AND diameter chips: a persisted class selection would
      // silently hide the motor that was just imported ("where did it go?").
      setFilters({ ...filters, manufacturers: [], classes: [] });
      setNotice(`Imported ${imported.length} EX motor${imported.length === 1 ? '' : 's'} `
        + `(${imported.slice(0, 6).join(', ')}${imported.length > 6 ? ', …' : ''}) — `
        + 'they live in this browser under manufacturer EX and survive reloads.');
    }
    if (failed.length) {
      setError(`Skipped ${failed.length} file${failed.length === 1 ? '' : 's'} — ${failed.join(' · ')}`);
    }
  };

  useEffect(() => {
    // Default to the longest PRESCRIBED delay; plugged (Infinity) only when
    // it's the motor's sole option — nobody should get a chute-less flight
    // by default.
    if (picked) {
      const opts = delayOptions(picked);
      const finite = opts.filter((d) => Number.isFinite(d));
      setDelay(finite[finite.length - 1] ?? opts[opts.length - 1] ?? 0);
    }
  }, [picked]);

  const tooLong = (m: MotorDbEntry) =>
    maxMotorLengthM !== null && m.length / 1000 > maxMotorLengthM;

  const toggle = <T,>(list: T[], v: T): T[] =>
    list.includes(v) ? list.filter((x) => x !== v) : [...list, v];

  const onHeader = (key: MotorSortKey) => {
    setFilters(filters.sortKey === key
      ? { ...filters, sortDir: filters.sortDir === 1 ? -1 : 1 }
      : { ...filters, sortKey: key, sortDir: key === 'designation' || key === 'manufacturerAbbrev' ? 1 : -1 });
  };

  const load = async () => {
    if (!picked) return;
    setBusy(true);
    setError(null);
    try {
      const opts = delayOptions(picked);
      // "auto" flies a provisional delay; each launch then re-runs with the
      // simulated optimum rounded to the nearest whole second. "custom" is
      // the drill-your-own value (delays get drilled to any whole second in
      // the real world, whatever the manufacturer prescribes).
      const finite = opts.filter((d) => Number.isFinite(d));
      const chosen = delay === 'auto' ? finite[finite.length - 1] ?? 0
        : delay === 'custom' ? customDelay
        : delay;
      const spec = await fetchMotorSpec(picked, chosen);
      const label = delay === 'auto'
        ? `${picked.commonName} (auto delay)`
        : `${picked.commonName}-${delayTag(chosen)}`;
      onSelect(label, spec, {
        label,
        manufacturer: picked.manufacturerAbbrev,
        // EX motors: pin the exact library entry ("ex:" namespace), so a
        // later .ork export writes THIS vendor's manufacturer even when two
        // vendors' same-designation curves coexist in the library.
        ...(picked.motorId.startsWith('ex:') ? { exMotorId: picked.motorId } : {}),
        availableDelays: opts,
        autoDelay: delay === 'auto',
        type: picked.type,
        propellant: picked.propInfo,
        motorCase: picked.caseInfo,
        highPower: isHighPower(picked),
      });
      onClose();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  };

  const dimUi = (mm: number) => siToUi('motorDimensions', motorSym, mm / 1000);

  const dialogRef = useDialog(onClose);

  return (
    <div className="prefs-overlay" role="presentation" onClick={onClose}>
      <div
        className="prefs-dialog panel motor-browser"
        role="dialog"
        aria-modal="true"
        aria-label="Motor database"
        ref={dialogRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <h2 style={{ flex: 1 }}>
            Motor database
            <span className="motor-db-meta"> thrustcurve.org · {MOTOR_DB_DATE} · mount ⌀ {dimUi(mountDiameterMm).toFixed(1)} {motorSym}</span>
          </h2>
          <button className="file-btn" onClick={onClose} aria-label="Close motor browser">✕ Close</button>
        </div>

        <div className="motor-filter-block">
          <div className="motor-chip-row" role="group" aria-label="Manufacturers">
            <span className="motor-chip-caption">Makers</span>
            {manufacturers.map(({ abbrev, count }) => (
              <button
                key={abbrev}
                className={`series-chip ${filters.manufacturers.includes(abbrev) ? 'series-chip-on' : ''}`}
                onClick={() => setFilters({ ...filters, manufacturers: toggle(filters.manufacturers, abbrev) })}
              >
                {abbrev} <span className="motor-chip-count">{count}</span>
              </button>
            ))}
            {filters.manufacturers.length > 0 && (
              <button className="file-btn" onClick={() => setFilters({ ...filters, manufacturers: [] })}>all</button>
            )}
          </div>

          <div className="motor-chip-row" role="group" aria-label="Diameter classes">
            <span className="motor-chip-caption">Diameter</span>
            {fittingClasses.map((c) => (
              <button
                key={c}
                className={`series-chip ${filters.classes.includes(c) ? 'series-chip-on' : ''}`}
                onClick={() => setFilters({ ...filters, classes: toggle(filters.classes, c) })}
              >
                {classLabel(c)} mm
              </button>
            ))}
            {filters.classes.length > 0 && (
              <button className="file-btn" onClick={() => setFilters({ ...filters, classes: [] })}>all</button>
            )}
          </div>

          {/* Impulse class — "just show me the H motors" (owner, 2026-08-30). */}
          <div className="motor-chip-row" role="group" aria-label="Impulse classes">
            <span className="motor-chip-caption">Class</span>
            {impulseClasses.map(({ letter, count }) => (
              <button
                key={letter}
                className={`series-chip ${filters.impulse.includes(letter) ? 'series-chip-on' : ''}`}
                onClick={() => setFilters({ ...filters, impulse: toggle(filters.impulse, letter) })}
              >
                {letter} <span className="motor-chip-count">{count}</span>
              </button>
            ))}
            {filters.impulse.length > 0 && (
              <button className="file-btn" onClick={() => setFilters({ ...filters, impulse: [] })}>all</button>
            )}
          </div>

          <div className="motor-filter-row">
            <input
              type="search"
              placeholder="Search designation…"
              value={text}
              onChange={(e) => setText(e.target.value)}
              style={{ flex: 1 }}
            />
            <label className="motor-inline-label"
              title={maxMotorLengthM !== null
                ? `Hide motors longer than ${siToUi('motorDimensions', motorSym, maxMotorLengthM).toFixed(motorSym === 'mm' ? 0 : 2)} ${motorSym} — the room this stage states it has. Over-length motors stay flagged ⚠ when this is off.`
                : 'This rocket states no maximum motor length, so there is nothing to filter against. Set one on the Motors & Launch tab — the ⌾ Estimate button there measures it from the mount.'}>
              <input
                type="checkbox"
                checked={filters.fitsOnly && maxMotorLengthM !== null}
                disabled={maxMotorLengthM === null}
                onChange={(e) => setFilters({ ...filters, fitsOnly: e.target.checked })}
                style={{ width: 'auto' }}
              />
              only motors that fit
              {maxMotorLengthM !== null
                ? <span className="motor-db-meta"> ≤ {siToUi('motorDimensions', motorSym, maxMotorLengthM).toFixed(motorSym === 'mm' ? 0 : 2)} {motorSym}</span>
                : <span className="motor-db-meta"> — no max length set</span>}
            </label>
            <button className="file-btn" aria-expanded={filters.showAll}
              title={filters.showAll ? 'Hide the extra filters' : 'Propellant, out-of-production'}
              onClick={() => setFilters({ ...filters, showAll: !filters.showAll })}>
              {filters.showAll ? '▾' : '▸'} All filters
            </button>
            <label className="file-btn" title="Import experimental/EX motors from RASP (.eng) or RockSim (.rse) files — they appear under manufacturer EX and persist across sessions">
              ⬆ Import .eng/.rse
              <input type="file" accept=".eng,.rse,.txt" multiple style={{ display: 'none' }}
                onChange={(e) => {
                  const fs = Array.from(e.target.files ?? []);
                  if (fs.length) importMotorFiles(fs);
                  e.target.value = '';
                }} />
            </label>
            <label className="file-btn" title="Pick the folder where you keep your EX motor files — every .eng/.rse inside is added to the library in one go">
              📁 Import EX folder
              <input type="file" style={{ display: 'none' }}
                {...({ webkitdirectory: '' } as Record<string, string>)}
                onChange={(e) => {
                  const fs = Array.from(e.target.files ?? []);
                  if (fs.length) importMotorFiles(fs);
                  e.target.value = '';
                }} />
            </label>
          </div>

          {/* Everything else, folded away by default: three chip rows and a
              search line is already the most a dialog should ask for at a
              glance (owner, 2026-08-30: "the dialogue box would get
              cluttered"). */}
          {filters.showAll && (
            <>
              <div className="motor-chip-row" role="group" aria-label="Propellants">
                <span className="motor-chip-caption">Propellant</span>
                {propellants.slice(0, 14).map(({ name, count }) => (
                  <button
                    key={name}
                    className={`series-chip ${filters.propellants.includes(name) ? 'series-chip-on' : ''}`}
                    onClick={() => setFilters({ ...filters, propellants: toggle(filters.propellants, name) })}
                  >
                    {name} <span className="motor-chip-count">{count}</span>
                  </button>
                ))}
                {filters.propellants.length > 0 && (
                  <button className="file-btn" onClick={() => setFilters({ ...filters, propellants: [] })}>all</button>
                )}
              </div>
              {/* Windows, not sliders: a two-ended slider on a range this
                  skewed (a few Ns to tens of thousands) is unusable, and a
                  typed bound is what "0.0 to 2.4 seconds" actually means. */}
              <div className="motor-filter-row">
                <span className="motor-chip-caption">Burn (s)</span>
                <input type="number" className="motor-range-input" min={0} step={0.1}
                  aria-label="Shortest burn time, seconds"
                  placeholder={ranges ? ranges.burnS[0].toFixed(2) : 'min'}
                  value={filters.burnMin ?? ''}
                  onChange={(e) => setFilters({ ...filters, burnMin: e.target.value === '' ? null : Number(e.target.value) })} />
                <span className="motor-db-meta">to</span>
                <input type="number" className="motor-range-input" min={0} step={0.1}
                  aria-label="Longest burn time, seconds"
                  placeholder={ranges ? ranges.burnS[1].toFixed(2) : 'max'}
                  value={filters.burnMax ?? ''}
                  onChange={(e) => setFilters({ ...filters, burnMax: e.target.value === '' ? null : Number(e.target.value) })} />

                <span className="motor-chip-caption" style={{ marginLeft: 10 }}>Impulse (Ns)</span>
                <input type="number" className="motor-range-input" min={0} step={10}
                  aria-label="Smallest total impulse, newton-seconds"
                  placeholder={ranges ? String(Math.round(ranges.impulseNs[0])) : 'min'}
                  value={filters.impulseMin ?? ''}
                  onChange={(e) => setFilters({ ...filters, impulseMin: e.target.value === '' ? null : Number(e.target.value) })} />
                <span className="motor-db-meta">to</span>
                <input type="number" className="motor-range-input" min={0} step={10}
                  aria-label="Largest total impulse, newton-seconds"
                  placeholder={ranges ? String(Math.round(ranges.impulseNs[1])) : 'max'}
                  value={filters.impulseMax ?? ''}
                  onChange={(e) => setFilters({ ...filters, impulseMax: e.target.value === '' ? null : Number(e.target.value) })} />

                {(filters.burnMin !== null || filters.burnMax !== null
                  || filters.impulseMin !== null || filters.impulseMax !== null) && (
                  <button className="file-btn"
                    onClick={() => setFilters({ ...filters, burnMin: null, burnMax: null, impulseMin: null, impulseMax: null })}>
                    clear
                  </button>
                )}
              </div>
              <div className="motor-filter-row">
                <label className="motor-inline-label">
                  <input
                    type="checkbox"
                    checked={filters.includeOOP}
                    onChange={(e) => setFilters({ ...filters, includeOOP: e.target.checked })}
                    style={{ width: 'auto' }}
                  />
                  include out-of-production
                </label>
              </div>
            </>
          )}
        </div>

        <div className="motor-table-wrap">
          <table className="motor-table">
            <thead>
              <tr>
                {SORTABLE.map(({ key, label }) => (
                  <th key={key} onClick={() => onHeader(key)} role="button" tabIndex={0}
                    onKeyDown={(e) => {
                      // role="button" promises keyboard activation; without this
                      // sorting was mouse-only (the last named a11y defect).
                      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onHeader(key); }
                    }}
                    aria-sort={filters.sortKey === key ? (filters.sortDir === 1 ? 'ascending' : 'descending') : undefined}>
                    {key === 'diameter' || key === 'length'
                      ? <>{label} (<UnitChip quantity="motorDimensions" />)</>
                      : label}
                    {filters.sortKey === key && (filters.sortDir === 1 ? ' ▲' : ' ▼')}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, ROW_CAP).map((m) => {
                const flagged = tooLong(m);
                // thrustcurve.org has no usable weights for ~13% of the catalog;
                // those cannot be simulated at all, so they stay listed (they are
                // real motors) but are not pickable. See motorDb.hasMassData.
                const noMass = !hasMassData(m);
                return (
                  <tr
                    key={m.motorId}
                    className={`motor-row ${picked?.motorId === m.motorId ? 'motor-row-picked' : ''} ${flagged ? 'motor-row-long' : ''} ${noMass ? 'motor-row-nomass' : ''}`}
                    aria-disabled={noMass || undefined}
                    {...clickable(() => { if (!noMass) setPicked(m); })}
                    title={noMass
                      ? 'thrustcurve.org publishes no usable weight for this motor, so it cannot be simulated. Import its .rse/.eng file to fly it.'
                      : flagged
                        ? `Longer than your max motor length — may hit internal components. Still selectable.`
                        : undefined}
                  >
                    <td>{flagged && '⚠ '}{displayDesignation(m.designation, m.manufacturerAbbrev)}{m.availability !== 'regular' && <span className="motor-oop">OOP</span>}</td>
                    <td>{m.manufacturerAbbrev}</td>
                    <td>{dimUi(m.diameter).toFixed(motorSym === 'mm' ? 0 : 2)}</td>
                    <td>{dimUi(m.length).toFixed(motorSym === 'mm' ? 0 : 2)}</td>
                    <td>{m.burnTimeS.toFixed(1)}</td>
                    <td>{Math.round(m.totImpulseNs)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {rows.length === 0 && (
            <p className="placeholder" style={{ padding: 16 }}>No motors match these filters.</p>
          )}
          {rows.length > ROW_CAP && (
            <p className="motor-db-meta" style={{ padding: '6px 8px' }}>
              Showing {ROW_CAP} of {rows.length} — narrow the filters or sort to bring what you want to the top.
            </p>
          )}
        </div>

        <div className="motor-load-row">
          {picked ? (
            <>
              <span style={{ flex: 1 }}>
                <strong>{picked.manufacturerAbbrev} {displayDesignation(picked.designation, picked.manufacturerAbbrev)}</strong>
                {picked.motorId.startsWith('ex:') && (
                  <>
                    {' '}
                    <span className="motor-db-meta">
                      ({exMotors.find((m) => m.motorId === picked.motorId)?.realManufacturer ?? 'imported'})
                    </span>
                    {' '}
                    <button className="fin-row-del" title="Remove this imported motor"
                      onClick={() => {
                        setExMotors(deleteExMotor(picked.motorId));
                        setPicked(null);
                      }}>🗑</button>
                  </>
                )}
                {tooLong(picked) && <span className="stability-bad"> ⚠ exceeds max motor length</span>}
              </span>
              <label className="motor-inline-label">
                Delay
                <select
                  value={delay}
                  onChange={(e) => {
                    const v = e.target.value;
                    setDelay(v === 'auto' || v === 'custom' ? v : Number(v));
                  }}
                >
                  <option value="auto">Auto (optimal)</option>
                  {/* Plugged is ALWAYS offered — flyers using electronic deploy
                      remove the ejection charge from any motor, not just ones
                      sold with a factory "P" option. */}
                  {(() => {
                    const opts = delayOptions(picked);
                    return (opts.includes(Infinity) ? opts : [...opts, Infinity]).map((d) => (
                      <option key={d} value={d}>
                        {Number.isFinite(d) ? `${d}s` : 'Plugged — no ejection charge'}
                      </option>
                    ));
                  })()}
                  <option value="custom">Custom (drilled)…</option>
                </select>
              </label>
              {delay === 'custom' && (
                <span style={{ width: 70 }}>
                  <NumField value={customDelay} step={1} max={60} ariaLabel="Custom delay (s)"
                    onCommit={(v) => { if (v !== null) setCustomDelay(v); }} />
                </span>
              )}
              <button className="launch-btn" style={{ width: 'auto', marginTop: 0, padding: '6px 16px' }}
                onClick={load} disabled={busy}>
                {busy ? 'Loading…' : 'Load motor'}
              </button>
            </>
          ) : (
            <span className="motor-db-meta" style={{ flex: 1 }}>
              {rows.length} motors match — click a row, then load it.
            </span>
          )}
        </div>
        {notice && <p className="motor-db-meta" style={{ marginBottom: 0 }}>{notice}</p>}
        {error && <p className="file-note file-note-error" style={{ marginBottom: 0 }}>{error}</p>}
      </div>
    </div>
  );
}
