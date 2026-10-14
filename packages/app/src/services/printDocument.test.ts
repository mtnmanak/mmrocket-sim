// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { openPrintDocument, printDocument } from './printDocument.js';

afterEach(() => vi.restoreAllMocks());
it('opens a script-free preview with a keyboard-focused print action; printing waits for that action', () => {
  const doc = document.implementation.createHTMLDocument('Preview');
  const print = vi.fn(), focus = vi.fn();
  const preview = { document: doc, print, focus, opener: window };
  vi.spyOn(window, 'open').mockReturnValue(preview as unknown as Window);
  const html = printDocument('Rocket <&>', '<main>Flight results</main>');
  openPrintDocument(html);
  expect(doc.title).toContain('Rocket <&>');
  expect(doc.querySelector('script')).toBeNull();
  expect(doc.body.textContent).toContain('Flight results');
  expect(print).not.toHaveBeenCalled();
  expect(preview.opener).toBeNull();
  const button = doc.getElementById('print-document')!;
  expect(doc.activeElement).toBe(button);
  button.click(); expect(print).toHaveBeenCalledOnce(); expect(focus).toHaveBeenCalledOnce();
});
it('reports pop-up refusal instead of silently doing nothing', () => {
  vi.spyOn(window, 'open').mockReturnValue(null);
  expect(() => openPrintDocument(printDocument('Rocket', ''))).toThrow(/blocked.*Allow pop-ups/);
});
it('gives templates zero print margins and fixed physical page sizes, while fitting report pages separately', () => {
  const template = printDocument('Ring', '<section class="template-page"></section>', true);
  expect(template).toContain('@page { margin:0; }');
  expect(template).toContain('width:210mm; height:279mm');
  expect(template).toContain('100%, with no fit to page');
  expect(printDocument('Report', '')).toContain('@page { margin:10mm; }');
});
