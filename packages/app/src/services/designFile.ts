import type { MotorSpec } from '@online-openrocket/engine';
import type { ImportedDesign } from './importApply.js';
import type { AeroChoice } from '../prefs/aeroChoice.js';
import type { MotorDbEntry } from './motorDb.js';
import { importOrk } from './orkFile.js';
import type { Preset } from './presets.js';
import { importCdx1Flown } from './rasaeroFile.js';
import { importRkt } from './rocksimFile.js';

/**
 * THE FILE DOOR — what App's Open… does to a design file before any motor is
 * matched: refuse one too large to be a design, read it with the importer its
 * extension names, name a generically-named design after its file, and word a
 * refusal. Moved out of App.tsx unchanged (2026-10-01) so the headless open
 * (services/simulateFile.ts) refuses, parses, names and words exactly what the
 * app does. The sentences moved verbatim.
 */

/**
 * The largest design file either door reads. Mirrors shareLink.ts's
 * MAX_FRAGMENT_CHARS: refuse absurd input at the door rather than discovering
 * it during a decompress. A .ork is a zip and gets traded in the beta thread
 * and by email; zipMember.ts walks its directory with bounds and inflates only
 * the one member it reads, capped, but every byte of the file is in memory
 * before it can look. The largest real design on hand is 4.46 MB, so 64 MiB
 * refuses a hostile file without ever refusing a genuine one.
 */
export const MAX_DESIGN_FILE_BYTES = 64 * 1024 * 1024;

/** The refusal of a file over MAX_DESIGN_FILE_BYTES, or null when its size is fine. */
export function designFileTooLarge(byteLength: number, fileName: string): string | null {
  if (byteLength <= MAX_DESIGN_FILE_BYTES) return null;
  return `${fileName} is ${(byteLength / (1024 * 1024)).toFixed(0)} MB — that is not `
    + 'a rocket design. Nothing was opened.';
}

/**
 * Why a file could not be opened, naming the format the user actually picked.
 * Open… takes .ork, .rkt and .CDX1, and hard-coding ".ork" made a precise
 * importer message read as nonsense — "Could not open that .ork file: This is
 * an older BINARY RockSim file…".
 */
export function designFileOpenFailure(fileName: string, err: unknown): string {
  const ext = /\.(rkt|cdx1|ork)$/i.exec(fileName);
  const kind = ext ? `.${ext[1]!.toLowerCase().replace('cdx1', 'CDX1')}` : '';
  return `Could not open that${kind ? ` ${kind}` : ''} file: `
    + `${err instanceof Error ? err.message : String(err)}`;
}

/** Rocket names that mean "the user never named it" (desktop default is "Rocket"). */
export const GENERIC_ROCKET_NAMES: ReadonlySet<string> = new Set([
  'rocket', 'new rocket', 'imported rocket', 'my rocket',
  // Importer fallbacks for files with no <Name> — the filename beats these.
  'imported rocksim rocket', 'imported rasaero rocket',
]);

/**
 * Desktop OpenRocket's default rocket name is literally "Rocket" (users name
 * the file instead) — fall back to the filename in that case. Mutates
 * `imported`, as App's helper always did: it runs on whichever parse is
 * actually applied.
 */
export function applyDesignNameFallback(imported: ImportedDesign, fileName: string): void {
  if (!imported.tree.name
      || GENERIC_ROCKET_NAMES.has(imported.tree.name.trim().toLowerCase())) {
    const fromFile = fileName.replace(/\.(ork|rkt|cdx1)$/i, '').replace(/_+/g, ' ').trim();
    if (fromFile) {
      imported.tree.name = fromFile;
      imported.name = fromFile;
    }
  }
}

export type DesignFormat = 'ork' | 'rkt' | 'cdx1';

/** What the file door reads a design with; see {@link parseDesignFile}. */
export interface DesignFileOptions {
  /** Optional inflated XML cap for ZIP/gzip design files. */
  maxInflatedBytes?: number;
  presets: readonly Preset[];
  /** Legacy option name: the caller's Altitude selection for new height notes. */
  distanceUnit?: string;
  /** Horizontal distance selection for geographic distance notes (N032); separate from Altitude. */
  horizontalDistanceUnit?: string;
  catalogue?: MotorDbEntry[];
  aeroChoice?: AeroChoice;
  /** The curve load the flight's motor match uses, for a .CDX1's stated weight. */
  flownSpec?: (row: MotorDbEntry, ejectionDelay: number) => Promise<MotorSpec>;
}

/** Which importer a file goes to: by its extension; anything that is not .rkt or .CDX1 is read as a .ork. */
export function designFormatOf(fileName: string): DesignFormat {
  if (/\.rkt$/i.test(fileName)) return 'rkt';
  if (/\.cdx1$/i.test(fileName)) return 'cdx1';
  return 'ork';
}

/**
 * A design file, parsed by the importer its name calls for — no name
 * fallback (`openDesignFile` adds it). The parts catalogue rides along so a
 * part the file names by manufacturer + part number (.rkt <PartMfg>/<PartNo>,
 * .ork <preset>) is linked to its row and takes the catalogue's values for
 * whatever the file left unset — a RockSim chute's "auto" Cd, above all. The
 * user's altitude unit goes to the readers for new height notes: deployment
 * and separation overrides in .ork, deployment in .rkt, and site/table heights
 * in .CDX1. Site-altitude clamp readouts also use Altitude; longitude-check
 * distances use the separate Horizontal distance selection (N032).
 * Motor rows travel with it too (2026-10-01): headless imports must settle
 * delays and motor moments on the shipped rows, while App keeps live defaults.
 *
 * ASYNC since 2026-10-11 (board Tier 0 row 81): a .CDX1's stated launch weight
 * is backed out with the mass of the curve file the flight will load, and that
 * curve loads asynchronously. `flownSpec` is the caller's own curve load — the
 * same function its motor match flies with — so the import and the flight read
 * one curve. Absent, the catalogue's masses stand in, as before.
 */
export async function parseDesignFile(
  data: ArrayBuffer, fileName: string, opts: DesignFileOptions,
): Promise<ImportedDesign> {
  switch (designFormatOf(fileName)) {
    case 'rkt':
      return { ...importRkt(data, { maxInflatedBytes: opts.maxInflatedBytes, presets: opts.presets, catalogue: opts.catalogue,
        ...(opts.horizontalDistanceUnit !== undefined ? { horizontalDistanceUnit: opts.horizontalDistanceUnit } : {}),
        ...(opts.distanceUnit !== undefined ? { distanceUnit: opts.distanceUnit } : {}) }), sourceFormat: 'rkt' };
    case 'cdx1':
      return { ...await importCdx1Flown(data, { catalogue: opts.catalogue, aeroChoice: opts.aeroChoice,
        ...(opts.distanceUnit !== undefined ? { distanceUnit: opts.distanceUnit } : {}),
        ...(opts.flownSpec ? { flownSpec: opts.flownSpec } : {}) }), sourceFormat: 'cdx1' };
    case 'ork':
      return { ...importOrk(data, { maxInflatedBytes: opts.maxInflatedBytes, presets: opts.presets,
        ...(opts.horizontalDistanceUnit !== undefined ? { horizontalDistanceUnit: opts.horizontalDistanceUnit } : {}),
        ...(opts.distanceUnit !== undefined ? { distanceUnit: opts.distanceUnit } : {}) }), sourceFormat: 'ork' };
  }
}

/** A design file as App's Open… applies it: parsed, then named after its file when it names itself generically. */
export async function openDesignFile(
  data: ArrayBuffer, fileName: string, opts: DesignFileOptions,
): Promise<ImportedDesign> {
  const imported = await parseDesignFile(data, fileName, opts);
  applyDesignNameFallback(imported, fileName);
  return imported;
}
