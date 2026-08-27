// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveFile } from './saveFile.js';

/**
 * A tester on Windows 10 + Chrome: *"When I click on save ORK or others it
 * just overwrites the open ORK file with no dialog. I do not get to say where
 * to save it either… I did a save as a CDX1 with an ORK file loaded and I
 * don't know where it went."*
 *
 * Not a browser fault: every save was an `<a download>` blob click, which
 * never shows a dialog at Chrome's default settings. These cases pin the four
 * branches of the fix, and in particular that pressing Cancel is silent and
 * that a picker failure still produces a file.
 */

const OPTS = {
  suggestedName: 'Wild_Child.ork',
  mime: 'application/octet-stream',
  extensions: ['.ork'],
  description: 'OpenRocket design',
};

type PickerWin = Window & { showSaveFilePicker?: unknown };

let clicked: { download: string; href: string }[];
let origClick: () => void;

beforeEach(() => {
  clicked = [];
  origClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement) {
    clicked.push({ download: this.download, href: this.href });
  };
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
});

afterEach(() => {
  HTMLAnchorElement.prototype.click = origClick;
  delete (window as PickerWin).showSaveFilePicker;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('saveFile — with a Save-As dialog (Chrome, Edge)', () => {
  it('opens the picker with the name prefilled and the type named, and writes', async () => {
    const write = vi.fn(() => Promise.resolve());
    const close = vi.fn(() => Promise.resolve());
    const picker = vi.fn(() => Promise.resolve({
      name: 'Mach2.ork',
      createWritable: () => Promise.resolve({ write, close }),
    }));
    (window as PickerWin).showSaveFilePicker = picker;

    const blob = new Blob(['<openrocket/>']);
    await expect(saveFile(blob, OPTS)).resolves.toEqual({ kind: 'saved', name: 'Mach2.ork' });
    // Prefilled AND editable — "Save As should allow saving to a different
    // name" is answered by the picker itself, and the name it comes back with
    // is the one reported to the user.
    expect(picker).toHaveBeenCalledWith({
      suggestedName: 'Wild_Child.ork',
      types: [{ description: 'OpenRocket design', accept: { 'application/octet-stream': ['.ork'] } }],
    });
    expect(write).toHaveBeenCalledWith(blob);
    expect(close).toHaveBeenCalled();
    // No download anywhere: the file went where the user put it.
    expect(clicked).toEqual([]);
  });

  it('Cancel is silent — no file, no error, nothing to report', async () => {
    (window as PickerWin).showSaveFilePicker = () =>
      Promise.reject(new DOMException('The user aborted a request.', 'AbortError'));
    await expect(saveFile(new Blob(['x']), OPTS)).resolves.toEqual({ kind: 'cancelled' });
    expect(clicked).toEqual([]);
  });

  it('a write that fails AFTER the dialog is not a cancel, and says where the file went', async () => {
    // AbortError means two different things either side of the picker. Past
    // it, a failure is a full disk, a locked file or a revoked permission —
    // reporting "cancelled" there would silently lose the user's save.
    (window as PickerWin).showSaveFilePicker = () => Promise.resolve({
      name: 'Mach2.ork',
      createWritable: () => Promise.reject(new DOMException('nope', 'AbortError')),
    });
    const out = await saveFile(new Blob(['x']), OPTS);
    expect(out.kind).toBe('downloaded');
    expect((out as { fellBack?: string }).fellBack).toContain('nope');
    // The work still reached disk.
    expect(clicked.map((c) => c.download)).toEqual(['Wild_Child.ork']);
  });

  it('a picker that FAILS still produces the file', async () => {
    // A cross-origin iframe (this build is embeddable) raises SecurityError,
    // and a picker opened after an await has lost its user activation and
    // raises NotAllowedError. The user asked for a file either way.
    for (const name of ['SecurityError', 'NotAllowedError']) {
      clicked = [];
      (window as PickerWin).showSaveFilePicker = () =>
        Promise.reject(new DOMException('nope', name));
      await expect(saveFile(new Blob(['x']), OPTS))
        .resolves.toEqual({ kind: 'downloaded', name: 'Wild_Child.ork' });
      expect(clicked.map((c) => c.download)).toEqual(['Wild_Child.ork']);
    }
  });

  it('an insecure context never even tries the picker', async () => {
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false });
    const picker = vi.fn();
    (window as PickerWin).showSaveFilePicker = picker;
    await expect(saveFile(new Blob(['x']), OPTS))
      .resolves.toEqual({ kind: 'downloaded', name: 'Wild_Child.ork' });
    expect(picker).not.toHaveBeenCalled();
  });
});

describe('saveFile — the download fallback (Firefox, Safari)', () => {
  it('writes the suggested name', async () => {
    await expect(saveFile(new Blob(['x']), OPTS))
      .resolves.toEqual({ kind: 'downloaded', name: 'Wild_Child.ork' });
    expect(clicked).toEqual([{ download: 'Wild_Child.ork', href: 'blob:test' }]);
  });

  it('puts the anchor in the document, and takes it out again', async () => {
    let inDocument = false;
    HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement) {
      inDocument = this.isConnected;
    };
    await saveFile(new Blob(['x']), OPTS);
    // Firefox has historically ignored a click on a detached anchor.
    expect(inDocument).toBe(true);
    expect(document.querySelector('a[download]')).toBeNull();
  });

  it('revokes the object URL LATER, not on the next line', async () => {
    // Chrome usually starts the fetch during click(), but a multi-megabyte
    // workbook can lose that race — and all ten copies of this dance in the
    // app revoked synchronously.
    vi.useFakeTimers();
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    await saveFile(new Blob(['x']), OPTS);
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(revoke).toHaveBeenCalledWith('blob:test');
  });
});
