import type { RocketTree, StaticInfo } from '@online-openrocket/engine';
import { usePrefs } from '../prefs/PrefsContext.js';
import { fmtSi } from '../prefs/units.js';
import { formatStability, hasAerodynamicForce, type SimRun } from '../services/simReport.js';
import { Icon } from './Icon.js';
import { LaunchField, type LaunchConditions } from './LaunchPanel.js';
import { stabilityGlyphClass } from './StatTiles.js';
import { TreeSchematic } from './TreeSchematic.js';

/**
 * The phone home screen (S4, batch 08-21c): launch-centered, per the owner's
 * working-backwards steer — the field workflow is "confirm stability, check
 * delay/descent, swap motors, sim", not designing. Desktop is design-heavy;
 * below the phone breakpoint the app opens HERE. Everything on this screen is
 * a view over App's existing state — no state of its own.
 */
export function FlyScreen({ tree, info, run, motorLabel, launch, onLaunchChange,
  onLaunch, simulating, canLaunch, onChangeMotor, onCompare, canCompare, staleModel }: {
  tree: RocketTree;
  info: StaticInfo | null;
  /** The newest flight (current result's summary, else the last stored run). */
  run: SimRun | null;
  motorLabel: string | null;
  launch: LaunchConditions;
  onLaunchChange: (v: LaunchConditions) => void;
  onLaunch: () => void;
  simulating: boolean;
  canLaunch: boolean;
  /** "Change ▸" — jumps to the Motors & Launch workspace. */
  onChangeMotor: () => void;
  /** Opens batch simulate ("the range box question"). */
  onCompare: () => void;
  canCompare: boolean;
  /**
   * The model the shown run was flown on, when that is no longer the model
   * selected. The Fly screen deliberately does not render the vitals strip —
   * it IS those numbers, phone-sized — so the strip's own stale mark never
   * reaches here, and these four figures would silently read as belonging to
   * the current model.
   */
  staleModel?: string | null;
}) {
  const { prefs } = usePrefs();
  const stab = info && hasAerodynamicForce(info)
    ? stabilityGlyphClass(info.stabilityCalibers) : null;
  const descent = run ? (run.landingRate ?? run.groundHitVelocity) : null;

  const stat = (label: string, value: string, unit?: string) => (
    <div className="fly-stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">
        {value}
        {unit && <span className="stat-unit">{unit}</span>}
      </div>
    </div>
  );

  return (
    <main className="fly-screen">
      <div className="fly-head">
        <span className="fly-name">{tree.name || 'Rocket'}</span>
        {info && stab && (
          <span className={`fly-stability ${stab.cls}`}>
            {stab.glyph} {formatStability(info, prefs.stabilityUnit)}
          </span>
        )}
      </div>

      <div className="fly-main">
        <div className="fly-rocket rocket-stage">
          <div className="fly-view">
            <TreeSchematic
              tree={tree}
              info={info}
              motors={{}}
              onPatchNode={() => {}}
              selectedId={null}
              onSelect={() => {}}
              maxHeight={430}
              vertical
            />
          </div>
        </div>

        <div className="fly-col">
          {staleModel && (
            // Same rule as the Results tab: a flight kept across a model
            // switch is MARKED, never silently re-read under the new model.
            <p className="fly-stale" role="status">
              ⚠ Flown on <strong>{staleModel}</strong>, not the model now
              selected — press Launch to re-fly.
            </p>
          )}
          <div className="fly-stats">
            {stat('Apogee', run ? fmtSi('distance', prefs.units.distance, run.maxAltitude) : '—',
              run ? prefs.units.distance : undefined)}
            {stat('Optimum delay', run?.optimumDelayS != null ? run.optimumDelayS.toFixed(1) : '—',
              run?.optimumDelayS != null ? 's' : undefined)}
            {stat('Descent', descent != null ? fmtSi('velocity', prefs.units.velocity, descent) : '—',
              descent != null ? prefs.units.velocity : undefined)}
            {stat('Max velocity', run ? fmtSi('velocity', prefs.units.velocity, run.maxVelocity) : '—',
              run ? prefs.units.velocity : undefined)}
          </div>

          <button className="fly-motor" onClick={onChangeMotor}
            title="Pick or swap motors in the Motors & Launch workspace">
            <span>
              <span className="stat-label">Motor</span>
              <span className="fly-motor-name">{motorLabel ?? 'none loaded'}</span>
            </span>
            <span className="fly-go">Change ▸</span>
          </button>

          <div className="fly-conditions field-grid">
            <LaunchField label="Rod length" field="launchRodLengthM" value={launch}
              onChange={onLaunchChange} stepStored={0.1} min={0} />
            <LaunchField label="Rod angle" field="launchRodAngleDeg" value={launch}
              onChange={onLaunchChange} stepStored={1} min={-30} max={30} />
            <LaunchField label="Wind avg" field="windAverage" value={launch}
              onChange={onLaunchChange} stepStored={0.5} min={0} />
          </div>

          {canCompare && (
            <button className="fly-compare" onClick={onCompare}
              title="Batch-simulate every motor that fits — which of your range box flies this best today?">
              ⚖ Compare the motors in your range box <span className="fly-go">▸</span>
            </button>
          )}
        </div>
      </div>

      <button className="launch-btn fly-launch" onClick={onLaunch} disabled={!canLaunch || simulating}
        title={!canLaunch ? 'Assign a motor first (Motors & Launch)' : 'Simulate the flight'}>
        {simulating ? 'Simulating…' : <><Icon name="rocket" size={17} /> Launch</>}
      </button>
    </main>
  );
}
