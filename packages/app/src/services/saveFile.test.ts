// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadBlob, downloadSettingHint, saveFile, saveOutcomeNote } from './saveFile.js';

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
  it('S2-1 distinguishes equal basenames and recognizes different handles for the same entry', async () => {
    const handle = (path: string) => ({ name: 'Rocket.ork',
      isSameEntry: async (other: { path: string }) => path === other.path, path,
      createWritable: async () => ({ write: async () => {}, close: async () => {} }) });
    const picker = vi.fn().mockResolvedValueOnce(handle('folder-a/Rocket.ork'))
      .mockResolvedValueOnce(handle('folder-b/Rocket.ork')).mockResolvedValueOnce(handle('folder-a/Rocket.ork'));
    (window as PickerWin).showSaveFilePicker = picker;
    const a = await saveFile('A', OPTS) as { destination?: object };
    const b = await saveFile('B', OPTS) as { destination?: object };
    const again = await saveFile('C', OPTS) as { destination?: object };
    expect(a.destination).toBeDefined();
    expect(b.destination).not.toBe(a.destination);
    expect(again.destination).toBe(a.destination);
  });
  it('opens the picker with the name prefilled and the type named, and writes', async () => {
    const write = vi.fn(() => Promise.resolve());
    const close = vi.fn(() => Promise.resolve());
    const picker = vi.fn(() => Promise.resolve({
      name: 'Mach2.ork',
      createWritable: () => Promise.resolve({ write, close }),
    }));
    (window as PickerWin).showSaveFilePicker = picker;

    const blob = new Blob(['<openrocket/>']);
    await expect(saveFile(blob, OPTS)).resolves.toEqual({ kind: 'saved', name: 'Mach2.ork', destination: expect.any(Object) });
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

  it('a MIME type with parameters still gets the dialog (audit 2026-09-22)', async () => {
    // Chrome's picker takes a bare MIME essence as an `accept` key and throws
    // TypeError on "text/csv;charset=utf-8" — the type the Run table and
    // Flight data CSVs are built with — so both went straight to Downloads
    // while the XLSX beside them got a Save As dialog. A picker that refuses
    // the way Chrome does:
    const write = vi.fn(() => Promise.resolve());
    const picker = vi.fn((o: { types: { accept: Record<string, string[]> }[] }) => {
      for (const key of Object.keys(o.types[0]!.accept)) {
        if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(key)) {
          return Promise.reject(new TypeError(`Invalid type: ${key}`));
        }
      }
      return Promise.resolve({
        name: 'runs.csv',
        createWritable: () => Promise.resolve({ write, close: () => Promise.resolve() }),
      });
    });
    (window as PickerWin).showSaveFilePicker = picker;
    const blob = new Blob(['a,b'], { type: 'text/csv;charset=utf-8' });
    await expect(saveFile(blob, { ...OPTS, suggestedName: 'runs.csv', mime: blob.type, extensions: ['.csv'] }))
      .resolves.toEqual({ kind: 'saved', name: 'runs.csv', destination: expect.any(Object) });
    expect(picker.mock.calls[0]![0].types[0]!.accept).toEqual({ 'text/csv': ['.csv'] });
    expect(clicked).toEqual([]);
    // downloadBlob — the path those two CSV buttons take — hands the Blob's
    // own type through, and gets the dialog too.
    picker.mockClear();
    downloadBlob(blob, 'flight.csv');
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2));
    expect(picker.mock.calls[0]![0].types[0]!.accept).toEqual({ 'text/csv': ['.csv'] });
    expect(clicked).toEqual([]);
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

/**
 * WHAT A SAVE COULD NOT CARRY, SAID UNDER THE SAVE LINE (seam review of audit
 * 2026-09-22). A .rkt cannot say every ignition event this app flies; the
 * writer names each one it had to change, and the note is where the user reads
 * it — as a warning, since the file reopens flying differently. App handing the
 * writer's losses to this line is App.save.test.tsx's, with App mounted and a
 * .rkt saved (audit 2026-09-22, row 477); it was a regex over App.tsx here.
 */
describe('saveOutcomeNote — the save line, and the losses under it', () => {
  const loss = '“K250W” is set never to light. RockSim times … so the .rkt lights it 0 s after launch.';

  it('says where the file went, as information when nothing was lost', () => {
    expect(saveOutcomeNote({ kind: 'saved', name: 'R.rkt' })).toEqual({ text: 'Saved “R.rkt”.', severity: 'info' });
    expect(saveOutcomeNote({ kind: 'downloaded', name: 'R.rkt' }))
      .toEqual({ text: 'Saved “R.rkt” to your browser\'s download folder.', severity: 'info' });
    expect(saveOutcomeNote({ kind: 'downloaded', name: 'R.rkt', fellBack: 'disk full' })?.severity).toBe('warn');
  });

  it('puts each loss on its own line under it, as a warning — and says nothing for a cancel', () => {
    expect(saveOutcomeNote({ kind: 'saved', name: 'R.rkt' }, [loss]))
      .toEqual({ text: `Saved “R.rkt”.\n${loss}`, severity: 'warn' });
    expect(saveOutcomeNote({ kind: 'downloaded', name: 'R.rkt' }, [loss, loss])!.text.split('\n')).toHaveLength(3);
    expect(saveOutcomeNote({ kind: 'cancelled' }, [loss])).toBeNull();
  });
});

/**
 * Option C (Eric, 2026-10-11): Firefox gives a web page no Save As dialog, so a
 * save there is a download; on his Firefox 157 every one went straight to the
 * download folder. The note names the setting that makes Firefox ask.
 */
describe('downloadSettingHint — the Firefox ask-where setting, named after a download', () => {
  const FIREFOX = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:157.0) Gecko/20100101 Firefox/157.0';
  const FIREFOX_ANDROID = 'Mozilla/5.0 (Android 15; Mobile; rv:157.0) Gecko/157.0 Firefox/157.0';
  const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
  const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15';

  it('names the setting on desktop Firefox only', () => {
    expect(downloadSettingHint(FIREFOX)).toContain('“Always ask you where to save files”');
    expect(downloadSettingHint(FIREFOX)).toContain('Settings → General → Downloads');
    for (const ua of [FIREFOX_ANDROID, CHROME, SAFARI, '']) expect(downloadSettingHint(ua)).toBeNull();
  });

  it('goes under a download, and does not claim the download folder when Firefox may have asked', () => {
    const hint = downloadSettingHint(FIREFOX);
    const note = saveOutcomeNote({ kind: 'downloaded', name: 'R.ork' }, [], hint)!;
    expect(note).toEqual({
      text: `Saved “R.ork” as a download — to your download folder, unless Firefox asked you where. ${hint}`,
      severity: 'info',
    });
    // A save through the dialog, or a dialog whose write failed, is not Firefox's download.
    expect(saveOutcomeNote({ kind: 'saved', name: 'R.ork' }, [], hint)!.text).toBe('Saved “R.ork”.');
    expect(saveOutcomeNote({ kind: 'downloaded', name: 'R.ork', fellBack: 'disk full' }, [], hint)!.text)
      .not.toContain('Firefox');
    // Losses still go under it, one per line.
    expect(saveOutcomeNote({ kind: 'downloaded', name: 'R.rkt' }, ['lost'], hint)!.text.split('\n')).toEqual([
      `Saved “R.rkt” as a download — to your download folder, unless Firefox asked you where. ${hint}`, 'lost',
    ]);
  });
});
