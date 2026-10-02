import type { NoticeSeverity } from '../components/NoticeBar.js';
import { INITIAL_UNITS } from '../prefs/units.js';
import { designFileOpenFailure, designFileTooLarge, openDesignFile } from './designFile.js';
import { planImport, resolveImportMotors, type ImportedDesign, type ImportPlan } from './importApply.js';
import { DEFAULT_CONDITIONS, type LaunchConditions } from './launchConditions.js';
import { matchImportedMotor, type MotorMatchResult } from './motorMatch.js';
import type { OrkMotorRef } from './orkFile.js';
import { loadBundledPresets, type Preset } from './presets.js';
import {
  simulateDesign, SimulateDesignError, type SimulateDesignOptions, type SimulateDesignResult,
} from './simulateDesign.js';
import { bundledOnlyFetchSpec } from './thrustcurve.js';
import { statedWeightTextFor } from './unitText.js';

/**
 * ONE DESIGN FILE, START TO FINISH, WITH NO REACT MOUNTED (2026-10-01;
 * response-2026-10-01b § 3.2). Bytes → the app's Open… (designFile.ts's door:
 * size refusal, importer, name fallback) → App's `applyImported` without its
 * setters (every motor resolved, importApply's planImport) → simulateDesign,
 * which settles a legacy pad mass and flies the Launch button's own path.
 *
 * What the app's open writes and this does not: the open sequence, the undo
 * history, the saved mark, the session-only notes and the shroud-conversion
 * offer — none of them changes what flies. App.simulate.test.tsx opens the same
 * files in the mounted app and holds the two to the same plan fingerprint and
 * the same bytes.
 *
 * SHIPPED DATA ONLY, BY DEFAULT. The app's open links parts against this
 * browser's custom presets as well as the shipped catalogue, and reads a
 * motor's curve from this browser's cache before the shipped bundle,
 * downloading what the bundle lacks. A headless run reads the bundled presets
 * and the bundled curves only (`network: 'forbid'`), so its answer does not
 * depend on which browser ran it; a motor the bundle cannot fly is reported
 * unloaded in the import note, as the app reports one it cannot download.
 */

export interface SimulateFileOptions extends SimulateDesignOptions {
  /** The Launch panel's conditions the file's own are merged onto (planImport's). Default DEFAULT_CONDITIONS. */
  launch?: LaunchConditions;
  /** The parts catalogue a file's parts link against. Default: the shipped presets only (`loadBundledPresets`). */
  presets?: readonly Preset[];
  /**
   * 'forbid' (default): a motor's curve comes from the shipped bundle or not at
   * all — no request is made, and this browser's curve cache is not read.
   * 'allow': the app's own path (cache, bundle, then thrustcurve.org).
   */
  network?: 'forbid' | 'allow';
  /** Advanced/tests: replaces the per-reference matcher (resolveImportMotors' own injection point). */
  match?: (ref: OrkMotorRef) => Promise<MotorMatchResult>;
}

export interface SimulateFileResult extends SimulateDesignResult {
  /** The open as App would have applied it: the snapshot its saved mark is taken over, the note, the references. */
  plan: ImportPlan;
  /** The import note App shows after the open. */
  importNote: { text: string; severity: NoticeSeverity };
}

/** A design file's bytes, flown as the app opens and launches it. The size is refused before anything is parsed. */
export async function simulateFile(
  data: ArrayBuffer | Uint8Array, fileName: string, opts: SimulateFileOptions = {},
): Promise<SimulateFileResult> {
  const tooBig = designFileTooLarge(data.byteLength, fileName);
  if (tooBig) throw new SimulateDesignError('file', tooBig);
  opts.signal?.throwIfAborted();
  const buffer = data instanceof Uint8Array
    ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
    : data;
  const presets = opts.presets ?? await loadBundledPresets();
  let imported: ImportedDesign;
  try {
    imported = openDesignFile(buffer, fileName, { presets, distanceUnit: (opts.units ?? INITIAL_UNITS).distance });
  } catch (e) {
    throw new SimulateDesignError('parse', designFileOpenFailure(fileName, e), { cause: e });
  }
  return simulateImported(imported, opts);
}

/**
 * An already-parsed, already-named design (an importer's result after the name
 * fallback) → the flight: every step of the open after the parse, then the
 * Launch. `simulateFile` is `openDesignFile` + this.
 */
export async function simulateImported(
  imported: ImportedDesign, opts: SimulateFileOptions = {},
): Promise<SimulateFileResult> {
  const match = opts.match ?? (opts.network === 'allow'
    ? (ref: OrkMotorRef) => matchImportedMotor(ref)
    : (ref: OrkMotorRef) => matchImportedMotor(ref, { fetchSpec: bundledOnlyFetchSpec }));
  // The awaits of an open: every motor the file names, resolved.
  const resolved = await resolveImportMotors(imported, match);
  // What goes on screen, decided as App decides it: the file's conditions
  // merged onto the panel's, the configuration to open, the import note.
  const plan = planImport(imported, resolved, {
    launch: opts.launch ?? DEFAULT_CONDITIONS, text: statedWeightTextFor(opts.units ?? INITIAL_UNITS),
  });
  const { tree, mountMotors, launch, measured, savedConfigs, activeConfigId } = plan.snapshot;
  try {
    const out = await simulateDesign(
      { tree, mountMotors, launch, measured, savedConfigs, activeConfigId, unmatchedRefs: plan.unmatchedRefs }, opts);
    return { ...out, plan, importNote: plan.note };
  } catch (e) {
    // The import note is often the reason ("matched no motor in the motor
    // database"), so a refusal carries it.
    if (e instanceof SimulateDesignError) {
      throw new SimulateDesignError(e.kind, e.message, { cause: e.cause, importNote: plan.note });
    }
    throw e;
  }
}
