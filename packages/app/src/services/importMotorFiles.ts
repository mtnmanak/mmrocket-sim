import { INITIAL_UNITS, type UnitSelection } from '../prefs/units.js';
import type { NoteTier } from '../components/Note.js';
import { addExMotors, parseMotorFile, refusedExMotorNote, validExMotor, type ExMotor } from './exMotors.js';
import { EX_IMPORT_BYTES_NOTE, EX_MOTOR_COUNT_NOTE, MAX_EX_IMPORT_BYTES, MAX_EX_IMPORT_FILES, MAX_EX_IMPORT_MOTORS, MAX_EX_SELECTION_BYTES } from './exMotorLimits.js';
import { sessionDebugLog } from './sessionDebugLog.js';
import { decodeXml } from './xmlUtil.js';

// @atestani TRF #162, Eric 2026-10-06: both pickers share parsing, storage and notices.
export async function importMotorFiles(files: File[], units: UnitSelection = INITIAL_UNITS) {
  sessionDebugLog.record('import-start');
  let notice: string | null = null;
  // RockSim XML motor files are often named .txt; main accepted them and the guide says so.
  const matching = files.filter((f) => /\.(eng|rse|txt)$/i.test(f.name));
  matching.sort((a, b) => {
    const x = a.webkitRelativePath || a.name, y = b.webkitRelativePath || b.name;
    return x < y ? -1 : x > y ? 1 : 0;
  });
  const motorFiles = matching.slice(0, MAX_EX_IMPORT_FILES);
  const skippedFiles = matching.length - motorFiles.length;
  const selectionBytes = motorFiles.reduce((total, file) => total + (file.size <= MAX_EX_IMPORT_BYTES ? file.size : 0), 0);
  if (selectionBytes > MAX_EX_SELECTION_BYTES) {
    return { parsed: [], write: null, notice: null,
      error: `Motor selection exceeds the limit of ${MAX_EX_IMPORT_FILES} files or ${MAX_EX_SELECTION_BYTES / (1024 * 1024)} MiB total; split it into smaller selections.`,
      tier: 'information' as NoteTier, noticeTier: 'information' as NoteTier };
  }
  if (motorFiles.length === 0) {
    sessionDebugLog.record('import-failed', new Error('No .eng or .rse files found in that selection.'));
    return {
      parsed: [], write: null, error: 'No .eng or .rse files found in that selection.', notice: null,
      tier: 'information' as NoteTier, noticeTier: 'information' as NoteTier,
    };
  }
  const read: { motor: ExMotor; file: string }[] = [];
  const failed: string[] = [];
  /** What the parsers had to say about motors they DID import (a refused nozzle exit, …). */
  const said: string[] = [];
  if (skippedFiles) said.push(`Skipped ${skippedFiles} motor files beyond the first ${MAX_EX_IMPORT_FILES} files in path order.`);

  for (const f of motorFiles) {
    try {
      if (f.size > MAX_EX_IMPORT_BYTES) throw new Error(EX_IMPORT_BYTES_NOTE);
      const notes: string[] = [];
      const bytes = new Uint8Array(await f.arrayBuffer());
      const [b0, b1, b2] = bytes;
      let start = 0;
      while ([0x20, 0x09, 0x0a, 0x0d].includes(bytes[start]!)) start++;
      const xml = /\.rse$/i.test(f.name) || bytes[start] === 0x3c || (bytes[start] === 0x00 && bytes[start + 1] === 0x3c)
        || (b0 === 0xff && b1 === 0xfe) || (b0 === 0xfe && b1 === 0xff)
        || (b0 === 0xef && b1 === 0xbb && b2 === 0xbf);
      let decoded: { xml: string; note?: string };
      if (xml) decoded = decodeXml(bytes);
      else {
        try {
          decoded = { xml: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
        } catch {
          decoded = { xml: Array.from(bytes, b => String.fromCharCode(b)).join(''),
            note: 'Read this RASP file as ISO-8859-1 (Latin-1), the desktop OR RASP encoding, because it is not UTF-8. Check the motor and maker names.' };
        }
      }
      if (decoded.note) notes.push(decoded.note.replace('Check the part and material names.', 'Check the motor and maker names.'));
      const motors = parseMotorFile(f.name, xml ? decoded.xml.trimStart() : decoded.xml, notes, units);
      if (read.length + motors.length > MAX_EX_IMPORT_MOTORS) throw new Error(EX_MOTOR_COUNT_NOTE);
      for (const motor of motors) read.push({ motor, file: f.name });
      for (const note of notes) said.push(`${f.name}: ${note}`);
    } catch (e) {
      sessionDebugLog.record('import-failed', e);
      failed.push(`${f.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // Screened BEFORE the write: addExMotors refuses the whole batch on its
  // first invalid motor, so one contrived motor used to drop every good one
  // in the selection (closure audit of v0.194, row A). Its throw stays as
  // the backstop.
  const parsed: ExMotor[] = [];
  const refused: string[] = [];
  for (const { motor, file } of read) {
    const name = motor.designation;
    if (validExMotor(motor)) parsed.push(motor);
    else refused.push(`${file}: ${refusedExMotorNote(name)}`);
  }
  if (refused.length) sessionDebugLog.record('import-failed', new Error('A motor failed the library checks.'));
  // ONE library write for the whole selection, not one per file: a folder of
  // fifty files rewrote an ever-growing list fifty times, and one write means
  // one honest answer to "did it save?".
  const repaired = said.length > 0;
  const imported = parsed.map((m) => m.designation);
  const write = parsed.length ? addExMotors(parsed) : null;
  const unsaved = write !== null && !write.stored;
  if (parsed.length > 0) sessionDebugLog.record('import-complete');
  if (unsaved) sessionDebugLog.record('import-storage-failed',
    'Motor storage is full or blocked; imported motors are available only for this session.');
  const some = (names: string[]) => `${names.slice(0, 6).join(', ')}${names.length > 6 ? ', …' : ''}`;
  if (write?.duplicates.length) {
    said.push(`${some(write.duplicates)}: listed more than once with different data — each copy is kept `
      + 'as its own entry under the same name.');
  }
  if (write?.replaced.length) {
    said.push(`${write.replaced.length} replaced the library's earlier motor of the same maker and name `
      + `(${some(write.replaced)}).`);
  }
  const problems: string[] = [];
  if (write) {
    const list = `${imported.length} EX motor${imported.length === 1 ? '' : 's'} `
      + `(${imported.slice(0, 6).join(', ')}${imported.length > 6 ? ', …' : ''})`;
    // Say "survive reloads" only when they do (audit 2026-09-22). A full
    // browser storage used to be swallowed here, and the motors then could
    // not even fly: every reader went back to storage and found nothing.
    if (unsaved) {
      problems.push(`Imported ${list}, but this browser's storage is full or blocked, so they are NOT saved — `
        + 'they fly in this session and are gone after a reload. Free some room (the saved-runs '
        + 'table, or imported motors you no longer need) and import them again to keep them.');
      if (said.length) notice = said.join(' · ');
    } else {
      notice = `Imported ${list} — they live in this browser under manufacturer EX and survive reloads.`
        + (said.length ? ` ${said.join(' · ')}` : '');
    }
  }
  if (failed.length) {
    problems.push(`Skipped ${failed.length} file${failed.length === 1 ? '' : 's'} — ${failed.join(' · ')}`);
  }
  if (refused.length) problems.push(refused.join(' · '));
  if (!write && skippedFiles) notice = said.join(' ');
  const tier: NoteTier = parsed.length > 0 && (repaired || unsaved || failed.length > 0 || refused.length > 0) ? 'caution' : 'information';
  // The part of that tier the NOTICE carries on its own (a repair it names):
  // what is left once something else replaces this import's error (review of
  // NOTES-1, finding 8 — a later failed catalogue Load kept the import's amber).
  const noticeTier: NoteTier = notice !== null && parsed.length > 0 && repaired ? 'caution' : 'information';
  return { parsed, write, tier, noticeTier, error: problems.length ? problems.join(' ') : null, notice };
}
