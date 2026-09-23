import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * extract-nozzle-pdfs.py's STDOUT IS A JSON CHANNEL, and nothing else may reach
 * it (audit 2026-09-22).
 *
 * build-nozzle-db.mjs does `JSON.parse(execFileSync(python, [extractor]))`, so
 * a single stray line ahead of the document fails the whole build. That
 * happened once through the old `import fitz` deprecation warning; the second
 * way in was MuPDF's own "MuPDF error: ..." lines, which PyMuPDF prints to
 * stdout by default and which any damaged PDF in a 1,074-file download
 * produces. The extractor now routes them to stderr.
 *
 * RUNS ONLY WHERE THE EXTRACTOR CAN. It needs Python with PyMuPDF, which exist
 * on the machine that holds `docs/RCS Schematics` and nowhere else — not on CI,
 * and not on the laptop — exactly like the builder itself. Where they are
 * missing the extractor cannot run at all, so there is no channel to check;
 * this is the check for the one machine where a damaged PDF can reach it.
 */
const here = dirname(fileURLToPath(import.meta.url));
const python = process.env.PYTHON ?? 'python';
const hasPyMuPDF = spawnSync(python, ['-c', 'import pymupdf'], { stdio: 'ignore' }).status === 0;

/**
 * A one-page PDF whose embedded TrueType program is not a font. Opening it is
 * fine; reading its text makes MuPDF report "FT_New_Memory_Face(...): unknown
 * file format" — the same shape as the "hmtx table missing" a truncated copy
 * of a real drawing in this set produced when this was measured.
 */
const MAKE_DAMAGED_PDF = `
import sys, pymupdf
doc = pymupdf.open()
page = doc.new_page()
page.insert_text((72, 72), "NOZZLE", fontname="helv")
font = [x for x in range(1, doc.xref_length()) if doc.xref_get_key(x, 'Type')[1] == '/Font'][0]
program = doc.get_new_xref()
doc.update_object(program, '<<>>')
doc.update_stream(program, b'not a font program at all', new=True)
desc = doc.get_new_xref()
doc.update_object(desc, f'<</Type/FontDescriptor/FontName/Broken/Flags 32/FontBBox[0 0 1000 1000]'
    f'/ItalicAngle 0/Ascent 800/Descent -200/CapHeight 700/StemV 80/FontFile2 {program} 0 R>>')
doc.update_object(font, f'<</Type/Font/Subtype/TrueType/BaseFont/Broken/FirstChar 32/LastChar 126'
    f'/Widths[{" ".join(["500"] * 95)}]/FontDescriptor {desc} 0 R>>')
doc.save(sys.argv[1])
`;

describe.runIf(hasPyMuPDF)('extract-nozzle-pdfs.py on a damaged PDF', () => {
  // Two Python start-ups and a PyMuPDF import take seconds, not milliseconds,
  // so vitest's default 5 s would be a budget this machine's own load could break.
  it('keeps MuPDF\'s error lines off stdout, so the JSON still parses', { timeout: 60_000 }, () => {
    const root = mkdtempSync(join(tmpdir(), 'nozzle-extract-'));
    try {
      mkdirSync(join(root, 'Nozzles'));
      const made = spawnSync(python, ['-c', MAKE_DAMAGED_PDF, join(root, 'Nozzles', 'rcs_09999_nozzle_dwg.pdf')],
        { encoding: 'utf8' });
      expect(made.status, made.stderr).toBe(0);

      const run = spawnSync(python, [join(here, 'extract-nozzle-pdfs.py'), root],
        { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
      expect(run.status, run.stderr).toBe(0);
      // The fixture really is damaged: MuPDF complained, on the channel meant for it.
      expect(run.stderr).toMatch(/MuPDF error/);
      expect(run.stdout).not.toMatch(/MuPDF/);
      const out = JSON.parse(run.stdout);
      expect(out.nozzleDrawings.map((d) => d.file)).toEqual(['Nozzles/rcs_09999_nozzle_dwg.pdf']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
