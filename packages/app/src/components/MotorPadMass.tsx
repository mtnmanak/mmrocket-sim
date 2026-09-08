import { NumField } from './NumField.js';
import { UnitChip } from './UnitChip.js';
import { usePrefs } from '../prefs/PrefsContext.js';
import { fmtSi, niceStep, siToUi, uiToSi } from '../prefs/units.js';
import type { HardwareMassResult, MountChange } from '../services/hardwareMass.js';

/**
 * "Weighed pad mass with this motor" — the field under the PRIMARY mount's
 * motor on Motors & Launch (v0.118, 2026-09-08).
 *
 * v0.116 put this number in the Measured mass & CG box beside the two airframe
 * figures. Those are meant to survive a motor change; a pad weight cannot — it
 * is one rocket with one motor set and that set's adapter, retainer and
 * closure in it. So unloading the motor left the number showing, and loading a
 * different one left it showing and refused it in small print (Eric's two
 * screenshots, 2026-09-07). The value now lives on the motor's own record
 * (App's MountMotor.padMassKg, keyed to the set it was weighed with), and this
 * card renders it: unload the motor and the field goes with it; load a
 * different one and the field is blank for that motor, its placeholder showing
 * what the app assumes.
 *
 * No button — it is a measurement, not a model — so the line under the field
 * says what happened, every time: what was carried and against which
 * catalogue motor, or why nothing was. A value weighed with a set that is no
 * longer the loaded one (a booster swapped, a mount emptied or newly loaded,
 * a cluster count changed) is KEPT but rendered not-live: dimmed input,
 * aria-invalid, and the line names the motor it was weighed with and the one
 * now there. Putting the set back re-applies it. The arithmetic and every
 * refusal live in services/hardwareMass.ts; nothing is decided here.
 */
export function MotorPadMass({
  mountId, motorLabel, mountName, multiMotor, valueKg, legacyPending, onChange,
  computedPadMassKg, hardware, nameOfMount, describeIdentity, identityKey,
}: {
  mountId: string;
  /** The picker's label with its delay suffix stripped (App's baseLabel: "J460T", not "J460T-10"). */
  motorLabel: string;
  mountName: string;
  /**
   * More than one motor is in the rocket (another mount carries one, or this
   * mount is a cluster): label, help and the blank line say "with every motor
   * in" / "Re-weigh for each motor set."
   */
  multiMotor: boolean;
  /** mm.padMassKg ?? null (SI kg). */
  valueKg: number | null;
  /**
   * The record's key is LEGACY_PAD_MASS_KEY — a value carried in from a
   * v0.116/v0.117 session or file that App's reconcile effect has not yet
   * checked against the loaded motor. Render the field BLANK and the
   * blank-state line until it decides: a number that looks live and is about
   * to be refused is the thing v0.116 got wrong.
   */
  legacyPending: boolean;
  /** SI kg; null = cleared. */
  onChange: (kg: number | null) => void;
  /** App's memo: massEmpty + Σ catalogue motors, the whole rocket (kg). Null when unknown. */
  computedPadMassKg: number | null;
  /** built?.hardware — the arithmetic's verdict on the value. */
  hardware: HardwareMassResult | undefined;
  /** A mount's display name, for the 'stale-set' clauses. */
  nameOfMount: (id: string) => string;
  /**
   * A stored identity for display: 'AeroTech/I284W' → 'I284W'; 'ex:…' → the
   * EX library designation or the id; 'unmatched:K' → 'K (named by the file,
   * not loaded)'. App supplies it (loadExMotors lives outside pure code).
   */
  describeIdentity: (identity: string) => string;
  /**
   * What the input is keyed by: the motor's identity (App passes
   * motorIdentity(mm.meta, mm.spec.designation)), so the input REMOUNTS on a
   * motor swap — no local draft outlives the motor — but not on a delay edit,
   * which the identity excludes. Optional: `motorLabel` stands in when absent,
   * and being delay-stripped it remounts on the same events for every motor
   * whose base name is unique.
   */
  identityKey?: string;
}) {
  const { prefs } = usePrefs();
  const massSym = prefs.units.mass;
  const mass = (kg: number) => `${fmtSi('mass', massSym, kg)} ${massSym}`;

  const id = `pad-mass-${mountId}`;
  const lineId = `${id}-line`;
  const stale = hardware?.state === 'stale-set';
  const shown = legacyPending ? null : valueKg;
  // The promised help sentence, verbatim. It is a duplicate of what the
  // visible lines already say — a title does not show on touch, and the phone
  // Fly screen's "Change ▸" lands on this card — so nothing is ONLY here.
  const help = multiMotor
    ? 'Weigh the rocket ready to fly, with every motor in. Used at once; it carries the adapter, retainer and closure the catalogue motor weight leaves out. Re-weigh for each motor set.'
    : 'Weigh the rocket ready to fly, with this motor in. Used at once; it carries the adapter, retainer and closure the catalogue motor weight leaves out. Re-weigh for each motor.';

  return (
    <div className={`field${stale ? ' field-stale' : ''}`} style={{ marginTop: 6 }} title={help}>
      <label htmlFor={id}>
        {multiMotor ? 'Weighed pad mass with every motor in' : 'Weighed pad mass with this motor'}
        {' '}<UnitChip quantity="mass" />
      </label>
      {/* A numeric placeholder is what NumField's autoBase steps the spinner
          from — dry plus catalogue is exactly the number a blank field stands
          in for, so that is wanted. */}
      <NumField
        key={identityKey ?? motorLabel}
        id={id}
        value={shown === null ? undefined : siToUi('mass', massSym, shown)}
        onCommit={(v) => onChange(v === null ? null : uiToSi('mass', massSym, v))}
        nullable
        step={niceStep(siToUi('mass', massSym, 0.005))}
        placeholder={computedPadMassKg == null ? undefined : fmtSi('mass', massSym, computedPadMassKg)}
        ariaLabel={`Weighed pad mass with ${motorLabel}`}
        invalid={stale}
        describedBy={lineId}
      />
      <PadMassLine
        id={lineId}
        hardware={hardware}
        legacyPending={legacyPending}
        hasValue={shown !== null}
        multiMotor={multiMotor}
        mass={mass}
        motorLabel={motorLabel}
        mountName={mountName}
        computedPadMassKg={computedPadMassKg}
        nameOfMount={nameOfMount}
        describeIdentity={describeIdentity}
      />
    </div>
  );
}

/** The identity prefix App gives a motor the file named but could not load (spec §1.2). */
const UNMATCHED = 'unmatched:';

/**
 * One clause per mount that differs from the set the value was weighed with.
 * ✕ on a booster leaves the mount node in the tree, so an emptied mount is
 * 'missing', not 'changed' — a single "the motor on X is not the one" wording
 * would have been wrong for it.
 */
function staleClause(
  c: MountChange, nameOfMount: (id: string) => string, describe: (identity: string) => string,
): string {
  const M = nameOfMount(c.mountId);
  switch (c.kind) {
    case 'changed':
      return `weighed with ${describe(c.was)} on ${M}, which now has ${describe(c.now)}`;
    case 'missing':
      return c.was.startsWith(UNMATCHED)
        ? `the motor the file names for ${M} (${c.was.slice(UNMATCHED.length)}) is not loaded; the pad mass was weighed with it in — load it to use the pad mass`
        : `${M} has no motor now; it was weighed with ${describe(c.was)} in it`;
    case 'new':
      return `${M} has gained a motor (${describe(c.now)}) since the weighing`;
    case 'count':
      return `${M} now holds ${c.nowCount} motor${c.nowCount === 1 ? '' : 's'}; it was weighed with ${c.wasCount}`;
  }
}

/**
 * ONE paragraph, in plain words, saying what the pad weight did — or why it
 * did nothing. Every number goes through `mass()` so it follows the unit
 * preference; the carried figure gets the same highlight as the deltas in the
 * Measured mass & CG box. Plain states are `.comp-stats`; refusals and a stale
 * set are the card's warn style with role="status" — polite, never `alert`:
 * NumField commits on every valid keystroke, and typing 10574 g passes through
 * four refused intermediates on the way.
 */
function PadMassLine({
  id, hardware, legacyPending, hasValue, multiMotor, mass, motorLabel, mountName, computedPadMassKg,
  nameOfMount, describeIdentity,
}: {
  id: string;
  hardware: HardwareMassResult | undefined;
  legacyPending: boolean;
  /** The input shows a number (a value, not legacy-pending). */
  hasValue: boolean;
  multiMotor: boolean;
  mass: (kg: number) => string;
  motorLabel: string;
  mountName: string;
  computedPadMassKg: number | null;
  nameOfMount: (id: string) => string;
  describeIdentity: (identity: string) => string;
}) {
  const plain = (text: string) => <p id={id} className="comp-stats" style={{ margin: '3px 0 0' }}>{text}</p>;
  const warn = (text: string) => <p id={id} className="print-note print-note-warn" role="status">{text}</p>;
  // `motorMassKg` sums EVERY mount's catalogue motor, but `motorLabel` is the
  // primary's alone — so with two mounts the total must not sit beside one
  // motor's name ("catalogue J540R 1584 g" for a J540R plus a booster motor).
  const catalogue = (r: { mountCount: number }): string =>
    r.mountCount > 1 ? `catalogue motors on ${r.mountCount} mounts` : `catalogue ${motorLabel}`;

  const noPadMass = hardware?.state === 'none' && hardware.why === 'no-pad-mass';
  // A number in the input must never sit over "Blank —". Without a build
  // (`built` null on a build error) the value is not applied and the line
  // says so; a build that saw no pad mass while the input shows one cannot
  // happen — App reads the same record the field does — but the guard is
  // cheap and the wrong sentence is the v0.116 class (2026-09-08 review).
  if (!legacyPending && hasValue && (!hardware || noPadMass)) {
    return warn(hardware
      ? 'Not applied yet — the next build checks it.'
      : 'Not applied — the design could not be built; fix the error above and the pad mass applies again.');
  }
  if (legacyPending || !hardware || noPadMass) {
    const onPad = computedPadMassKg == null ? '' : `, ${mass(computedPadMassKg)} on the pad`;
    return plain(`Blank — flying at the catalogue motor weight${onPad}. Weigh the rocket ready to fly, with ${multiMotor ? 'every motor' : 'this motor'} in, and type it here: it is used at once and carries the adapter, retainer and closure the catalogue weight leaves out. Re-weigh for each motor${multiMotor ? ' set' : ''}.`);
  }
  switch (hardware.state) {
    case 'none':
      return plain(hardware.why === 'no-motor'
        ? 'The simulation kernel refused this motor\'s curve, so there is nothing to subtract the pad mass from — nothing is carried.'
        : 'The catalogue motor carries no mass curve, so the hardware cannot be separated from it.');

    case 'stale-set': {
      const clauses = hardware.changes.map((c) => staleClause(c, nameOfMount, describeIdentity));
      // changedMounts never returns an empty list for two keys that differ,
      // but a line reading "Not applied — ." would be worse than a vague one.
      const why = clauses.length > 0 ? clauses.join('; ') : 'weighed with a different motor set';
      return warn(`Not applied — ${why}. Re-weigh with these motors in and type it again, or clear the field.`);
    }

    // The two v0.116 refusal sentences, verbatim. Each names the catalogue
    // motor it subtracted, because "a different motor" is the likeliest cause
    // and the user cannot check that against a number they cannot see.
    case 'implausible':
      return warn(hardware.reason === 'negative'
        ? `Weighed pad mass is ${mass(-hardware.deltaKg)} LIGHTER than the dry rocket plus the ${catalogue(hardware)} (${mass(hardware.motorMassKg)}) — a typo or a different motor. Nothing is carried.`
        : `That would carry ${mass(hardware.deltaKg)} as hardware — more than the airframe itself. A typo or a different motor; nothing is carried.`);

    case 'ok':
      return (
        <p id={id} className="comp-stats" style={{ margin: '3px 0 0' }}>
          <span className="measured-delta">{mass(hardware.deltaKg)}</span>
          {` carried as hardware — adapter, retainer, closure: ${mass(hardware.dryMassKg + hardware.motorMassKg + hardware.deltaKg)} weighed − dry ${mass(hardware.dryMassKg)} ${hardware.drySource === 'measured' ? 'as you measured it' : 'as computed'} − ${catalogue(hardware)} ${mass(hardware.motorMassKg)}.`}
          {hardware.mountCount > 1 && ` Carried on ${mountName}.`}
          {hardware.motorCount > 1 && ` (×${hardware.motorCount}, ${mass(hardware.perMotorShiftKg)} each)`}
          {hardware.large && ' More than half the motor’s own weight — check the entry.'}
          {/* With motors on more than one mount the weighing was of the SET,
              and a booster swap stops it applying just as a sustainer swap
              does — naming one motor with "if you change it" would read as the
              sustainer alone. A cluster is one motor type, so the singular holds. */}
          {hardware.mountCount > 1
            ? ` Weighed with ${motorLabel} and the rest of this motor set; re-weigh if any of them changes. The next Launch flies it.`
            : ` Weighed with ${motorLabel}; re-weigh if you change it. The next Launch flies it.`}
        </p>
      );
  }
}
