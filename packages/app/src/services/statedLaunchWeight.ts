import type { ComponentNode, RocketTree } from '@online-openrocket/engine';

/**
 * A stage mass/CG override that STILL CONTAINS a motor's weight, and putting
 * it right the moment that motor is loaded. (2026-09-08.)
 *
 * WHAT WENT WRONG. The RASAero importer applies the author's own stated stage
 * launch weight as a stage override with the motor backed out
 * (`rasaeroFile.ts`, "measured launch weight + CG -> stage mass/CG
 * overrides"). When the file names a motor the catalogue does not have, there
 * is no weight to back out: nothing is mounted on that stage, so the stated
 * figure describes the rocket as it will actually fly here, and the importer
 * applies it whole and says so in its note ("the stated 23.310 lb is used as
 * it stands — it still includes that motor's weight").
 *
 * That is right until the user loads the motor — an EX motor through Browse
 * motor database, or a catalogue that later gains the row. Then the motor's
 * mass is added ON TOP of an override that already holds it, and nothing on
 * screen contradicts the result.
 *
 * MEASURED on `MESOS_Last_Preflight_File.CDX1` (2026-09-08), the file whose
 * author published the flight: the two stages import at 23.310 lb and
 * 63.740 lb, 87.050 lb together, which is exactly the launch weight the file
 * states. Load the two EX motors it names (M787 6.972 kg, O4374 24.394 kg,
 * from the author's own .eng files) and the rocket weighs 70.851 kg — 156 lb
 * against the file's own 87 lb, +79 % — and flies about a fifth of the real
 * altitude. Neither number is announced anywhere.
 *
 * The CG is wrong the same way and for the same reason: the stated CG is the
 * LAUNCH CG, motors included, so the override already carries the motor's
 * moment and the mounted motor's moment is added on top of it.
 *
 * WHAT THIS DOES. The importer marks such a stage with the designation of the
 * motor whose weight is still inside its overrides ({@link
 * OVERRIDE_INCLUDES_MOTOR}). When a motor is later assigned to a mount in that
 * stage, {@link reconcileIncludedMotor} does the subtraction the importer
 * could not: mass override −= the motor's launch mass, CG override
 * back-transformed against the motor, and the mark removed so it can never
 * fire twice. Everything it changes, it says in one plain-English note.
 *
 * WHERE THE MOTOR'S CG IS TAKEN TO BE, and the one place this and the importer
 * are not the same arithmetic (corrected 2026-09-08, from review). The
 * importer's `cgWithoutMotor` puts the motor's CG at its geometric MIDPOINT
 * (`motorFrontX + motor.lengthM / 2`) because a `MOTOR_DB` row publishes no
 * CG; this function uses `spec.cgX`, which is the loaded motor's own figure.
 * The two agree today only because nothing in the app publishes a real motor
 * CG either: `thrustcurve.ts` synthesises `cgX = length / 2` on BOTH paths, the
 * catalogue row (l. 584) and the EX `.eng`/`.rse` import (l. 795). If a source
 * ever supplies a measured CG — `.rse` files carry one — the import path and
 * the load-later path would silently disagree about the same design, and the
 * leverage is large: on MESOS's booster the mass ratio a/b is 24.394/4.518 =
 * 5.4, so 34 mm of assumed motor CG moves the stage's CG override by ~7 in. A
 * test pins the coincidence (`statedLaunchWeight.test.ts`, "the motor CG both
 * halves assume"); when it fails, `rasaeroFile.cgWithoutMotor` is what has to
 * learn the real CG, not this.
 *
 * WHY A MARK RATHER THAN A DERIVED TEST. "This mount had an unresolved motor
 * reference and its stage has a mass override" is nearly the same condition
 * and is wrong for desktop OpenRocket files: a desktop stage override is a
 * DRY structure mass with the motor already outside it, so subtracting there
 * would make the rocket too light. Only this importer creates the
 * motor-inclusive state, so only this importer may mark it.
 *
 * WHY NOT REFUSE THE STATED WEIGHT INSTEAD. Refusing would send those designs
 * back to the fabricated 2 mm-wall mass, which put 36 of 39 corpus files under
 * HALF their own stated weight and aborted 17 flights on static instability
 * (docs/research/trf-file-corpus-2026-08-25.md §1). The stated weight is right
 * for the rocket as imported; it is only the later motor that breaks it.
 *
 * ONLY THE MOTOR THE MARK NAMES MAY BE BACKED OUT (2026-09-08, from review —
 * this replaces the rule v0.120 shipped, which backed out whatever motor
 * arrived). `stated − loadedMotor` is the airframe ONLY when the loaded motor
 * is the one still inside `stated`. Load any other and the subtraction is
 * arithmetic on two unrelated numbers, and it is not a small error:
 *
 *   MEASURED on `PePe2.CDX1` (2026-09-08). Eight simulations, each with its
 *   own stated launch weight for the same airframe-plus-motor: 47 lb with
 *   N5800-CS (which the catalogue does not have, so the stage imports marked),
 *   24.2 lb with M1297W, 19.7 lb with K510. Open it and switch to simulation 6
 *   and v0.120 wrote 47 − 10.22 = 36.78 lb as "airframe" against that
 *   simulation's own ~13.98 lb, flew the rocket at 47.0 lb against the file's
 *   own 24.2 (+94 %), called it 'info', and spent the mark so no later route
 *   could put it right.
 *
 * So a motor that is not the one named cannot correct the figure — and the
 * figure it arrives on top of is a launch weight holding a motor the rocket is
 * not carrying, which is 30–50 % of that weight on these files. Both overrides
 * are CLEARED and the stage falls back to its computed geometry, with a note
 * that quotes the file's own number so the user can type it back. That is the
 * same "a wrong override is worse than none" ruling the two refusal branches
 * below already run on, and the same one the import block itself runs on.
 *
 * THE LIMIT THAT LEAVES, stated rather than hidden. A RASAero file states a
 * launch weight PER SIMULATION, and only the applied one is read at import
 * (`rasaeroFile.ts`, "WHICH SIMULATION'S NUMBERS"). Nothing carries the other
 * simulations' weights, so switching flight configuration cannot re-derive the
 * new simulation's stage mass — it can only decline to use the old one. Fixing
 * that means carrying each configuration's stated weights AND re-running the
 * importer's whole per-stage override pass (stack-above subtraction, motor CG
 * placement) on every switch; it is a feature, not a review fix, and it is
 * logged rather than half-built here.
 */

/**
 * Node key on a STAGE: the designation of the motor whose weight is still
 * inside this stage's `overrideMass` (and `overrideCGX`, when it has one).
 * A plain string so it round-trips through the .ork writer as one element.
 */
export const OVERRIDE_INCLUDES_MOTOR = 'overrideIncludesMotor';

/** The motor being assigned, straight off its `MotorSpec`. */
export interface AttachedMotor {
  /** What the user actually loaded — may differ from the motor the file named. */
  designation: string;
  /** Loaded mass at t = 0 (kg): `spec.masses[0]`. */
  launchMassKg: number;
  /** Overall length (m): `spec.length`. */
  lengthM: number;
  /** CG from the motor's leading end (m): `spec.cgX`. */
  cgXFromFrontM: number;
}

/** Unit-aware formatters, injected — this module holds no unit preference. */
export interface StatedWeightText {
  mass: (kg: number) => string;
  length: (m: number) => string;
}

export interface ReconciledStatedWeight {
  /** The tree with the stage's overrides corrected and the mark removed. */
  tree: RocketTree;
  /** What changed and what to do about it; null when nothing needed saying. */
  note: string | null;
  severity: 'info' | 'warn';
}

/** The stage node that CONTAINS this mount, and its index; null when none. */
function stageOf(tree: RocketTree, mountId: string): { stage: ComponentNode; index: number } | null {
  const holds = (n: ComponentNode): boolean =>
    n.id === mountId || (n.children ?? []).some(holds);
  const index = tree.components.findIndex((s) => (s.children ?? []).some(holds));
  const stage = index === -1 ? undefined : tree.components[index];
  return stage ? { stage, index } : null;
}

/**
 * A node's own axial length, 0 when it carries none.
 *
 * SHARED WITH THE IMPORTER (2026-09-08, from review). `rasaeroFile.ts` held
 * its own copy of this, of {@link stageLength} and of {@link cgFromCombined},
 * and the two halves of one calculation cannot be allowed to drift: the
 * importer writes `overrideCGX` in the frame these functions define and this
 * module reads it back in the same frame. They live here because the import
 * already depends on this module (for {@link OVERRIDE_INCLUDES_MOTOR}) and not
 * the other way round.
 */
export const nodeLength = (n: ComponentNode): number =>
  typeof n['length'] === 'number' ? (n['length'] as number) : 0;

/** A stage's own length: its DIRECT children only, so pods add nothing. */
export const stageLength = (st: ComponentNode | undefined): number =>
  (st?.children ?? []).reduce((sum, c) => sum + nodeLength(c), 0);

/**
 * Do these two strings name the same motor?
 *
 * MIRRORS `motorDb.findDbMotor`'s rank-0 and rank-1 rules deliberately: a
 * motor only reaches a marked stage because that matcher paired the file's
 * designation with a catalogue row (or because the user loaded an `.eng` whose
 * header carries the file's own designation), so the test for "this IS the
 * motor the file named" has to be the same test that put it there. Case and
 * surrounding space are ignored; a leading `HP-` and a Cesaroni impulse prefix
 * are stripped, so the file's “N5800-CS” still matches the catalogue's
 * “5800N5800-CS”; and a delay suffix on either side is tolerated, so “I224” in
 * the file matches “I224-15A” in the catalogue.
 *
 * THE PREFIX MATCH MAY NOT CUT A NUMBER IN HALF (2026-09-08, from review). It
 * was `x.startsWith(y) || y.startsWith(x)` with no floor at all, so “M1297W”
 * matched “M1” and “M787” matched “M7871” — a mark naming a short designation
 * would let an unrelated motor of the same impulse letter be treated as the one
 * still inside the stated weight and subtracted from it. A delay suffix always
 * begins with a delimiter (“I224-15A”) or a propellant letter (“I224W”), never
 * with another digit, so the guard is exactly that: the character after the
 * prefix in the longer string must not be a digit. No pair in the shipped
 * 1,155-row catalogue was affected either way; this closes the shape, not a
 * reported bug.
 *
 * Kept as string comparison rather than a `findDbMotor` call so this module
 * stays free of the 1,155-row catalogue — `orkFile.ts` imports it, and the
 * .ork reader has no business pulling in `motors.json`.
 */
export function namesSameMotor(a: string, b: string): boolean {
  const norm = (d: string): string =>
    d.trim().toLowerCase().replace(/^hp-/, '').replace(/^\d+(?=[a-o]\d)/, '');
  const x = norm(a);
  const y = norm(b);
  if (x === '' || y === '') return false;
  if (x === y) return true;
  const [short, long] = x.length < y.length ? [x, y] : [y, x];
  return long.startsWith(short) && !/\d/.test(long.charAt(short.length));
}

/**
 * The designation of the motor still inside this stage's overrides, or null.
 * `mountId` may be any node in the stage. Cheap enough for the assignment
 * path: one findIndex over the stage list.
 */
export function includedMotorOf(tree: RocketTree, mountId: string): string | null {
  const found = stageOf(tree, mountId);
  const mark = found?.stage[OVERRIDE_INCLUDES_MOTOR];
  return typeof mark === 'string' && mark !== '' ? mark : null;
}

/** Replaces one stage node, allowing keys to be DELETED (updateNode cannot). */
function replaceStage(tree: RocketTree, index: number, next: ComponentNode): RocketTree {
  return { ...tree, components: tree.components.map((s, i) => (i === index ? next : s)) };
}

/**
 * Desktop `getCGFromCombinedCG` (SimulationHandler.java:487-492): the CG of B
 * given A's CG, the combined CG of A+B, and both masses. `bMass > 0` is the
 * caller's to check — desktop does not, and divides by a stage mass of zero
 * whenever the override above it was skipped.
 *
 * The import (`rasaeroFile.ts`) and this module run the SAME back-transform in
 * opposite directions, so they share one copy of it — see {@link nodeLength}.
 */
export const cgFromCombined = (
  aMass: number, bMass: number, aCg: number, combinedCg: number,
): number => combinedCg * (1 + aMass / bMass) - aCg * (aMass / bMass);

/**
 * Takes a newly assigned motor's weight back out of the stage overrides that
 * still contain it. Returns null — the overwhelmingly common case — when the
 * mount's stage carries no mark, so the caller pays one tree scan and nothing
 * else.
 *
 * ONLY the motor the mark names is backed out ({@link namesSameMotor}); any
 * other one clears the overrides instead, for the reason measured in the module
 * header. Callers that hold several mounts must offer the matching one FIRST —
 * {@link reconcileAllIncludedMotors} does.
 *
 * The mark is removed on EVERY path that returns, including the refusals: once
 * a motor is on the stage the stated launch weight has been spent, and a mark
 * left behind would fire again on the next motor.
 */
export function reconcileIncludedMotor(
  tree: RocketTree,
  mountId: string,
  motor: AttachedMotor,
  text: StatedWeightText,
): ReconciledStatedWeight | null {
  const found = stageOf(tree, mountId);
  if (!found) return null;
  const { stage, index } = found;
  const named = stage[OVERRIDE_INCLUDES_MOTOR];
  if (typeof named !== 'string' || named === '') return null;

  const {
    [OVERRIDE_INCLUDES_MOTOR]: _mark, ...unmarked
  } = stage as ComponentNode & Record<string, unknown>;
  const cleared = unmarked as ComponentNode;
  const name = stage.name ?? 'Stage';
  const who = `“${named}”`;

  const stated = cleared['overrideMass'];

  // ---- a motor that is NOT the one the mark names (2026-09-08, from review) ----
  // Nothing here can be corrected: the figure holds `named`, whose weight is
  // the one thing this app does not have, and it is about to be flown under a
  // different motor. Clear rather than subtract — the module header measures
  // what subtracting did on PePe2 (+94 %) — and quote the file's own figure in
  // the note so the user can put it back by hand.
  if (!namesSameMotor(motor.designation, named)) {
    const hasMass = typeof stated === 'number' && stated > 0;
    const hasCg = typeof cleared['overrideCGX'] === 'number';
    if (!hasMass && !hasCg) {
      // Nothing left to clear — both were cleared by hand already. Drop the
      // stale mark quietly, exactly as the matching path does below.
      return { tree: replaceStage(tree, index, cleared), note: null, severity: 'info' };
    }
    const bare = { ...cleared };
    delete bare['overrideMass'];
    delete bare['overrideSubcomponentsMass'];
    delete bare['overrideCGX'];
    delete bare['overrideSubcomponentsCG'];
    const what = hasMass
      ? `the ${text.mass(stated as number)} the RASAero file stated for that stage is a launch weight`
      : 'the CG the RASAero file stated for that stage is a launch CG';
    return {
      tree: replaceStage(tree, index, bare),
      severity: 'warn',
      note: `“${name}”: ${what} that still holds ${who}, and the motor loaded on that stage now is `
        + `“${motor.designation}”. ${who} is not in the motor database, so its weight cannot be taken `
        + `back out of that figure, and flying it under “${motor.designation}” would carry two motors’ `
        + 'weight. The stage’s mass and CG overrides have been cleared and it is back on its computed '
        + 'geometry. Type what the stage weighs without a motor under Overrides. A RASAero file states a launch weight '
        + `per simulation, and this one belongs to the simulation that named ${who}.`,
    };
  }

  if (typeof stated !== 'number' || !(stated > 0)) {
    // No mass override to correct — cleared by hand, or the file stated a CG
    // and no usable weight. A CG override that is still here IS motor-inclusive
    // (that is what the mark says) and cannot be back-transformed without a
    // stage mass to divide by, so it goes: the same "a wrong override is worse
    // than none" ruling the branch below runs on. With no CG either there is
    // nothing to correct and nothing worth a notice — just drop the stale mark.
    if (typeof cleared['overrideCGX'] !== 'number') {
      return { tree: replaceStage(tree, index, cleared), note: null, severity: 'info' };
    }
    const bare = { ...cleared };
    delete bare['overrideCGX'];
    delete bare['overrideSubcomponentsCG'];
    return {
      tree: replaceStage(tree, index, bare),
      severity: 'warn',
      note: `“${name}”: the CG the RASAero file stated for that stage was a LAUNCH CG with ${who} `
        + 'still inside it, and the file gave no stage weight to back that motor out of. That motor is '
        + 'loaded now, so the CG override has been cleared and the stage is back on its computed CG '
        + 'rather than one that counts the motor twice. Type your own under Overrides if you have '
        + 'measured it.',
    };
  }

  const dry = stated - motor.launchMassKg;
  if (!(dry > 0)) {
    // The stated weight cannot have contained this motor. A WRONG override is
    // worse than none — the doctrine the import block itself runs on — so both
    // overrides go and the stage falls back to its computed geometry.
    const bare = { ...cleared };
    delete bare['overrideMass'];
    delete bare['overrideSubcomponentsMass'];
    delete bare['overrideCGX'];
    delete bare['overrideSubcomponentsCG'];
    return {
      tree: replaceStage(tree, index, bare),
      severity: 'warn',
      note: `“${name}”: the ${text.mass(stated)} the RASAero file stated for that stage was a launch `
        + `weight with its motor still inside it, but ${who} weighs ${text.mass(motor.launchMassKg)} on `
        + 'its own — as much as the whole stage or more, so the file’s weight cannot be right for this '
        + 'motor. The stage’s mass and CG overrides have been cleared and it is back on its computed '
        + 'geometry. Check the weight in the file, or type your own under Overrides.',
    };
  }

  const next: ComponentNode = { ...cleared, overrideMass: dry, overrideSubcomponentsMass: true };
  const parts = [`its mass override is now ${text.mass(dry)} of airframe`];
  let severity: ReconciledStatedWeight['severity'] = 'info';
  let trailer = '';

  // ---- CG, the same double count and the same back-transform ----
  const statedCg = cleared['overrideCGX'];
  if (typeof statedCg === 'number') {
    // Where the motor's CG sits, measured from the STAGE's own front — which
    // is the frame the importer wrote `overrideCGX` in. The motor's aft face
    // is the mount's aft end (BodyTube.getMotorPosition with no overhang), so
    // its front is that minus the motor's length and its CG is `spec.cgX`
    // further back. Only a mount that is a DIRECT child of the stage can be
    // placed this way; that is the only kind this importer ever builds, and
    // anything else leaves the CG unplaceable rather than guessed.
    const kids = stage.children ?? [];
    const at = kids.findIndex((c) => c.id === mountId);
    const mount = at === -1 ? undefined : kids[at];
    const mountAftX = mount
      ? kids.slice(0, at).reduce((sum, c) => sum + nodeLength(c), 0) + nodeLength(mount)
      : NaN;
    const motorCgX = mountAftX - motor.lengthM + motor.cgXFromFrontM;
    const cg = cgFromCombined(motor.launchMassKg, dry, motorCgX, statedCg);
    const len = stageLength(stage);
    if (cg >= 0 && cg <= len) {
      next['overrideCGX'] = cg;
      next['overrideSubcomponentsCG'] = true;
      parts.push(`its CG override is now ${text.length(cg)} from the stage’s own front`);
    } else {
      delete next['overrideCGX'];
      delete next['overrideSubcomponentsCG'];
      severity = 'warn';
      trailer = ' Its CG override could not be corrected the same way — backing the motor out puts the '
        + `stage’s own CG ${Number.isFinite(cg) ? text.length(cg) : 'nowhere computable'} into a `
        + `${text.length(len)} stage, which is outside it — so the CG override has been cleared and the `
        + 'stage is back on its computed CG. Type your own under Overrides if you have measured it.';
    }
  }

  return {
    tree: replaceStage(tree, index, next),
    severity,
    note: `“${name}”: the ${text.mass(stated)} the RASAero file stated for that stage was a launch weight `
      + `with ${who} still inside it. That motor is loaded now, so its ${text.mass(motor.launchMassKg)} has `
      + `been taken back out — ${parts.join(', and ')}. Without that the motor would have been counted `
      + `twice and the rocket would fly ${text.mass(motor.launchMassKg)} heavy. Clear the overrides under `
      + `Overrides to go back to the computed geometry.${trailer}`,
  };
}

/**
 * Every mount at once — the shape three of the four callers actually need.
 *
 * WHY IT EXISTS (2026-09-08, from review). `reconcileIncludedMotor` was wired
 * into the two paths that were obvious when it was written — Browse motor
 * database, and the open loop — and a motor reaches a mount by FOUR routes.
 * The two that were missed put the double count straight back:
 *
 *  - APPLYING A FLIGHT CONFIGURATION. A RASAero file's simulations often name
 *    different motors, and only the applied one is matched at open. Open
 *    `PePe2.CDX1` (simulation 1 names N5800-CS, which the catalogue does not
 *    have, over a stated 47 lb), switch to simulation 6 (M1297W, catalogued,
 *    10.22 lb) and the stage weighed 57.2 lb against that simulation's own
 *    24.2 lb — +136 %, in one click, with nothing on screen. (That switch
 *    mounts a motor the stated weight never held, so what it now gets is the
 *    module header's clearing branch and a warn note, not a subtraction.)
 *  - UNDO. Motors live outside the tree and the undo stack is the tree alone,
 *    so Ctrl+Z after loading the motor restored the marked, uncorrected
 *    override while the motor stayed mounted.
 *
 * Both are the same shape: a tree and a set of mounted motors that arrived
 * together. So the fix is one function that takes both, and every caller that
 * changes either runs it. Identity when nothing is marked, which is every
 * design but a RASAero import naming a motor the catalogue does not have —
 * and that case costs one pass over the stage list and nothing more.
 *
 * THE MATCHING MOUNT GOES FIRST (2026-09-08, from review). The mark is on the
 * STAGE and the first mount in it spends it, so a cluster or a two-mount stage
 * decided by `Object.keys` insertion order which motor was backed out —
 * measured at 15.0 kg against a correct 10.5 on a two-mount marked stage, and
 * the answer changed with the order the motors were loaded in. Every mount
 * whose motor IS the one its stage's mark names is offered first, so the
 * correction never depends on that order. The mark still names ONE motor, so a
 * stage flying two of them backs out one — the importer builds exactly one
 * mount per stage (`rasaeroFile.aftTube`), so reaching that needs a mount added
 * by hand after the import, and the note names the weight it did take out.
 *
 * Notes are the CALLER's to show. Every route that mounts a motor writes them
 * into the notice strip, undo and redo included: a stage mass that moves by
 * tens of pounds is not something to do silently, whatever the keystroke that
 * caused it (that reverses the "silent on undo" choice v0.120 shipped — the
 * `silent` parameter its docblock described never existed in the code).
 */
export function reconcileAllIncludedMotors(
  tree: RocketTree,
  motors: Record<string, AttachedMotor>,
  text: StatedWeightText,
): { tree: RocketTree; notes: string[]; severity: 'info' | 'warn' } {
  // The 99 % case: no stage in this design is marked, so no mount can spend a
  // mark and the per-mount tree walk below is pure cost. Undo/redo run this on
  // EVERY keystroke's worth of history, so it is worth the four lines.
  const anyMark = tree.components.some((st) => {
    const mark = st[OVERRIDE_INCLUDES_MOTOR];
    return typeof mark === 'string' && mark !== '';
  });
  if (!anyMark) return { tree, notes: [], severity: 'info' };

  const ids = Object.keys(motors);
  const matchesItsMark = (mountId: string): boolean => {
    const named = includedMotorOf(tree, mountId);
    return named !== null && namesSameMotor(motors[mountId]!.designation, named);
  };
  const ordered = [...ids.filter(matchesItsMark), ...ids.filter((id) => !matchesItsMark(id))];

  let next = tree;
  const notes: string[] = [];
  let severity: 'info' | 'warn' = 'info';
  for (const mountId of ordered) {
    const fix = reconcileIncludedMotor(next, mountId, motors[mountId]!, text);
    if (!fix) continue;
    next = fix.tree;
    if (fix.note) notes.push(fix.note);
    if (fix.severity === 'warn') severity = 'warn';
  }
  return { tree: next, notes, severity };
}
