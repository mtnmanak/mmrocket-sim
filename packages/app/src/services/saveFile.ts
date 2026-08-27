/**
 * The one place the app hands a file to the user.
 *
 * A tester on Windows 10 + Chrome reported: *"When I click on save ORK or
 * others it just overwrites the open ORK file with no dialog. I do not get to
 * say where to save it either… I did a save as a CDX1 with an ORK file loaded
 * and I don't know where it went."*
 *
 * That is not a browser fault and it is not a Chrome incompatibility. Every
 * save in this app was the `<a download>` blob trick, which **never** shows a
 * dialog unless the browser's "Ask where to save each file" setting is on (off
 * by default in Chrome). The file went straight to the Downloads folder under
 * the rocket's name — and because opening a file seeds the rocket's name from
 * the filename, saving reproduced that name exactly, which reads as
 * "it overwrote my file". The v0.068 changelog's claim that the Save As button
 * "asks where to put the file every time" was simply not true of any browser
 * at default settings.
 *
 * So: use the File System Access API where it exists (Chrome and Edge, which
 * is what most testers are on) and get a real Save-As dialog with an editable
 * name and a folder choice. Everywhere else, keep the download — but SAY so,
 * naming the file that was written, so "I don't know where it went" cannot
 * happen twice.
 */

/** `showSaveFilePicker` is not in TypeScript's DOM lib yet. */
interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: { description?: string; accept: Record<string, string[]> }[];
}
interface FsWritable {
  write(data: BlobPart): Promise<void>;
  close(): Promise<void>;
}
interface FsFileHandle {
  name: string;
  createWritable(): Promise<FsWritable>;
}
type PickerWindow = Window & {
  showSaveFilePicker?: (opts?: SaveFilePickerOptions) => Promise<FsFileHandle>;
};

export interface SaveOptions {
  /** Prefilled, editable in the picker; the literal filename in the fallback. */
  suggestedName: string;
  mime: string;
  /** Extensions for this MIME, with the leading dot (e.g. ['.ork']). */
  extensions: string[];
  /** Shown as the file-type label in the picker's dropdown. */
  description: string;
}

export type SaveOutcome =
  /** Written where the user chose, through a real Save-As dialog. */
  | { kind: 'saved'; name: string }
  /**
   * Handed to the browser's download machinery — folder not our choice.
   * `fellBack` is set when a Save-As dialog WAS used and the write to the
   * chosen folder then failed, so the caller can say the file went somewhere
   * else instead of reporting a clean save.
   */
  | { kind: 'downloaded'; name: string; fellBack?: string }
  /** The user pressed Cancel in the dialog. Say nothing; do nothing. */
  | { kind: 'cancelled' };

function pickerAvailable(): boolean {
  return typeof window !== 'undefined'
    && window.isSecureContext === true
    && typeof (window as PickerWindow).showSaveFilePicker === 'function';
}

function viaDownload(data: BlobPart, mime: string, name: string): SaveOutcome {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
  const a = document.createElement('a');
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = name;
  // In the document, not detached: Firefox has historically ignored a click on
  // an anchor that is not in the tree.
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Deferred, not on the next line. Chrome usually starts the fetch during
  // click(), but a multi-megabyte workbook can lose that race — and every one
  // of the ten copies of this dance in the app revoked synchronously.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return { kind: 'downloaded', name };
}

/** Narrows the union so `fellBack` can be spread onto a viaDownload result. */
function asDownloaded(o: SaveOutcome): { kind: 'downloaded'; name: string } {
  return o as { kind: 'downloaded'; name: string };
}

/**
 * Save `data` as a file, through a real Save-As dialog where the browser has
 * one. Never throws for an ordinary refusal: a cancelled dialog resolves to
 * `cancelled`, and any picker failure falls back to the download path.
 */
export async function saveFile(data: BlobPart, opts: SaveOptions): Promise<SaveOutcome> {
  if (pickerAvailable()) {
    let handle: FsFileHandle | null = null;
    // The picker call gets its OWN try, because AbortError means two entirely
    // different things on either side of it. Here it is the user pressing
    // Cancel — silent, no file, nothing to report.
    try {
      handle = await (window as PickerWindow).showSaveFilePicker!({
        suggestedName: opts.suggestedName,
        types: [{ description: opts.description, accept: { [opts.mime]: opts.extensions } }],
      });
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return { kind: 'cancelled' };
      // Everything else is a reason to fall back rather than to fail: a
      // cross-origin iframe (this build is embeddable — `base: './'`) raises
      // SecurityError, and a picker opened after an `await` has lost its
      // transient user activation and raises NotAllowedError/SecurityError.
      // The user asked for a file; they should get one.
      handle = null;
    }
    if (handle) {
      try {
        const w = await handle.createWritable();
        await w.write(data);
        await w.close();
        return { kind: 'saved', name: handle.name || opts.suggestedName };
      } catch (e) {
        // Past the picker, a failure is a real failure — a full disk, a
        // revoked permission, a file locked by another program. AbortError
        // here is NOT the user cancelling; treating it as one would report
        // "cancelled" for a save that was attempted and lost. Fall back to
        // the download so the work still reaches disk, and SAY that is what
        // happened rather than claiming a plain success.
        return {
          ...asDownloaded(viaDownload(data, opts.mime, opts.suggestedName)),
          fellBack: e instanceof Error ? e.message : String(e),
        };
      }
    }
  }
  return viaDownload(data, opts.mime, opts.suggestedName);
}

/**
 * Fire-and-forget save.
 *
 * It reports NOTHING back — not where the file went, not that a write failed.
 * That is a real limitation and the reason `saveFile` exists: prefer it
 * wherever the app has a channel to tell the user what happened. This form is
 * for the export buttons that have none (the chart, drag, preset and
 * per-component exports), where a Save-As dialog is still a clear improvement
 * on a silent download and the file's own name is the confirmation.
 */
export function downloadBlob(blob: Blob, filename: string, description = 'File'): void {
  const dot = filename.lastIndexOf('.');
  const ext = dot > 0 ? filename.slice(dot) : '';
  void saveFile(blob, {
    suggestedName: filename,
    mime: blob.type || 'application/octet-stream',
    extensions: ext ? [ext] : [],
    description,
  });
}
