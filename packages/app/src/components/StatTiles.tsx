import type { FlightSummary, StaticInfo } from '@online-openrocket/engine';
import { usePrefs } from '../prefs/PrefsContext.js';
import { fmtSi } from '../prefs/units.js';

function Tile({ label, value, unit, className }: {
  label: string;
  value: string;
  unit?: string;
  className?: string;
}) {
  return (
    <div className="stat-tile">
      <div className="stat-label">{label}</div>
      <div className={`stat-value ${className ?? ''}`}>
        {value}
        {unit && <span className="stat-unit">{unit}</span>}
      </div>
    </div>
  );
}

export function DesignStats({ info, motorLabel }: { info: StaticInfo; motorLabel?: string }) {
  const { prefs } = usePrefs();
  const len = prefs.units.length;
  const mass = prefs.units.mass;
  const stable = info.stabilityCalibers >= 1;
  const stabilityPct = info.length > 0
    ? ((info.cp - info.cg) / info.length) * 100
    : 0;
  return (
    <>
      <div className="stat-row">
        <Tile label="Length" value={fmtSi('length', len, info.length)} unit={len} />
        <Tile label="Max diameter" value={fmtSi('length', len, info.refDiameter)} unit={len} />
        <Tile label="Mass (empty)" value={fmtSi('mass', mass, info.massEmpty)} unit={mass} />
        <Tile label="Mass (loaded)" value={fmtSi('mass', mass, info.mass)} unit={mass} />
        {motorLabel && <Tile label="Motor" value={motorLabel} />}
      </div>
      <div className="stat-row">
        <Tile label="CG (empty)" value={fmtSi('length', len, info.cgEmpty)} unit={len} />
        <Tile label="CG (loaded)" value={fmtSi('length', len, info.cg)} unit={len} />
        <Tile label="CP" value={fmtSi('length', len, info.cp)} unit={len} />
        <Tile
          label="Stability"
          value={`${stable ? '✓' : '⚠'} ${info.stabilityCalibers.toFixed(2)}`}
          unit="cal"
          className={stable ? 'stability-good' : 'stability-bad'}
        />
        <Tile
          label="Stability"
          value={stabilityPct.toFixed(1)}
          unit="%"
          className={stable ? 'stability-good' : 'stability-bad'}
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
      <Tile label="Apogee" value={fmtSi('distance', dist, summary.maxAltitude)} unit={dist} />
      <Tile label="Max velocity" value={fmtSi('velocity', vel, summary.maxVelocity)} unit={vel} />
      <Tile label="Max accel" value={fmtSi('acceleration', acc, summary.maxAcceleration)} unit={acc} />
      <Tile label="Apogee at" value={summary.timeToApogee.toFixed(1)} unit="s" />
      <Tile label="Descent hits" value={fmtSi('velocity', vel, summary.groundHitVelocity)} unit={vel} />
      <Tile label="Flight time" value={summary.flightTime.toFixed(0)} unit="s" />
    </div>
  );
}
