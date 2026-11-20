import { safeName } from './fileName.js';

/** The file the design came from, or the last successful save in any design format. */
export interface DesignFileRef {
  name: string;
  via: 'opened' | 'saved' | 'downloaded';
  format: 'ork' | 'rkt' | 'cdx1';
  /** Missing in older autosaves; opened files always keep their disk name. */
  followsRocket?: boolean;
}

/** Legacy app saves under the starter name follow too; opened files never do. */
function followsRocket(ref: DesignFileRef): boolean {
  if (ref.via === 'opened') return false;
  if (ref.followsRocket !== undefined) return ref.followsRocket;
  const stem = ref.name.replace(/\.(ork|rkt|cdx1)$/i, '');
  // Only the app's own suggestion for its two default names (New: 'New Rocket'; the
  // first-visit starter: 'My Rocket'); v0.212 always wrote safeName(...) of them. A spaced
  // 'New Rocket' stem was typed or opened, so it keeps its name.
  return stem === safeName('New Rocket') || stem === safeName('My Rocket');
}

/** Compare with the name at the save snapshot, before the picker can await. */
export function savedDesignFileRef(
  name: string, via: 'saved' | 'downloaded', format: DesignFileRef['format'], rocketName: string | undefined,
  previous: DesignFileRef | null,
): DesignFileRef {
  const suggestedFromRocket = previous === null || followsRocket(previous);
  return { name, via, format,
    followsRocket: suggestedFromRocket && name.replace(/\.(ork|rkt|cdx1)$/i, '') === safeName(rocketName ?? 'rocket') };
}

/** Keep the user's own spelling; only a generated rocket-name fallback is sanitized. */
export function designFileBase(ref: DesignFileRef | null, rocketName: string | undefined): string {
  if (ref && followsRocket(ref)) return safeName(rocketName ?? 'rocket');
  const base = ref?.name.replace(/\.(ork|rkt|cdx1)$/i, '');
  return base?.trim() ? base : safeName(rocketName ?? 'rocket');
}

function offeredFileName(ref: DesignFileRef, rocketName: string | undefined): string {
  return followsRocket(ref)
    ? `${designFileBase(ref, rocketName)}.${ref.format === 'cdx1' ? 'CDX1' : ref.format}` : ref.name;
}

export function designFileLabel(ref: DesignFileRef | null, rocketName?: string): string {
  if (!ref) return 'Not saved to a file';
  const extension = ref.format === 'cdx1' ? 'CDX1' : ref.format;
  const name = followsRocket(ref) ? `Save .${extension} offers ${offeredFileName(ref, rocketName)}` : ref.name;
  return name + (ref.format === 'rkt' ? ' — RockSim file' : ref.format === 'cdx1' ? ' — RASAero II file' : '');
}

export function designFileTitle(ref: DesignFileRef | null, rocketName?: string): string {
  if (!ref) return 'This design has not been opened from or saved to a file in this browser. Save .ork offers the rocket name.';
  const loss = ref.format === 'ork' ? '' : ` A ${ref.format === 'rkt' ? 'RockSim' : 'RASAero II'} file does not hold everything an .ork does. Save .ork keeps the full design.`;
  const suggestion = followsRocket(ref)
    ? ` Save .ork offers ${designFileBase(ref, rocketName)}.ork, following the rocket name.` : '';
  if (ref.via === 'downloaded') {
    return `Downloaded as ${ref.name}. If your download folder already had a file of that name, the browser may have saved it under another name.${suggestion}${loss}`;
  }
  if (suggestion) return `Saved as ${ref.name}.${suggestion}${loss}`;
  return `${ref.via === 'opened' ? 'Opened from' : 'Saved as'} ${ref.name}. Save .ork offers this name.${loss}`;
}

export function documentTitle(rocketName: string | undefined, ref: DesignFileRef | null, dirty: boolean): string {
  return `${dirty ? '*' : ''}${rocketName || 'Rocket'}${ref ? ` (${offeredFileName(ref, rocketName)})` : ''} — MMRocket Sim`;
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
    ...(ref.followsRocket !== undefined ? { followsRocket: ref.via !== 'opened' && ref.followsRocket } : {}) };
}
