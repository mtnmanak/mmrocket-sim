import { noteField, noteText } from './noteField.js';
import { cautionNote } from './importNotes.js';
import { validExMotor as validArchivedExMotor, validExMotorFields, exMotorBeyondLimits, validFlightSnapshot, exMotorFlightProblem, repairFlightSnapshot, repairStoredExMotor, boundedExId, exMotorIdentity, exToMotorSpec, flightIdentity, loadExMotors, type ExMotor, type ExFlightSnapshot } from './exMotors.js';
import type { RepairedMotorSpec } from './thrustcurve.js';
import type { OrkExportMotor } from './orkFile.js';
import { escapeXml } from './xmlUtil.js';
import { MAX_EMBEDDED_EX_MOTORS, MAX_EX_MOTOR_SAMPLES } from './exMotorLimits.js';
import type { XmlElement } from './xmlParse.js';

export const EX_MOTORS_TAG = 'mmrexmotors';
export const EX_MOTOR_ID_TAG = 'mmrexmotorid';
export { MAX_EMBEDDED_EX_MOTORS } from './exMotorLimits.js';
// Bound escaped UTF-8, leaving room beneath the disk reader's 64 MiB XML cap.
// Share links retain their independent, smaller whole-document limit.
export const MAX_EX_ARCHIVE_BYTES = 16 * 1024 * 1024;
export const EX_MOTOR_NOTES_TAG = 'mmrexmotornotes';

export { validExMotor as validArchivedExMotor, validFlightSnapshot } from './exMotors.js';

/** Deterministic bounded name; full identity comparison handles hash collisions. */
function snapshotId(identity: string): string {
  let hash = 2166136261;
  for (let i = 0; i < identity.length; i++) hash = Math.imul(hash ^ identity.charCodeAt(i), 16777619);
  return `ex:snapshot-${(hash >>> 0).toString(16)}`;
}

/** Save loaded data even when its browser library changed or disappeared. */
export function archiveExMotors(mounted: readonly OrkExportMotor[], notes: string[]): {
  json: string | null; ids: Map<OrkExportMotor, string | null>;
} {
  const ids = new Map<OrkExportMotor, string | null>();
  const exRefs = mounted.filter(m => m.exMotorId !== undefined || m.exMotorSpec);
  if (!exRefs.length) return { json: null, ids };
  const library = new Map(loadExMotors().map(m => [m.motorId, m]));
  const definitions = new Map<string, ExMotor>();
  const identities = new Map<string, string>();
  const candidates: { ref: OrkExportMotor; motor: ExMotor; identity: string }[] = [];
  const seenRefs = new Set<OrkExportMotor>();
  let bytes = 2;
  for (const ref of exRefs) {
    if (seenRefs.has(ref)) continue;
    seenRefs.add(ref);
    const name = noteField(ref.designation, 160);
    const current = library.get(ref.exMotorId ?? '');
    const loadedSpec = ref.exMotorSpec as RepairedMotorSpec | undefined;
    const rawCaptured = loadedSpec?.exDefinition ?? ref.exDefinition;
    const capturedNotes: string[] = [];
    const captured = validArchivedExMotor(rawCaptured) ? repairStoredExMotor(rawCaptured, capturedNotes) : rawCaptured;
    const spec = loadedSpec && repairFlightSnapshot(loadedSpec, notes, validArchivedExMotor(captured) ? captured : undefined);
    if (!ref.manufacturer && !captured && !current) {
      cautionNote(notes, 'export-loss', `EX motor ${name}: no maker is available in its loaded data or library definition. The saved file cannot identify a maker for desktop OR. If the original .eng/.rse names a maker, re-import it to include that maker; a source naming only EX has no maker to restore.`);
    }
    let motor: ExMotor | undefined;
    if (spec && validFlightSnapshot(spec)) {
      const original = validArchivedExMotor(captured) ? captured
        : validArchivedExMotor(current) && flightIdentity(exToMotorSpec(current, ref.delay)) === flightIdentity(spec) ? current : undefined;
      if (original && flightIdentity(exToMotorSpec(original, ref.delay)) === flightIdentity(spec)) motor = original;
      else {
        // Old sessions may contain only MotorSpec. Unknown source metadata stays
        // unknown; never borrow it from a different curve in today's library.
        const flightSnapshot: ExFlightSnapshot = {
          designation: spec.designation, diameter: spec.diameter, length: spec.length,
          times: [...spec.times], thrusts: [...spec.thrusts], masses: [...spec.masses], cgX: spec.cgX,
        };
        const total = spec.masses.reduce((a, b) => Math.max(a, b));
        const dry = spec.masses.reduce((a, b) => Math.min(a, b));
        motor = { motorId: boundedExId(ref.exMotorId?.startsWith('ex:') ? ref.exMotorId : 'ex:snapshot'), designation: spec.designation,
          realManufacturer: ref.manufacturer ?? '', diameter: spec.diameter * 1000, length: spec.length * 1000,
          totalWeightG: total * 1000, propWeightG: (total - dry || total) * 1000,
          delays: ref.exDelays ?? (Number.isFinite(ref.delay) ? String(ref.delay) : 'P'),
          samples: spec.times.map((time, i) => ({ time, thrust: spec.thrusts[i]! })),
          source: 'snapshot', addedAt: 0, ...original, flightSnapshot };
      }
      const savedData = motor.flightSnapshot ? 'the loaded snapshot' : 'its captured source definition';
      if (!validArchivedExMotor(current)) notes.push(`EX motor ${name}: its library definition is missing or invalid; saved ${savedData}.`);
      else if (flightIdentity(exToMotorSpec(current, ref.delay)) !== flightIdentity(spec)
        || (captured && exMotorIdentity(current) !== exMotorIdentity(captured))) {
        notes.push(`EX motor ${name}: its library definition changed; saved ${savedData}.`);
      }
    } else if (validArchivedExMotor(captured) && !ref.exMotorMissing) {
      motor = captured;
      cautionNote(notes, 'export-loss', `EX motor ${name}: the loaded curve is invalid; saved its captured source definition.`);
    } else if (!spec && !ref.exMotorMissing) {
      motor = validArchivedExMotor(captured) ? captured : current;
    }
    if (!validArchivedExMotor(motor)) {
      ids.set(ref, null);
      cautionNote(notes, 'export-loss', `EX motor ${name}: no valid loaded snapshot remains; saved the design without this motor.`);
      continue;
    }
    // A repaired source can sit beside an intentionally different measured curve.
    // Describe its burn-off only when that is the curve actually being written.
    if (validArchivedExMotor(captured) && (!spec
      || flightIdentity(exToMotorSpec(captured, ref.delay)) === flightIdentity(spec))) {
      for (const note of capturedNotes) if (!notes.includes(note)) notes.push(note);
    }
    const identity = exMotorIdentity(motor);
    candidates.push({ ref, motor, identity });
  }
  const versions = new Map<string, Set<string>>();
  for (const { motor, identity } of candidates) {
    const set = versions.get(motor.motorId) ?? new Set<string>();
    set.add(identity);
    versions.set(motor.motorId, set);
  }
  for (const { ref, motor, identity } of candidates) {
    const existing = identities.get(identity);
    if (existing) { ids.set(ref, existing); continue; }
    // Name all versions of a shared library id by content, so rearranging the
    // configurations cannot swap which snapshot owns the original id.
    let id = motor.flightSnapshot || versions.get(motor.motorId)!.size > 1
      ? snapshotId(identity) : boundedExId(motor.motorId);
    if (definitions.has(id)) id = snapshotId(identity);
    const base = id;
    for (let n = 2; definitions.has(id); n++) id = boundedExId(base, `~${n}`);
    const definition = { ...motor, motorId: id,
      ...(id !== motor.motorId ? { libraryMotorId: motor.libraryMotorId ?? motor.motorId } : {}) };
    const size = new TextEncoder().encode(escapeXml(JSON.stringify(definition))).length + 1;
    if (definitions.size >= MAX_EMBEDDED_EX_MOTORS || bytes + size > MAX_EX_ARCHIVE_BYTES) {
      ids.set(ref, null);
      cautionNote(notes, 'export-loss', `EX motor ${noteField(ref.designation, 160)}: the disk archive budget was exceeded; saved the design without this motor.`);
      continue;
    }
    bytes += size;
    definitions.set(id, definition);
    identities.set(identity, id);
    ids.set(ref, id);
  }
  return { json: definitions.size ? JSON.stringify([...definitions.values()]) : null, ids };
}

/** Archive damage refuses the extension; motor damage refuses only that motor. */
export function readArchivedExMotors(rocket: XmlElement, notes: string[]): Map<string, ExMotor> {
  const elements = Array.from(rocket.querySelectorAll(`:scope > ${EX_MOTORS_TAG}`));
  if (!elements.length) return new Map();
  try {
    if (elements.length !== 1 || elements[0]!.getAttribute('version') !== '1') throw new Error('unsupported or repeated extension');
    const raw = elements[0]!.textContent ?? '';
    if (raw.length > MAX_EX_ARCHIVE_BYTES || new TextEncoder().encode(escapeXml(raw)).length > MAX_EX_ARCHIVE_BYTES) throw new Error('over the 16 MiB disk archive limit');
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value) || value.length > MAX_EMBEDDED_EX_MOTORS) throw new Error('invalid motor list or over 1024 motors');
    const ids = new Set<string>();
    const duplicates = new Set<string>();
    for (const m of value) {
      if (!m || typeof m !== 'object' || typeof m.motorId !== 'string') continue;
      if (ids.has(m.motorId)) duplicates.add(m.motorId);
      ids.add(m.motorId);
    }
    const usable: ExMotor[] = [];
    const namedDuplicates = new Set<string>();
    for (const m of value) {
      const designation = typeof m?.designation === 'string' ? m.designation : '';
      const name = /[^\s\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/u.test(designation)
        ? noteField(designation, 160).trim() || '(unnamed)' : '(unnamed)';
      const duplicate = duplicates.has(m?.motorId);
      const beyond = !duplicate && exMotorBeyondLimits(m);
      const reason = duplicate ? 'shared library id; the mount cannot identify which motor it means'
        : exMotorBeyondLimits(m) ? 'its mass, size or thrust is beyond the numbers the simulator can handle'
        : !validExMotorFields(m) ? `invalid definition, non-finite value, or over ${MAX_EX_MOTOR_SAMPLES} samples per motor`
        : !validArchivedExMotor(m) ? exMotorFlightProblem(m) : null;
      if (reason) {
        if (!duplicate || !namedDuplicates.has(name)) cautionNote(notes, 'I15.embedded-ex-refused', `Embedded EX motor ${name} was not loaded: ${reason}. ${beyond ? 'Correct its source file or choose another motor before flying.' : 'Re-import its original .eng/.rse file.'}`);
        if (duplicate) namedDuplicates.add(name);
      }
      else usable.push(m as ExMotor);
    }
    return new Map(usable.map(m => [m.motorId, repairStoredExMotor(m, notes)]));
  } catch (error) {
    const reason = noteText(error instanceof Error ? error.message : String(error));
    cautionNote(notes, 'I15.embedded-ex-refused', `Embedded EX motors were refused: ${reason}. Re-import the original .eng/.rse; these motors were not loaded.`);
    return new Map();
  }
}
