import { NumField } from './NumField.js';
import { UnitChip } from './UnitChip.js';
import { usePrefs } from '../prefs/PrefsContext.js';
import { fmtSi, niceStep, siToUi, uiToSi } from '../prefs/units.js';
import { solveBallast, type BallastSolution } from '../services/buildAllowance.js';
import type { HardwareMassResult } from '../services/hardwareMass.js';
import type { MeasuredFigures } from '../services/orkFile.js';

/**
 * "Measured mass & CG" (issues-2026-08-23a.md §5).
 *
 * Type what your scale and your balance point actually say; the box reports
 * the gap and offers one button to insert — or update — a mass component named
 * "Build allowance" at the station that closes it. The part masses underneath
 * stay honest, so you keep the per-component breakdown AND the diagnostic:
 * you learn that the build came out 60 g heavy, not merely that the total is
 * now right.
 *
 * AIRFRAME ONLY. The owner's call: people weigh a build on the bench with the
 * motor out, so both the measured figures and the computed ones they are
 * compared against exclude the motor.
 *
 * THE THIRD FIELD IS THE EXCEPTION, and it is used at once (2026-09-07). "Pad
 * weight (with motor)" is the whole rocket as it goes on the pad; the app
 * subtracts the dry rocket and the catalogue motor and carries what is left —
 * adapter, retainer, closure — on the motor. No button, because there is
 * nothing to decide: it is a measurement, not a model. The line under the
 * compare list says what was carried, on which mount, or why nothing was. The
 * arithmetic and the refusals live in services/hardwareMass.ts.
 */
export function MeasuredMassBox({
  bareMassKg, bareCgM, rocketLengthM, hasAllowance, measured, onChange, onApply,
  blockedBy, onPinStage, hardware, computedPadMassKg, motorLabel, mountName,
}: {
  /** Computed dry mass with any existing allowance backed out (kg). */
  bareMassKg: number;
  /** Computed dry CG with any existing allowance backed out (m from nose tip). */
  bareCgM: number;
  rocketLengthM: number;
  hasAllowance: boolean;
  measured: MeasuredFigures;
  onChange: (next: MeasuredFigures) => void;
  onApply: (solution: Extract<BallastSolution, { kind: 'ok' }>) => void;
  /**
   * The component whose mass override would swallow the ballast, when one
   * would. A stage with the subcomponents flag replaces the mass of everything
   * inside it, so a Build allowance placed there weighs nothing — and until
   * v0.074 pressing Apply did exactly that, silently. RASAero .CDX1 imports
   * pin every stage this way.
   */
  blockedBy?: { name?: string } | null;
  /**
   * Resolve the block by pinning the covering component to the measured
   * numbers instead — desktop OpenRocket's own move. Absent when the app
   * cannot do it unambiguously (more than one stage covered).
   */
  onPinStage?: () => void;
  /** What the build derived from the pad weight (App's buildResult.hardware). */
  hardware?: HardwareMassResult;
  /**
   * The pad field's placeholder: dry mass plus catalogue motor(s), kg — what
   * the app assumes with the field blank. Null when there is no motor, or the
   * motor carries no mass curve.
   */
  computedPadMassKg?: number | null;
  /** The primary mount's motor as the picker labels it ("AeroTech J540R"). */
  motorLabel?: string;
  /** The primary mount's name, for "carried as hardware on 75mm MMT". */
  mountName?: string;
}) {
  const { prefs } = usePrefs();
  const massSym = prefs.units.mass;
  const lenSym = prefs.units.length;

  const { massKg, cgM, padMassKg } = measured;
  const solution = massKg !== null && cgM !== null
    ? solveBallast({
      computedMassKg: bareMassKg,
      computedCgM: bareCgM,
      measuredMassKg: massKg,
      measuredCgM: cgM,
      rocketLengthM,
    })
    : null;

  const mass = (kg: number) => `${fmtSi('mass', massSym, kg)} ${massSym}`;
  const len = (m: number) => `${fmtSi('length', lenSym, m, 3)} ${lenSym}`;
  const signed = (v: number, f: (n: number) => string) => `${v >= 0 ? '+' : '−'}${f(Math.abs(v))}`;

  return (
    <div className="panel measured-box">
      <h2>Measured mass &amp; CG</h2>
      <p className="measured-hint">
        Weigh and balance the airframe <strong>with the motor out</strong> and type what you
        got; nothing changes until you press the button. Then weigh the whole rocket{' '}
        <strong>with the motor in</strong> — that number is used at once, to carry the adapter,
        retainer and closure the catalogue motor weight leaves out.
      </p>

      <div className="field-grid">
        <div className="field">
          <label htmlFor="measured-mass">
            Measured mass <UnitChip quantity="mass" />
          </label>
          {/* These two ids are what the labels above have always pointed at.
              Until NumField took an `id` they reached nothing — the wrapper
              div is not a labelable element — so clicking either label did
              nothing at all. An app-wide sweep for htmlFor with no matching id
              finds exactly these two; every other NumField in the app carries
              a label that was never wired in the first place and is named by
              `ariaLabel` instead. The ariaLabel stays here: it opens with the
              visible text, so it extends the name rather than replacing it. */}
          <NumField
            id="measured-mass"
            value={massKg === null ? undefined : siToUi('mass', massSym, massKg)}
            onCommit={(v) => onChange({
              ...measured,
              massKg: v === null ? null : uiToSi('mass', massSym, v),
            })}
            nullable
            step={niceStep(siToUi('mass', massSym, 0.005))}
            placeholder={fmtSi('mass', massSym, bareMassKg)}
            ariaLabel="Measured mass of the airframe, motor removed"
          />
        </div>
        <div className="field">
          <label htmlFor="measured-cg">
            Measured CG from nose tip <UnitChip quantity="length" />
          </label>
          <NumField
            id="measured-cg"
            value={cgM === null ? undefined : siToUi('length', lenSym, cgM)}
            onCommit={(v) => onChange({
              ...measured,
              cgM: v === null ? null : uiToSi('length', lenSym, v),
            })}
            nullable
            step={niceStep(siToUi('length', lenSym, 0.005))}
            placeholder={fmtSi('length', lenSym, bareCgM, 3)}
            ariaLabel="Measured balance point, measured from the nose tip"
          />
        </div>
        {/* Row 2 of the two-column grid, alone: this is a different kind of
            number from the pair above it (motor IN, used at once), and its
            own row reads that way. */}
        <div className="field">
          <label htmlFor="measured-pad">
            Pad weight (with motor) <UnitChip quantity="mass" />
          </label>
          <NumField
            id="measured-pad"
            value={padMassKg == null ? undefined : siToUi('mass', massSym, padMassKg)}
            onCommit={(v) => onChange({
              ...measured,
              padMassKg: v === null ? null : uiToSi('mass', massSym, v),
            })}
            nullable
            step={niceStep(siToUi('mass', massSym, 0.005))}
            placeholder={computedPadMassKg == null ? undefined : fmtSi('mass', massSym, computedPadMassKg)}
            ariaLabel="Weighed pad mass, motor installed"
          />
        </div>
      </div>

      <dl className="measured-compare">
        <div>
          <dt>Computed mass</dt>
          <dd>
            {mass(bareMassKg)}
            {massKg !== null && (
              <span className="measured-delta"> {signed(massKg - bareMassKg, (k) => mass(k))}</span>
            )}
          </dd>
        </div>
        <div>
          <dt>Computed CG</dt>
          <dd>
            {len(bareCgM)}
            {cgM !== null && (
              <span className="measured-delta"> {signed(cgM - bareCgM, (m) => len(m))}</span>
            )}
          </dd>
        </div>
      </dl>

      <p className="measured-hint measured-hardware">
        <HardwareLine hardware={hardware} mass={mass} motorLabel={motorLabel} mountName={mountName} />
      </p>

      {solution && <Verdict
        solution={solution}
        hasAllowance={hasAllowance}
        onApply={onApply}
        mass={mass}
        len={len}
        blockedBy={blockedBy ?? null}
        onPinStage={onPinStage}
      />}
    </div>
  );
}

function Verdict({ solution, hasAllowance, onApply, mass, len, blockedBy, onPinStage }: {
  solution: BallastSolution;
  hasAllowance: boolean;
  onApply: (s: Extract<BallastSolution, { kind: 'ok' }>) => void;
  mass: (kg: number) => string;
  len: (m: number) => string;
  blockedBy: { name?: string } | null;
  onPinStage?: () => void;
}) {
  switch (solution.kind) {
    case 'matches':
      return (
        <p className="measured-verdict measured-ok">
          Your build matches the model. Nothing to add.
        </p>
      );

    case 'ok': {
      // Ballast under a mass-overridden stage weighs nothing — say so instead
      // of offering a button that would do nothing. Same wording as the
      // Overrides rows in the property panel, so the two read as one rule.
      if (blockedBy) {
        const who = blockedBy.name || 'A stage above it';
        return (
          <>
            <p className="measured-verdict measured-bad">
              <strong>{who}</strong> stands in for the mass of everything inside it, so a
              Build allowance added here would weigh nothing.{' '}
              {onPinStage
                ? <>Either clear that mass override under <strong>Overrides</strong>, or pin
                  it to what you measured.</>
                // No pin offered: more than one stage is pinned, and what you
                // weighed is the whole airframe. There is no rule for which of
                // them should absorb the difference, and a wrong override is
                // worse than none.
                : <>You weighed the whole airframe and more than one stage is pinned, so there
                  is no telling which should carry the difference — clear the mass overrides
                  under <strong>Overrides</strong> and weigh again.</>}
            </p>
            {onPinStage && (
              <button className="file-btn measured-apply" onClick={onPinStage}>
                Pin “{who}” to my measured mass &amp; CG
              </button>
            )}
          </>
        );
      }
      return (
        <>
          <p className="measured-verdict measured-ok">
            {`Add ${mass(solution.massKg)} at ${len(solution.stationM)} from the nose tip.`}
          </p>
          <button className="file-btn measured-apply" onClick={() => onApply(solution)}>
            {hasAllowance ? 'Update “Build allowance”' : 'Add “Build allowance”'}
          </button>
        </>
      );
    }

    // The three cases below are the useful half of the feature: no ballast
    // anywhere on the rocket can reconcile these two numbers, which is a real
    // finding about the design, not an error to swallow.
    case 'cg-only':
      return (
        <p className="measured-verdict measured-bad">
          {`Your rocket weighs what the model says but balances ${len(Math.abs(solution.cgErrorM))} `}
          {solution.cgErrorM > 0 ? 'further back' : 'further forward'}
          {'. Adding mass cannot move the CG without also changing the total, so the '}
          <strong>distribution</strong> of your part masses is off, not the total.
        </p>
      );

    case 'overweight-model':
      return (
        <p className="measured-verdict measured-bad">
          {`Your rocket came out ${mass(solution.excessKg)} LIGHTER than the model. `}
          There is no negative ballast — something in the design is modelled heavier than
          you built it. Check the parts you guessed at.
        </p>
      );

    case 'unreachable':
      return (
        <p className="measured-verdict measured-bad">
          {`Closing this gap would need ${mass(solution.massKg)} at `}
          {len(solution.stationM)}
          {solution.stationM < 0 ? ' — ahead of the nose tip' : ' — behind the tail'}
          {', which is not on the rocket. Your measured mass and balance point cannot both be '}
          explained by added mass anywhere, so the part masses are wrong in their
          <strong> distribution</strong>, not just their total.
        </p>
      );
  }
}

/**
 * ONE line, in plain words, saying what the pad weight did — or why it did
 * nothing. Every number goes through `mass()` so it follows the unit
 * preference like the compare list above it; the carried figure gets the same
 * highlight as the deltas there. Each refusal names the catalogue motor it
 * subtracted, because "a different motor" is the likeliest cause and the user
 * cannot check that against a number they cannot see.
 */
function HardwareLine({ hardware, mass, motorLabel, mountName }: {
  hardware: HardwareMassResult | undefined;
  mass: (kg: number) => string;
  motorLabel: string | undefined;
  mountName: string | undefined;
}) {
  const motor = motorLabel ?? 'motor';
  const mount = mountName ?? 'the motor mount';
  // `motorMassKg` sums EVERY mount's catalogue motor, but `motorLabel` is the
  // primary's alone — so with two mounts the total must not sit beside one
  // motor's name ("catalogue J540R 1584 g" for a J540R plus a booster motor).
  const catalogue = (r: { mountCount: number }): string =>
    r.mountCount > 1 ? `catalogue motors on ${r.mountCount} mounts` : `catalogue ${motor}`;
  if (!hardware || (hardware.state === 'none' && hardware.why === 'no-pad-mass')) {
    return <>Enter the weighed pad mass to carry adapter, retainer and closure mass the catalogue motor weight leaves out.</>;
  }
  switch (hardware.state) {
    case 'none':
      return hardware.why === 'no-motor'
        ? <>Assign a motor to use the weighed pad mass — the hardware is what is left after the catalogue motor weight.</>
        : <>The catalogue motor carries no mass curve, so the hardware cannot be separated from it.</>;

    case 'implausible':
      return hardware.reason === 'negative'
        ? <>{`Weighed pad mass is ${mass(-hardware.deltaKg)} LIGHTER than the dry rocket plus the ${catalogue(hardware)} (${mass(hardware.motorMassKg)}) — a typo or a different motor. Nothing is carried.`}</>
        : <>{`That would carry ${mass(hardware.deltaKg)} as hardware — more than the airframe itself. A typo or a different motor; nothing is carried.`}</>;

    case 'ok':
      return (
        <>
          {`${hardware.mountCount > 1 ? 'Motors' : 'Motor'} and hardware: ${mass(hardware.motorMassKg + hardware.deltaKg)} weighed · ${catalogue(hardware)} ${mass(hardware.motorMassKg)} · `}
          <span className="measured-delta">{mass(hardware.deltaKg)}</span>
          {` carried as hardware on ${mount}`}
          {hardware.motorCount > 1 && ` (×${hardware.motorCount}, ${mass(hardware.perMotorShiftKg)} each)`}
          {` — dry mass ${hardware.drySource === 'measured' ? 'as you measured it' : 'as computed'}.`}
          {hardware.large && ' More than half the motor’s own weight — check the entry.'}
        </>
      );
  }
}
