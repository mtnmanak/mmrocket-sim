import { useEffect, useMemo, useState } from 'react';
import type { MotorSpec } from '@online-openrocket/engine';
import {
  MOTOR_DB, MOTOR_DB_DATE, classLabel, classesFittingMount, diameterClass,
  displayDesignation, filterMotors, manufacturersForMount, sortMotors,
  type MotorDbEntry, type MotorSortKey,
} from '../services/motorDb.js';
import {
  addExMotors, deleteExMotor, exToDbEntry, loadExMotors, parseMotorFile,
} from '../services/exMotors.js';
import { delayOptions, fetchMotorSpec } from '../services/thrustcurve.js';
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
  includeOOP: boolean;
  sortKey: MotorSortKey;
  sortDir: 1 | -1;
}

const DEFAULT_FILTERS: StoredFilters = {
  manufacturers: [],
  classes: [],
  includeOOP: false,
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
  const manufacturers = useMemo(
    () => manufacturersForMount(mountDiameterMm, filters.includeOOP, allMotors),
    [mountDiameterMm, filters.includeOOP, allMotors],
  );

  const rows = useMemo(() => {
    const filtered = filterMotors({
      manufacturers: new Set(filters.manufacturers),
      classes: new Set(filters.classes.filter((c) => fittingClasses.includes(c))),
      boreMm: mountDiameterMm,
      includeOOP: filters.includeOOP,
      text,
    }, allMotors);
    return sortMotors(filtered, filters.sortKey, filters.sortDir);
  }, [filters, text, mountDiameterMm, fittingClasses, allMotors]);

  const importMotorFile = async (file: File) => {
    setError(null);
    try {
      const motors = parseMotorFile(file.name, await file.text());
      setExMotors(addExMotors(motors));
      setError(null);
      setText('');
      setFilters({ ...filters, manufacturers: [] });
    } catch (e) {
      setError(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  useEffect(() => {
    if (picked) setDelay(delayOptions(picked)[delayOptions(picked).length - 1] ?? 0);
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
      const chosen = delay === 'auto' ? opts[opts.length - 1] ?? 0
        : delay === 'custom' ? customDelay
        : delay;
      const spec = await fetchMotorSpec(picked, chosen);
      const label = delay === 'auto'
        ? `${picked.commonName} (auto delay)`
        : `${picked.commonName}-${chosen}`;
      onSelect(label, spec, {
        label,
        manufacturer: picked.manufacturerAbbrev,
        availableDelays: opts,
        autoDelay: delay === 'auto',
        type: picked.type,
        propellant: picked.propInfo,
        motorCase: picked.caseInfo,
      });
      onClose();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  };

  const dimUi = (mm: number) => siToUi('motorDimensions', motorSym, mm / 1000);

  return (
    <div className="prefs-overlay" role="presentation" onClick={onClose}>
      <div
        className="prefs-dialog panel motor-browser"
        role="dialog"
        aria-label="Motor database"
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

          <div className="motor-filter-row">
            <input
              type="search"
              placeholder="Search designation…"
              value={text}
              onChange={(e) => setText(e.target.value)}
              style={{ flex: 1 }}
            />
            {maxMotorLengthM !== null && (
              <span className="motor-db-meta" title="Set in the Motor panel — a property of the rocket. Longer motors are flagged ⚠ but stay selectable.">
                max motor length {siToUi('motorDimensions', motorSym, maxMotorLengthM).toFixed(motorSym === 'mm' ? 0 : 2)} {motorSym}
              </span>
            )}
            <label className="motor-inline-label">
              <input
                type="checkbox"
                checked={filters.includeOOP}
                onChange={(e) => setFilters({ ...filters, includeOOP: e.target.checked })}
                style={{ width: 'auto' }}
              />
              include out-of-production
            </label>
            <label className="file-btn" title="Import experimental/EX motors from RASP (.eng) or RockSim (.rse) files — they appear under manufacturer EX">
              ⬆ Import .eng/.rse
              <input type="file" accept=".eng,.rse,.txt" style={{ display: 'none' }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) importMotorFile(f);
                  e.target.value = '';
                }} />
            </label>
          </div>
        </div>

        <div className="motor-table-wrap">
          <table className="motor-table">
            <thead>
              <tr>
                {SORTABLE.map(({ key, label }) => (
                  <th key={key} onClick={() => onHeader(key)} role="button"
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
                return (
                  <tr
                    key={m.motorId}
                    className={`motor-row ${picked?.motorId === m.motorId ? 'motor-row-picked' : ''} ${flagged ? 'motor-row-long' : ''}`}
                    onClick={() => setPicked(m)}
                    title={flagged
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
                  {delayOptions(picked).map((d) => <option key={d} value={d}>{d}s</option>)}
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
        {error && <p className="stability-bad" style={{ marginBottom: 0 }}>{error}</p>}
      </div>
    </div>
  );
}
