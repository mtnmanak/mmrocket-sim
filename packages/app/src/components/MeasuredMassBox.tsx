import { NumField } from './NumField.js';
import { UnitChip } from './UnitChip.js';
import { usePrefs } from '../prefs/PrefsContext.js';
import { fmtSi, niceStep, siToUi, uiToSi } from '../prefs/units.js';
import { solveBallast, type BallastSolution } from '../services/buildAllowance.js';

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
 */
export function MeasuredMassBox({
  bareMassKg, bareCgM, rocketLengthM, hasAllowance, measured, onChange, onApply,
  blockedBy, onPinStage,
}: {
  /** Computed dry mass with any existing allowance backed out (kg). */
  bareMassKg: number;
  /** Computed dry CG with any existing allowance backed out (m from nose tip). */
  bareCgM: number;
  rocketLengthM: number;
  hasAllowance: boolean;
  measured: { massKg: number | null; cgM: number | null };
  onChange: (next: { massKg: number | null; cgM: number | null }) => void;
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
}) {
  const { prefs } = usePrefs();
  const massSym = prefs.units.mass;
  const lenSym = prefs.units.length;

  const { massKg, cgM } = measured;
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
        Weigh and balance the airframe <strong>with the motor out</strong>, then type what you
        got. Nothing changes until you press the button.
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
