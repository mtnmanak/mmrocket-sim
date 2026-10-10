import { safeName } from './fileName.js';

/** The file the design came from, or the last full-fidelity save's name. */
export interface DesignFileRef {
  name: string;
  via: 'opened' | 'saved' | 'downloaded';
}

/** Keep the user's own spelling; only a generated rocket-name fallback is sanitized. */
export function designFileBase(ref: DesignFileRef | null, rocketName: string | undefined): string {
  const base = ref?.name.replace(/\.(ork|rkt|cdx1)$/i, '');
  return base?.trim() ? base : safeName(rocketName ?? 'rocket');
}

export function designFileLabel(ref: DesignFileRef | null): string {
  return ref?.name ?? 'Not saved to a file';
}

export function designFileTitle(ref: DesignFileRef | null): string {
  if (!ref) return 'This design has not been opened from or saved to a file in this browser. Save .ork offers the rocket name.';
  if (ref.via === 'downloaded') {
    return `Downloaded as ${ref.name}. If your download folder already had a file of that name, the browser may have saved it under another name.`;
  }
  return `${ref.via === 'opened' ? 'Opened from' : 'Saved as'} ${ref.name}. Save .ork offers this name.`;
}

export function documentTitle(rocketName: string | undefined, ref: DesignFileRef | null, dirty: boolean): string {
  return `${dirty ? '*' : ''}${rocketName || 'Rocket'}${ref ? ` (${ref.name})` : ''} — MMRocket Sim`;
}

/** Autosave is untrusted storage; an invalid name must not reach the header or Save As. */
export function validDesignFileRef(x: unknown): DesignFileRef | null {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
  const ref = x as { name?: unknown; via?: unknown };
  if (typeof ref.name !== 'string' || !ref.name.trim() || ref.name.length > 255) return null;
  if (ref.via !== 'opened' && ref.via !== 'saved' && ref.via !== 'downloaded') return null;
  return { name: ref.name, via: ref.via };
}
