import { useState } from 'react';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { strToU8, zipSync } from 'fflate';
import { usePrefs } from '../prefs/PrefsContext.js';
import { noticeQuantity } from '../prefs/units.js';
import { tubeWrapGeometry, tubeWrapPages } from '../services/tubeWrapGuide.js';
import { FIN_TEMPLATE_DPI, finTemplatePixelSize } from '../services/finTemplate.js';
import { safeName } from '../services/fileName.js';
import { svgToImage } from '../services/schematicExport.js';
import { withDpi } from '../services/rasterDpi.js';
import { downloadBlob } from '../services/saveFile.js';
import { FinTemplateMenu, type FinTemplateFormat } from './FinTemplateMenu.js';
import { Note } from './Note.js';
import { TUBE_HOLE_ADVICE } from '../tree/tubeHoles.js';

export function TubeWrapMenu({ tree, tube }: { tree: RocketTree; tube: ComponentNode }) {
  const { prefs } = usePrefs();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  let guide;
  let invalid: string | null = null;
  try { guide = tubeWrapGeometry(tree, tube); }
  catch (e) { invalid = e instanceof Error ? e.message : String(e); }
  const printAdvice = `Print at 100%, with no fit to page. Measure the ruler on every page: ${noticeQuantity('length', prefs.units.length === 'in' || prefs.units.length === 'ft' ? 0.0508 : 0.05, prefs.units.length === 'in' || prefs.units.length === 'ft' ? 'in' : prefs.units.length)}.`;

  const exportWrap = async (format: FinTemplateFormat) => {
    setBusy(true); setError(null); setStatus('Preparing tube wrap…');
    try {
      const geometry = tubeWrapGeometry(tree, tube);
      const pages = tubeWrapPages(geometry, tree.name ?? 'Rocket', prefs.units,
        format === 'svg-transparent' ? 'transparent' : 'white');
      const raster = format === 'png' || format === 'jpeg';
      const extension = raster ? format === 'png' ? 'png' : 'jpg' : 'svg';
      const stem = `${safeName(tube.name ?? 'tube', 'tube')}-wrap${format === 'svg-transparent' ? '-transparent' : ''}${raster ? `-${FIN_TEMPLATE_DPI}dpi` : ''}`;
      const files: Record<string, Uint8Array> = {};
      for (const page of pages) {
        let bytes: Uint8Array;
        if (raster) {
          const { width, height } = finTemplatePixelSize(page.svg);
          const image = await svgToImage(page.svg, width, format, height);
          bytes = withDpi(new Uint8Array(await image.arrayBuffer()), format, FIN_TEMPLATE_DPI);
        } else bytes = strToU8(page.svg);
        const filename = pages.length === 1 ? `${stem}.${extension}` : `${stem}-c${page.column}-r${page.row}.${extension}`;
        files[filename] = bytes;
      }
      if (pages.length === 1) {
        downloadBlob(new Blob([Object.values(files)[0]! as BlobPart], { type: raster ? `image/${format}` : 'image/svg+xml' }),
          `${stem}.${extension}`, 'Tube marking wrap');
      } else {
        files['README.txt'] = strToU8(`${tree.name ?? 'Rocket'} — ${geometry.name}: tube wrap\n\n${printAdvice}\n`
          + 'Pages fit both A4 and US Letter. Match the printed coordinates in the overlap, keeping the rows and columns in order.\n'
          + 'Trim at the tube outline and join its two seam edges, printed side out. The front of the tube is at the top.\n'
          + 'Solid lines mark fins; dashed lines mark lugs/buttons. Heavy ticks mark root ends or guide stations.\n'
          + 'Crosses mark hole centres; dashed circles show hole diameters where they fit on the page. Holes are fabrication only.\n'
          + 'Slot boxes use fin thickness, with no cutting allowance. Measure the tube and check the fit before cutting.\n'
          + geometry.notes.map(n => `${n === TUBE_HOLE_ADVICE ? '' : 'Caution: '}${n}\n`).join(''));
        const zip = zipSync(files);
        downloadBlob(new Blob([zip as BlobPart], { type: 'application/zip' }),
          `${stem}-${pages.length}-pages.zip`, 'Tube marking wrap pages');
      }
      setStatus(`${pages.length} ${pages.length === 1 ? 'page' : 'pages'} prepared.`);
    } catch (e) {
      setStatus(null);
      setError(`Could not export the tube wrap: ${e instanceof Error ? e.message : String(e)}`
        + (format === 'png' || format === 'jpeg' ? ' — try an SVG option.' : ''));
    } finally { setBusy(false); }
  };

  return <>
    <FinTemplateMenu template="tube-wrap" disabled={busy} onPick={exportWrap} />
    <Note as="p" tier="information" className="hint">{printAdvice} Larger wraps download as a ZIP of pages.</Note>
    <Note as="p" tier="caution" className="hint">Slots use fin thickness, with no cutting allowance. Measure the tube and check the fit before cutting.</Note>
    {guide?.notes.map(note => <Note as="p" key={note} tier={note === TUBE_HOLE_ADVICE ? 'information' : 'caution'} className="hint">{note}</Note>)}
    {invalid && <Note as="p" tier="caution" className="hint">{invalid}</Note>}
    <div role="status">{status && <p className="hint">{status}</p>}</div>
    {/* Always mounted (audit 2026-09-22): an alert inserted with its text already in place is announced unreliably. */}
    <div className="tube-wrap-alert" role="alert">{error && <Note as="p" tier="caution" className="hint">{error}</Note>}</div>
  </>;
}
