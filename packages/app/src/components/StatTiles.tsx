import { useState } from 'react';
import type { StaticInfo } from '@online-openrocket/engine';
import { usePrefs } from '../prefs/PrefsContext.js';
import { fmtSi, type Quantity } from '../prefs/units.js';
import { stabilityState, type SimRun } from '../services/simReport.js';
import { UnitChip } from './UnitChip.js';

/** Shared tiered styling: under-stable = red, over-stable = yellow caution. */
export function stabilityGlyphClass(cal: number | null | undefined): { glyph: string; cls: string } {
  const st = stabilityState(cal);
  return st === 'under' ? { glyph: '⚠', cls: 'stability-bad' }
    : st === 'over' ? { glyph: '△', cls: 'stability-warn' }
    : { glyph: '✓', cls: 'stability-good' };
}

function Tile({ label, value, unit, quantity, className }: {
  label: string;
  value: string;
  unit?: string;
  /** When set, the unit is a click-to-change chip for this quantity group. */
  quantity?: Quantity;
  className?: string;
}) {
  return (
    <div className="stat-tile">
      <div className="stat-label">{label}</div>
      <div className={`stat-value ${className ?? ''}`}>
        {value}
        {quantity
          ? <span className="stat-unit"><UnitChip quantity={quantity} /></span>
          : unit && <span className="stat-unit">{unit}</span>}
      </div>
    </div>
  );
}

export function DesignStats({ info, motorLabel }: { info: StaticInfo; motorLabel?: string }) {
  const { prefs } = usePrefs();
  const len = prefs.units.length;
  const mass = prefs.units.mass;
  const { glyph, cls } = stabilityGlyphClass(info.stabilityCalibers);
  const stabilityPct = info.length > 0
    ? ((info.cp - info.cg) / info.length) * 100
    : 0;
  return (
    <>
      <div className="stat-row">
        <Tile label="Length" value={fmtSi('length', len, info.length, 3)} quantity="length" />
        <Tile label="Max diameter" value={fmtSi('length', len, info.refDiameter, 3)} quantity="length" />
        <Tile label="Mass (empty)" value={fmtSi('mass', mass, info.massEmpty)} quantity="mass" />
        <Tile label="Mass (loaded)" value={fmtSi('mass', mass, info.mass)} quantity="mass" />
        {motorLabel && <Tile label="Motor" value={motorLabel} />}
      </div>
      <div className="stat-row">
        <Tile label="CG (empty)" value={fmtSi('length', len, info.cgEmpty, 3)} quantity="length" />
        <Tile label="CG (loaded)" value={fmtSi('length', len, info.cg, 3)} quantity="length" />
        <Tile label="CP" value={fmtSi('length', len, info.cp, 3)} quantity="length" />
        <Tile
          label="Stability"
          value={`${glyph} ${info.stabilityCalibers.toFixed(2)}`}
          unit="cal"
          className={cls}
        />
        <Tile
          label="Stability"
          value={stabilityPct.toFixed(1)}
          unit="%"
          className={cls}
        />
      </div>
    </>
  );
}

// ---- Customizable results tiles (issue 2026-08-05b #3) ----

interface TileSpec {
  id: string;
  label: string;
  /** null value → tile renders an em-dash. */
  render: (run: SimRun, u: { dist: string; vel: string; acc: string; mass: string }) =>
    { value: string; quantity?: Quantity; unit?: string };
}

/** Every metric the highlighted tiles can show, in display order. */
export const RESULT_TILE_METRICS: TileSpec[] = [
  { id: 'apogee', label: 'Apogee', render: (r, u) => ({ value: fmtSi('distance', u.dist, r.maxAltitude), quantity: 'distance' }) },
  { id: 'maxVelocity', label: 'Max velocity', render: (r, u) => ({ value: fmtSi('velocity', u.vel, r.maxVelocity), quantity: 'velocity' }) },
  { id: 'maxMach', label: 'Max Mach', render: (r) => ({ value: r.maxMach.toFixed(2) }) },
  { id: 'maxAccel', label: 'Max accel', render: (r, u) => ({ value: fmtSi('acceleration', u.acc, r.maxAcceleration), quantity: 'acceleration' }) },
  { id: 'apogeeAt', label: 'Apogee at', render: (r) => ({ value: r.timeToApogee.toFixed(1), unit: 's' }) },
  {
    id: 'landingRate', label: 'Landing rate',
    // The old tile said "Descent hits" and quietly showed ground-hit velocity.
    render: (r, u) => ({
      value: fmtSi('velocity', u.vel, r.landingRate ?? r.groundHitVelocity), quantity: 'velocity',
    }),
  },
  {
    id: 'drogueRate', label: 'Drogue descent',
    render: (r, u) => {
      const d = (r.deployments ?? []).find((x) => !x.isLanding)?.descentRate;
      return { value: d == null ? '—' : fmtSi('velocity', u.vel, d), quantity: 'velocity' };
    },
  },
  { id: 'flightTime', label: 'Flight time', render: (r) => ({ value: r.totalFlightTime.toFixed(0), unit: 's' }) },
  {
    id: 'padWeight', label: 'Pad weight',
    render: (r, u) => ({ value: r.launchMass === null ? '—' : fmtSi('mass', u.mass, r.launchMass), quantity: 'mass' }),
  },
  {
    id: 'recoveryWeight', label: 'Recovery weight',
    render: (r, u) => ({ value: r.burnoutMass == null ? '—' : fmtSi('mass', u.mass, r.burnoutMass), quantity: 'mass' }),
  },
  {
    id: 'thrustToWeight', label: 'Thrust : weight',
    render: (r) => ({ value: r.thrustToWeightAtRod === null ? '—' : `${r.thrustToWeightAtRod.toFixed(1)} : 1` }),
  },
  {
    id: 'guideVelocity', label: 'Guide departure',
    render: (r, u) => ({ value: r.rodExitVelocity === null ? '—' : fmtSi('velocity', u.vel, r.rodExitVelocity), quantity: 'velocity' }),
  },
  {
    id: 'staticMargin', label: 'Static margin',
    render: (r) => ({ value: r.launchStaticMarginCal === null ? '—' : r.launchStaticMarginCal.toFixed(2), unit: 'cal' }),
  },
  {
    id: 'optimalDelay', label: 'Optimal delay',
    render: (r) => ({ value: r.optimumDelayS === null ? '—' : r.optimumDelayS.toFixed(1), unit: 's' }),
  },
];

/** The classic six (with "Descent hits" renamed to Landing rate). */
const DEFAULT_TILES = ['apogee', 'maxVelocity', 'maxAccel', 'apogeeAt', 'landingRate', 'flightTime'];

export function FlightStats({ run }: { run: SimRun }) {
  const { prefs, setPrefs } = usePrefs();
  const [picking, setPicking] = useState(false);
  const u = {
    dist: prefs.units.distance, vel: prefs.units.velocity,
    acc: prefs.units.acceleration, mass: prefs.units.mass,
  };
  const chosen = prefs.resultTiles ?? DEFAULT_TILES;
  const shown = RESULT_TILE_METRICS.filter((m) => chosen.includes(m.id));
  const toggle = (id: string) => {
    const next = chosen.includes(id) ? chosen.filter((x) => x !== id) : [...chosen, id];
    // Persist in catalog order; never drop to zero tiles.
    const ordered = RESULT_TILE_METRICS.map((m) => m.id).filter((x) => next.includes(x));
    setPrefs({ ...prefs, resultTiles: ordered.length ? ordered : DEFAULT_TILES });
  };
  return (
    <>
      <div className="stat-row" style={{ position: 'relative' }}>
        {shown.map((m) => {
          const v = m.render(run, u);
          return <Tile key={m.id} label={m.label} value={v.value} quantity={v.quantity} unit={v.unit} />;
        })}
        <button className="file-btn" style={{ alignSelf: 'flex-start' }}
          title="Choose which metrics show here"
          onClick={() => setPicking(!picking)}>⚙</button>
      </div>
      {picking && (
        <div className="panel" style={{ marginTop: 6, padding: '8px 12px' }}>
          <p className="comp-stats" style={{ margin: '0 0 6px' }}>
            Highlighted metrics — your picks are remembered. Everything is
            always available under “Show all details”.
          </p>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            {RESULT_TILE_METRICS.map((m) => (
              <label key={m.id} className="motor-inline-label" style={{ whiteSpace: 'nowrap', cursor: 'pointer' }}>
                <input type="checkbox" style={{ width: 'auto' }}
                  checked={chosen.includes(m.id)} onChange={() => toggle(m.id)} />
                {m.label}
              </label>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
