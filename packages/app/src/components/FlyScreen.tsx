import { savedConfigLabel, type SavedConfig } from '../model/design.js';
import { recordedConfiguration, runConfigurationLabel } from '../services/runConfiguration.js';
import { noSavedConfigurationsText } from '../services/flightState.js';
import { LaunchOverrideWarning, type LaunchOverrideProps } from './LaunchOverrideWarning.js';
import { GroundWindNote } from './GroundWindNote.js';
import { windProfileSummary } from '../services/windProfile.js';
import type { RocketTree, StaticInfo } from '@online-openrocket/engine';
import { usePrefs } from '../prefs/PrefsContext.js';
import { weatherPlaceLabel } from '../services/coordinates.js';
import { motorLabel } from '../services/motorDb.js';
import { fmtSi } from '../prefs/units.js';
import { recoveryMassTitle, type RecoveryMass } from '../services/recoveryMass.js';
import {
  formatRunWhenProse, formatStability, hasAerodynamicForce, describeRunChanges, shownStability, type SimRun,
} from '../services/simReport.js';
import type { WeatherSnapshot } from '../services/weatherSnapshot.js';
import { Icon } from './Icon.js';
import {
  hasLaunchGuides, rodLengthHelp, LaunchField, ROD_AIM_DEG_RANGE, ROD_AIM_HELP, ROD_ANGLE_DEG_RANGE, ROD_LENGTH_M_RANGE, WIND_MS_RANGE,
  type LaunchConditions,
} from './LaunchPanel.js';
import { WeatherButton } from './WeatherButton.js';
import { WeatherCredit } from './WeatherCredit.js';
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
  onLaunch, simulating, overrideSummary, onShowOverride, recovery, canLaunch, onChangeMotor, onCompare, canCompare,
  staleModel, changedSince, onGetWeather, weather, configs = [], activeConfigId = null,
  hasWorkingSettings = false, onApplyConfig, onClearConfig }: LaunchOverrideProps & {
  configs?: SavedConfig[];
  activeConfigId?: string | null;
  hasWorkingSettings?: boolean;
  onApplyConfig?: (config: SavedConfig) => void;
  onClearConfig?: () => void;
  tree: RocketTree;
  info: StaticInfo | null;
  /** The newest flight (current result's summary, else the last stored run). */
  run: SimRun | null;
  motorLabel: string | null;
  launch: LaunchConditions;
  onLaunchChange: (v: LaunchConditions) => void;
  onLaunch: () => void;
  simulating: boolean;
  /**
   * What comes down under the chute for the motor now loaded — the number a
   * canopy is sized on, and one this screen exists to put in front of someone
   * standing at the pad. Omitted = not computed (no build).
   */
  recovery?: RecoveryMass;
  canLaunch: boolean;
  /** "Change ▸" — jumps to the Motors & Configuration workspace. */
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
  /**
   * What has changed since the shown run was flown, the model excepted (it
   * has its own note): App's `changedSinceNonModel`. Empty or null = nothing
   * to say, or it cannot be told.
   *
   * Without it, a run picked in Saved simulations showed its apogee, optimum
   * delay and descent here unmarked beside a different rocket or motor — on
   * the screen whose optimum delay is the number people set at the pad, and
   * next to a Recovery-weight tile that follows the motor loaded NOW, so the
   * tiles disagreed with each other (audit 2026-09-22).
   */
  changedSince?: readonly string[] | null;
  /**
   * Opens App's ☁ Get weather dialog (weather build, step 3) — the pad is
   * where a phone user wants the day's weather. The same dialog and the same
   * Apply as the Launch panel's; σ is never among what it writes, here or
   * there, and this screen offers no gust estimate.
   */
  onGetWeather?: () => void;
  /** Applied weather, for its credit line — Open-Meteo's licence asks for one wherever its numbers are shown. */
  weather?: WeatherSnapshot | null;
}) {
  const { prefs } = usePrefs();
  const stab = info && hasAerodynamicForce(info)
    ? stabilityGlyphClass(shownStability(info)) : null;
  const descent = run ? (run.landingRate ?? run.groundHitVelocity) : null;

  const stat = (label: string, value: string, unit?: string, opts?: { muted?: boolean; title?: string }) => (
    <div className="fly-stat" title={opts?.title}>
      <div className="stat-label">{label}</div>
      <div className={`stat-value${opts?.muted ? ' stat-value-muted' : ''}`}>
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
            <span aria-hidden="true">{stab.glyph}</span><span className="sr-only">{stab.label} </span> {formatStability(info, prefs.stabilityUnit)}
          </span>
        )}
      </div>

      <div className="fly-main">
        <div className="fly-rocket rocket-stage">
          <div className="fly-view">
            {/* No onSelect: this drawing is a picture. A no-op one still made
                every drawn part a focusable "Select …" button, hidden inside
                the role="img" svg — a dead tab stop per part before the
                flight numbers (audit 2026-09-22).
                No motors and no onPatchNode either, rather than `{}` and a
                no-op (audit 2026-09-30): the drawing's layout is memoised on
                `motors`, so a fresh `{}` per render walked the whole design
                again on every FlyScreen render — every keystroke in the launch
                fields below, on the phone. Absent draws the same: no motor
                cases, and a vertical drawing never drags a part. */}
            <TreeSchematic
              tree={tree}
              info={info}
              selectedId={null}
              maxHeight={430}
              vertical
            />
          </div>
        </div>

        <div className="fly-col">
          <div role="status" className={staleModel ? undefined : 'sr-only'}>{staleModel && (
            // Same rule as the Results tab: a flight kept across a model
            // switch is MARKED, never silently re-read under the new model.
            <p className="fly-stale message-tier message-caution">
              ⚠ Flown on <strong>{staleModel}</strong>, not the model now
              selected — press Launch to re-fly.
            </p>
          )}</div>
          <div role="status" className={run && changedSince && changedSince.length > 0 ? undefined : 'sr-only'}>{run && changedSince && changedSince.length > 0 && (
            // The Results tab's provenance note, phone-sized: what flew, and
            // what is different now. The motor is named because the Motor row
            // below shows the one loaded now, which may not be it.
            <p className="fly-stale message-tier message-caution">
              ⚠ Flown with{' '}
              <strong>{flownMotorLabel(run)}</strong>{' '}
              {formatRunWhenProse(run.when)} — <strong>{describeRunChanges(changedSince)}</strong>.
              {' '}Press Launch to fly the current design.
            </p>
          )}</div>
          <div className="fly-stats">
            {stat('Apogee', run ? fmtSi('altitude', prefs.units.altitude, run.maxAltitude) : '—',
              run ? prefs.units.altitude : undefined)}
            {stat('Optimum delay', typeof run?.optimumDelayS === 'number' && Number.isFinite(run.optimumDelayS) ? run.optimumDelayS.toFixed(1) : '—',
              Number.isFinite(run?.optimumDelayS) ? 's' : undefined)}
            {stat('Descent', descent != null ? fmtSi('velocity', prefs.units.velocity, descent) : '—',
              descent != null ? prefs.units.velocity : undefined)}
            {stat('Max velocity', run ? fmtSi('velocity', prefs.units.velocity, run.maxVelocity) : '—',
              run ? prefs.units.velocity : undefined)}
            {/*
              Recovery weight — the dry rocket plus the SPENT casing, not the
              pad weight. It needs no flight, only a motor, so unlike the four
              above it reads the moment a motor is chosen: this screen is where
              motors get swapped at the pad, and swapping one changes the mass
              the chute has to hold. See services/recoveryMass.ts for the
              8.786 kg vs 11.7 kg case behind it.
            */}
            {recovery && stat(
              recovery.state === 'ok' && recovery.estimate ? 'Recovery weight (estimate)' : 'Recovery weight',
              recovery.state === 'ok' ? fmtSi('mass', prefs.units.mass, recovery.mass)
                : recovery.state === 'no-motor' ? 'load a motor' : '—',
              recovery.state === 'ok' ? prefs.units.mass : undefined,
              { muted: recovery.state !== 'ok', title: recoveryMassTitle(recovery) },
            )}
          </div>

          {/* No flight yet, no line: "Not recorded" is about a run that exists
              and did not record its configuration (review of b9-int). */}
          {run && <p className="download-caption">
            {recordedConfiguration(run) !== undefined
              ? `Flight: ${runConfigurationLabel(run)} · ${formatRunWhenProse(run.when)}` : 'Not recorded'}
          </p>}
          <label className="field" style={{ minWidth: 0 }}>
            Configuration:
            <select aria-label="Flight configuration" style={{ width: '100%', minWidth: 0 }}
              value={activeConfigId !== null && configs.some(c => c.id === activeConfigId) ? `config:${activeConfigId}` : hasWorkingSettings ? 'working' : 'none'}
              onChange={e => {
                if (e.target.value === 'none') onClearConfig?.();
                else {
                  const config = configs.find(c => `config:${c.id}` === e.target.value);
                  if (config) onApplyConfig?.(config);
                }
              }}>
              {configs.map(c => <option key={c.id} value={`config:${c.id}`}>
                {savedConfigLabel(c)}{c.isDefault ? ' — file default' : ''}
              </option>)}
              {hasWorkingSettings && !configs.some(c => c.id === activeConfigId)
                && <option value="working" disabled>Working settings (not saved)</option>}
              <option value="none">None (no motors)</option>
            </select>
          </label>
          {configs.length === 0 && hasWorkingSettings && <p className="download-caption">
            {noSavedConfigurationsText({ configs: 0, working: true, hasMotors: motorLabel !== null })}
          </p>}
          <button className="fly-motor" onClick={onChangeMotor}
            title="Pick or swap motors in the Motors & Configuration workspace">
            <span>
              <span className="stat-label">Motor</span>
              <span className="fly-motor-name">{motorLabel ?? 'none loaded'}</span>
            </span>
            <span className="fly-go">Change ▸</span>
          </button>

          {/* The pad-side conditions, in the panel's own bounds (the *_RANGE
              arrays, not literals). Rod aim (weather build, step 2; decision
              D2) pairs with the Rod angle it only matters with — someone at the
              rail knows which way it leans — so the two-column grid reads
              (Rod angle, Rod aim), (Rod length, Wind avg). No σ here, and no
              gust estimate: the Fly screen never writes σ. */}
          <div className="fly-conditions field-grid">
            <LaunchField label="Rod angle" field="launchRodAngleDeg" value={launch}
              onChange={onLaunchChange} stepStored={1} min={ROD_ANGLE_DEG_RANGE[0]} max={ROD_ANGLE_DEG_RANGE[1]} />
            <LaunchField label="Rod aim" field="launchRodAimDeg" value={launch}
              onChange={onLaunchChange} stepStored={15} min={ROD_AIM_DEG_RANGE[0]} max={ROD_AIM_DEG_RANGE[1]}
              absentStored={0} help={ROD_AIM_HELP} />
            <LaunchField label="Rod length" field="launchRodLengthM" value={launch}
              onChange={onLaunchChange} stepStored={0.1} min={ROD_LENGTH_M_RANGE[0]}
              help={rodLengthHelp(hasLaunchGuides(tree), launch.launchGuideAllowance)} />
            <LaunchField label="Wind avg" field="windAverage" value={launch}
              onChange={onLaunchChange} stepStored={0.5} min={WIND_MS_RANGE[0]} />
            <GroundWindNote wind={launch.windAverage} />
          </div>
          <p className="weather-small">{hasLaunchGuides(tree)
            ? `Lug and rail-button allowance ${launch.launchGuideAllowance === false ? 'off: the full entered length is used' : 'on: enter the real rod or rail length'}. Change it under Launch conditions.`
            : rodLengthHelp(false)}</p>
          {!!launch.windLevels?.length && <p className="weather-small">Winds aloft: {windProfileSummary(launch.windLevels, prefs.units.altitude)}. Wind avg is the surface wind.</p>}
          {(onGetWeather || weather) && (
            <div className="fly-weather">
              {onGetWeather && <WeatherButton onClick={onGetWeather} />}
              {weather && (
                <span>
                  Weather for {weatherPlaceLabel(weather.place)} —{' '}
                  {/* A searched place's name is GeoNames data, shown right here,
                      so it carries their credit too — as the Launch panel's
                      strip does. */}
                  <WeatherCredit geoNames={weather.place.method === 'search'} />
                </span>
              )}
            </div>
          )}

          {canCompare && (
            <button className="fly-compare" onClick={onCompare}
              title="Batch-simulate every motor that fits — which of your range box flies this best today?">
              ⚖ Compare the motors in your range box <span className="fly-go">▸</span>
            </button>
          )}
        </div>
      </div>

      <button className="launch-btn fly-launch" onClick={onLaunch} aria-describedby={overrideSummary ? 'launch-override-fly' : undefined} disabled={!canLaunch || simulating}
        title={!canLaunch ? 'Assign a motor first (Motors & Configuration)' : 'Simulate the flight'}>
        {simulating ? 'Simulating…' : <><Icon name="rocket" size={17} /> Launch</>}
      </button>
      <LaunchOverrideWarning id="launch-override-fly" summary={overrideSummary} onShow={onShowOverride} />
    </main>
  );
}

/**
 * What flew, for the provenance note. A Batch COMBINATION run (`motorConfig`
 * 'mixed …', the test the batch table groups its sheets by) already carries
 * the whole multi-motor label in `motor` ("4× G80 + 2× F39") and a '+'-joined
 * manufacturer set, so the single-motor form read "AT+CTI 4× G80 + 2× F39-7",
 * with the delay hung on the last leg alone. It is named as the launch
 * report's header names it instead, with no delay.
 */
function flownMotorLabel(run: SimRun): string {
  if (run.motorConfig?.startsWith('mixed')) {
    return `${run.motor}${run.manufacturer ? ` (${run.manufacturer})` : ''}`;
  }
  return `${run.manufacturer ? `${run.manufacturer} ` : ''}${motorLabel(
    { designation: run.motorDesignation ?? run.motor ?? '—', manufacturerAbbrev: run.manufacturer }, run.delayS)}`;
}
