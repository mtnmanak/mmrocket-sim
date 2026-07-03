import type { FlightSummary, StaticInfo } from '@online-openrocket/engine';

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
  const stable = info.stabilityCalibers >= 1;
  const stabilityPct = info.length > 0
    ? ((info.cp - info.cg) / info.length) * 100
    : 0;
  return (
    <>
      <div className="stat-row">
        <Tile label="Length" value={(info.length * 100).toFixed(1)} unit="cm" />
        <Tile label="Max diameter" value={(info.refDiameter * 1000).toFixed(1)} unit="mm" />
        <Tile label="Mass (empty)" value={(info.massEmpty * 1000).toFixed(1)} unit="g" />
        <Tile label="Mass (loaded)" value={(info.mass * 1000).toFixed(1)} unit="g" />
        {motorLabel && <Tile label="Motor" value={motorLabel} />}
      </div>
      <div className="stat-row">
        <Tile label="CG (empty)" value={(info.cgEmpty * 100).toFixed(1)} unit="cm" />
        <Tile label="CG (loaded)" value={(info.cg * 100).toFixed(1)} unit="cm" />
        <Tile label="CP" value={(info.cp * 100).toFixed(1)} unit="cm" />
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
  return (
    <div className="stat-row">
      <Tile label="Apogee" value={summary.maxAltitude.toFixed(1)} unit="m" />
      <Tile label="Max velocity" value={summary.maxVelocity.toFixed(1)} unit="m/s" />
      <Tile label="Max accel" value={summary.maxAcceleration.toFixed(0)} unit="m/s²" />
      <Tile label="Apogee at" value={summary.timeToApogee.toFixed(1)} unit="s" />
      <Tile label="Descent hits" value={summary.groundHitVelocity.toFixed(1)} unit="m/s" />
      <Tile label="Flight time" value={summary.flightTime.toFixed(0)} unit="s" />
    </div>
  );
}
