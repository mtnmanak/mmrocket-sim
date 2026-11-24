import { safeName } from './fileName.js';

/** The file the design came from, or the last successful save in any design format. */
export interface DesignFileRef {
  name: string;
  via: 'opened' | 'saved' | 'downloaded';
  format: 'ork' | 'rkt' | 'cdx1';
  /** Recorded at open/save; missing on an older opened ref keeps its disk name. */
  followsRocket?: boolean;
}

/** Legacy app saves under the starter name follow too; legacy opens keep their name. */
function followsRocket(ref: DesignFileRef): boolean {
  if (ref.followsRocket !== undefined) return ref.followsRocket;
  if (ref.via === 'opened') return false;
  const stem = ref.name.replace(/\.(ork|rkt|cdx1)$/i, '');
  // Only the app's own suggestion for its two default names (New: 'New Rocket'; the
  // first-visit starter: 'My Rocket'); v0.212 always wrote safeName(...) of them. A spaced
  // 'New Rocket' stem was typed or opened, so it keeps its name.
  return stem === safeName('New Rocket') || stem === safeName('My Rocket');
}

/** Exact, case-sensitive comparison: a case-only difference is a chosen disk name. */
function matches(stem: string, rocketName: string | undefined): boolean {
  const rocket = rocketName?.trim();
  if (!rocket) return false;
  return stem.trim() === rocket || stem.trim() === safeName(rocket);
}

/** Record the relationship while both the disk name and imported rocket name are known. */
export function openedDesignFileRef(
  name: string, format: DesignFileRef['format'], rocketName: string | undefined,
): DesignFileRef {
  return { name, via: 'opened', format, followsRocket: matches(fileStem(name), rocketName) };
}

/** Compare with the name at the save snapshot, before the picker can await. */
export function savedDesignFileRef(
  name: string, via: 'saved' | 'downloaded', format: DesignFileRef['format'], rocketName: string | undefined,
  previous: DesignFileRef | null,
): DesignFileRef {
  const suggestedFromRocket = previous === null || followsRocket(previous);
  return { name, via, format,
    // A blank rocket name is offered as the generic fallback; accepting it still follows.
    followsRocket: suggestedFromRocket
      && (matches(fileStem(name), rocketName) || fileStem(name) === safeName((rocketName ?? 'rocket').trim())) };
}

function fileStem(name: string): string {
  return name.replace(/\.(ork|rkt|cdx1)$/i, '');
}

/** Keep the user's own spelling; only a generated rocket-name fallback is sanitized. */
export function designFileBase(ref: DesignFileRef | null, rocketName: string | undefined): string {
  const stem = ref ? fileStem(ref.name) : '';
  if (!ref || !stem.trim() || (followsRocket(ref) && !matches(stem, rocketName))) {
    return safeName((rocketName ?? 'rocket').trim());
  }
  return stem;
}

/** All design saves and their displayed names use the same stem and extension rule. */
export function offeredDesignFileName(
  ref: DesignFileRef | null, rocketName: string | undefined, format: DesignFileRef['format'],
): string {
  const base = designFileBase(ref, rocketName);
  // Keep the file's own spelling (an upper-case .ORK too) only when its extension is this format's:
  // a content-sniffed file (OpenRocket XML named x.rkt, or x.backup) gets the saved format's extension.
  const extension = /\.(ork|rkt|cdx1)$/i.exec(ref?.name ?? '')?.[1]?.toLowerCase();
  if (ref && base === fileStem(ref.name) && ref.format === format && extension === format) return ref.name;
  return `${base}.${format === 'cdx1' ? 'CDX1' : format}`;
}

export function designFileLabel(ref: DesignFileRef | null, rocketName?: string): string {
  if (!ref) return 'Not saved to a file';
  const extension = ref.format === 'cdx1' ? 'CDX1' : ref.format;
  const changedOpen = designFileBase(ref, rocketName) !== fileStem(ref.name);
  const offered = offeredDesignFileName(ref, rocketName, ref.format);
  const name = ref.via === 'opened'
    ? changedOpen ? `Opened from ${ref.name}; Save .${extension} offers ${offered}` : ref.name
    : changedOpen || followsRocket(ref) ? `Save .${extension} offers ${offered}` : ref.name;
  return name + (ref.format === 'rkt' ? ' — RockSim file' : ref.format === 'cdx1' ? ' — RASAero II file' : '');
}

export function designFileTitle(ref: DesignFileRef | null, rocketName?: string): string {
  if (!ref) return 'This design has not been opened from or saved to a file in this browser. Save .ork offers the rocket name.';
  const loss = ref.format === 'ork' ? '' : ` A ${ref.format === 'rkt' ? 'RockSim' : 'RASAero II'} file does not hold everything an .ork does. Save .ork keeps the full design.`;
  const changed = designFileBase(ref, rocketName) !== fileStem(ref.name);
  const suggestion = changed || (ref.via !== 'opened' && followsRocket(ref))
    ? ` Save .ork offers ${offeredDesignFileName(ref, rocketName, 'ork')}, following the rocket name.` : '';
  if (ref.via === 'downloaded') {
    return `Downloaded as ${ref.name}. If your download folder already had a file of that name, the browser may have saved it under another name.${suggestion}${loss}`;
  }
  if (ref.via === 'opened') return `Opened from ${ref.name}.${suggestion || ' Save .ork offers this name.'}${loss}`;
  if (suggestion) return `Saved as ${ref.name}.${suggestion}${loss}`;
  return `Saved as ${ref.name}. Save .ork offers this name.${loss}`;
}

/** The tab names the file itself until a rename changes the offer (a content-sniffed x.rkt stays x.rkt here). */
export function documentTitle(rocketName: string | undefined, ref: DesignFileRef | null, dirty: boolean): string {
  return `${dirty ? '*' : ''}${rocketName || 'Rocket'}${ref ? ` (${designFileBase(ref, rocketName) === fileStem(ref.name) ? ref.name : offeredDesignFileName(ref, rocketName, ref.format)})` : ''} — MMRocket Sim`;
}

/** Autosave is untrusted storage; an invalid name must not reach the header or Save As. */
export function validDesignFileRef(x: unknown): DesignFileRef | null {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
  const ref = x as { name?: unknown; via?: unknown; format?: unknown; followsRocket?: unknown };
  if (typeof ref.name !== 'string' || !ref.name.trim() || ref.name.length > 255) return null;
  if (ref.via !== 'opened' && ref.via !== 'saved' && ref.via !== 'downloaded') return null;
  if (ref.format !== undefined && ref.format !== 'ork' && ref.format !== 'rkt' && ref.format !== 'cdx1') return null;
  if (ref.followsRocket !== undefined && typeof ref.followsRocket !== 'boolean') return null;
  const format = ref.format ?? (/\.rkt$/i.test(ref.name) ? 'rkt' : /\.cdx1$/i.test(ref.name) ? 'cdx1' : 'ork');
  return { name: ref.name, via: ref.via, format,
    ...(ref.followsRocket !== undefined ? { followsRocket: ref.followsRocket } : {}) };
}
