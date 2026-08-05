import type { FlightSummary, StaticInfo } from '@online-openrocket/engine';
import { usePrefs } from '../prefs/PrefsContext.js';
import { fmtSi, type Quantity } from '../prefs/units.js';
import { stabilityState } from '../services/simReport.js';
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

export function FlightStats({ summary }: { summary: FlightSummary }) {
  const { prefs } = usePrefs();
  const dist = prefs.units.distance;
  const vel = prefs.units.velocity;
  const acc = prefs.units.acceleration;
  return (
    <div className="stat-row">
      <Tile label="Apogee" value={fmtSi('distance', dist, summary.maxAltitude)} quantity="distance" />
      <Tile label="Max velocity" value={fmtSi('velocity', vel, summary.maxVelocity)} quantity="velocity" />
      <Tile label="Max accel" value={fmtSi('acceleration', acc, summary.maxAcceleration)} quantity="acceleration" />
      <Tile label="Apogee at" value={summary.timeToApogee.toFixed(1)} unit="s" />
      <Tile label="Descent hits" value={fmtSi('velocity', vel, summary.groundHitVelocity)} quantity="velocity" />
      <Tile label="Flight time" value={summary.flightTime.toFixed(0)} unit="s" />
    </div>
  );
}
