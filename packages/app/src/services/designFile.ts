import type { UnitSelection } from '../prefs/units.js';
import type { MotorSpec } from '@online-openrocket/engine';
import type { ImportedDesign } from './importApply.js';
import type { AeroChoice } from '../prefs/aeroChoice.js';
import type { MotorDbEntry } from './motorDb.js';
import { importOrk } from './orkFile.js';
import type { Preset } from './presets.js';
import { importCdx1Flown } from './rasaeroFile.js';
import { importRkt } from './rocksimFile.js';
import { decodeXml } from './xmlUtil.js';
import { gunzipCapped, InflatedFileTooLargeError, unzipMember } from './zipMember.js';
import { XmlBudgetExceededError } from './xmlParse.js';
import { cautionNote, noteFlags } from './importNotes.js';
import { noteField } from './noteField.js';

/**
 * THE FILE DOOR — what App's Open… does to a design file before any motor is
 * matched: refuse one too large to be a design, identify its content and read
 * it, name a generically-named design after its file, and word a
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

class DesignReaderError extends Error {
  readonly format: DesignFormat;
  constructor(format: DesignFormat, err: unknown) {
    super(err instanceof Error ? err.message : String(err));
    this.format = format;
  }
}

/** Preserve the public refusal wording, naming the content-selected reader. */
export function designFileOpenFailure(fileName: string, err: unknown): string {
  const detectedFormat = err instanceof Error && 'format' in err ? err.format : undefined;
  const format = detectedFormat === 'ork' || detectedFormat === 'rkt' || detectedFormat === 'cdx1'
    ? detectedFormat : /\.(ork|rkt|cdx1)$/i.exec(fileName)?.[1]?.toLowerCase();
  const kind = format === 'cdx1' ? '.CDX1' : format ? `.${format}` : '';
  return `Could not open that ${kind ? kind + ' ' : ''}file: `
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
  units?: UnitSelection;
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

/** Filename hint when content does not identify a supported design format. */
export function designFormatOf(fileName: string): DesignFormat {
  if (/\.rkt$/i.test(fileName)) return 'rkt';
  if (/\.cdx1$/i.test(fileName)) return 'cdx1';
  return 'ork';
}

/** Read only the root name, stepping over prolog comments and declarations. */
export function contentFormat(xml: string): DesignFormat | null {
  let at = 0;
  for (;;) {
    while (at < xml.length && /\s/.test(xml[at]!)) at++;
    const endToken = xml.startsWith('<?', at) ? '?>' : xml.startsWith('<!--', at) ? '-->' : null;
    if (!endToken) break;
    const end = xml.indexOf(endToken, at + 2);
    if (end < 0) return null;
    at = end + endToken.length;
  }
  const root = /^<([\w:.-]+)(?=[\s/>])/.exec(xml.slice(at))?.[1];
  return root === 'openrocket' ? 'ork' : root === 'RockSimDocument' ? 'rkt' : root === 'RASAeroDocument' ? 'cdx1' : null;
}

/**
 * A design file, parsed by the importer its content calls for — no name
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
  const namedFormat = designFormatOf(fileName);
  const kind = namedFormat === 'cdx1' ? '.CDX1' : `.${namedFormat}`;
  let bytes: Uint8Array = new Uint8Array(data);
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    bytes = unzipMember(bytes, [`.${namedFormat}`, '.ork', '.rkt', '.cdx1'], kind, opts.maxInflatedBytes);
  } else if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    bytes = gunzipCapped(bytes, kind, opts.maxInflatedBytes);
  }
  if ((bytes[0] === 0x50 && bytes[1] === 0x4b) || (bytes[0] === 0x1f && bytes[1] === 0x8b)) {
    throw new Error(`Not a readable ${kind} file — nested archives are not supported.`);
  }
  const format = contentFormat(decodeXml(bytes.subarray(0, 16 * 1024)).xml) ?? namedFormat;
  let imported: ImportedDesign;
  try {
    imported = await readDesignFile(bytes, format, opts);
  } catch (err) {
    if (err instanceof XmlBudgetExceededError || err instanceof InflatedFileTooLargeError) {
      Object.assign(err, { format });
      throw err;
    }
    if (format !== namedFormat) throw new DesignReaderError(format, err);
    throw err;
  }
  if (format !== namedFormat) {
    const notes: string[] = [];
    cautionNote(notes, 'I22.file-format', `“${noteField(fileName, 200)}”: its content is ${format === 'ork' ? 'OpenRocket' : format === 'rkt' ? 'RockSim' : 'RASAero'} despite its extension; it was opened with the matching reader.`);
    imported.notes.push(...notes);
    imported.noteTiers = [...(imported.noteTiers ?? []), ...noteFlags(notes)];
  }
  return imported;
}

async function readDesignFile(data: Uint8Array, format: DesignFormat, opts: DesignFileOptions): Promise<ImportedDesign> {
  switch (format) {
    case 'rkt':
      return { ...importRkt(data, { units: opts.units, maxInflatedBytes: opts.maxInflatedBytes, presets: opts.presets, catalogue: opts.catalogue,
        ...(opts.horizontalDistanceUnit !== undefined ? { horizontalDistanceUnit: opts.horizontalDistanceUnit } : {}),
        ...(opts.distanceUnit !== undefined ? { distanceUnit: opts.distanceUnit } : {}) }), sourceFormat: 'rkt' };
    case 'cdx1':
      return { ...await importCdx1Flown(data, { units: opts.units, maxInflatedBytes: opts.maxInflatedBytes, catalogue: opts.catalogue, aeroChoice: opts.aeroChoice,
        ...(opts.distanceUnit !== undefined ? { distanceUnit: opts.distanceUnit } : {}),
        ...(opts.flownSpec ? { flownSpec: opts.flownSpec } : {}) }), sourceFormat: 'cdx1' };
    case 'ork':
      return { ...importOrk(data, { units: opts.units, maxInflatedBytes: opts.maxInflatedBytes, presets: opts.presets,
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
