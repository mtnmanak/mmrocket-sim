import { safeName } from './fileName.js';

/** The file the design came from, or the last successful save in any design format. */
export interface DesignFileRef {
  name: string;
  via: 'opened' | 'saved' | 'downloaded';
  format: 'ork' | 'rkt' | 'cdx1';
}

/** Keep the user's own spelling; only a generated rocket-name fallback is sanitized. */
export function designFileBase(ref: DesignFileRef | null, rocketName: string | undefined): string {
  const base = ref?.name.replace(/\.(ork|rkt|cdx1)$/i, '');
  return base?.trim() ? base : safeName(rocketName ?? 'rocket');
}

export function designFileLabel(ref: DesignFileRef | null): string {
  return ref ? ref.name + (ref.format === 'rkt' ? ' — RockSim file' : ref.format === 'cdx1' ? ' — RASAero II file' : '') : 'Not saved to a file';
}

export function designFileTitle(ref: DesignFileRef | null): string {
  if (!ref) return 'This design has not been opened from or saved to a file in this browser. Save .ork offers the rocket name.';
  const loss = ref.format === 'ork' ? '' : ` A ${ref.format === 'rkt' ? 'RockSim' : 'RASAero II'} file does not hold everything an .ork does. Save .ork keeps the full design.`;
  if (ref.via === 'downloaded') {
    return `Downloaded as ${ref.name}. If your download folder already had a file of that name, the browser may have saved it under another name.${loss}`;
  }
  return `${ref.via === 'opened' ? 'Opened from' : 'Saved as'} ${ref.name}. Save .ork offers this name.${loss}`;
}

export function documentTitle(rocketName: string | undefined, ref: DesignFileRef | null, dirty: boolean): string {
  return `${dirty ? '*' : ''}${rocketName || 'Rocket'}${ref ? ` (${ref.name})` : ''} — MMRocket Sim`;
}

/** Autosave is untrusted storage; an invalid name must not reach the header or Save As. */
export function validDesignFileRef(x: unknown): DesignFileRef | null {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
  const ref = x as { name?: unknown; via?: unknown; format?: unknown };
  if (typeof ref.name !== 'string' || !ref.name.trim() || ref.name.length > 255) return null;
  if (ref.via !== 'opened' && ref.via !== 'saved' && ref.via !== 'downloaded') return null;
  if (ref.format !== undefined && ref.format !== 'ork' && ref.format !== 'rkt' && ref.format !== 'cdx1') return null;
  const format = ref.format ?? (/\.rkt$/i.test(ref.name) ? 'rkt' : /\.cdx1$/i.test(ref.name) ? 'cdx1' : 'ork');
  return { name: ref.name, via: ref.via, format };
}
