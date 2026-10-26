import { useId, useState } from 'react';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { usePrefs } from '../prefs/PrefsContext.js';
import { noticeQuantity, siToUi, uiToSi } from '../prefs/units.js';
import { finAlignmentJigGeometry, finAlignmentJigSvg } from '../services/finAlignmentJig.js';
import { FIN_TEMPLATE_DPI, finTemplatePixelSize } from '../services/finTemplate.js';
import { safeName } from '../services/fileName.js';
import { svgToImage } from '../services/schematicExport.js';
import { assertRasterizable, withDpi } from '../services/rasterDpi.js';
import { downloadBlob } from '../services/saveFile.js';
import { FinTemplateMenu, type FinTemplateFormat } from './FinTemplateMenu.js';
import { Note } from './Note.js';
import { NumField } from './NumField.js';
import { UnitChip } from './UnitChip.js';

export function FinAlignmentJigMenu({ tree, tube, fin }: { tree: RocketTree; tube: ComponentNode; fin: ComponentNode }) {
  const { prefs } = usePrefs();
  const id = useId();
  const [clearance, setClearance] = useState(0.0002);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const unit = prefs.units.length;
  let invalid: string | null = null;
  try { finAlignmentJigGeometry(tube, fin, clearance); }
  catch (e) { invalid = e instanceof Error ? e.message : String(e); }
  const ruler = noticeQuantity('length', unit === 'in' || unit === 'ft' ? 0.0508 : 0.05, unit === 'in' || unit === 'ft' ? 'in' : unit);
  const printAdvice = `Print at 100%, with no fit to page. Measure the ruler: ${ruler}. Use paper large enough for the whole jig.`;

  const exportJig = async (format: FinTemplateFormat) => {
    setBusy(true); setError(null); setStatus('Preparing fin alignment jig…');
    try {
      const svg = finAlignmentJigSvg(tube, fin, clearance, tree.name ?? 'Rocket', prefs.units,
        format === 'svg-transparent' ? 'transparent' : 'white');
      const raster = format === 'png' || format === 'jpeg';
      let blob = new Blob([svg], { type: 'image/svg+xml' });
      if (raster) {
        const { width, height } = finTemplatePixelSize(svg);
        assertRasterizable(width, height);
        const image = await svgToImage(svg, width, format, height);
        const bytes = withDpi(new Uint8Array(await image.arrayBuffer()), format, FIN_TEMPLATE_DPI);
        blob = new Blob([bytes as BlobPart], { type: `image/${format}` });
      }
      const stem = `${safeName(fin.name ?? 'fins', 'fins')}-alignment-jig${format === 'svg-transparent' ? '-transparent' : ''}${raster ? `-${FIN_TEMPLATE_DPI}dpi` : ''}`;
      downloadBlob(blob, `${stem}.${raster ? format === 'png' ? 'png' : 'jpg' : 'svg'}`, 'Fin alignment jig');
      setStatus('Fin alignment jig prepared.');
    } catch (e) {
      setStatus(null);
      setError(`Could not export the fin alignment jig: ${e instanceof Error ? e.message : String(e)}`
        + (format === 'png' || format === 'jpeg' ? ' — try an SVG option.' : ''));
    } finally { setBusy(false); }
  };

  return <div style={{ marginTop: 8 }}>
    <div className="field">
      <label htmlFor={id}>Slot clearance <UnitChip quantity="length" /></label>
      <NumField id={id} ariaLabel={`Slot clearance (${unit})`} describedBy={`${id}-help`}
        value={siToUi('length', unit, clearance)} min={0} max={siToUi('length', unit, 0.01)}
        step={siToUi('length', unit, 0.0001)} onCommit={v => { if (v !== null) setClearance(uiToSi('length', unit, v)); }} />
      <p id={`${id}-help`} className="hint">Slot width = fin thickness + total clearance across both sides. This setting is only for the jig and is not saved with the design.</p>
    </div>
    <FinTemplateMenu template="fin-jig" disabled={busy} onPick={exportJig} />
    <Note as="p" tier="information" className="hint">{printAdvice}</Note>
    <Note as="p" tier="caution" className="hint">Measure the actual tube and fin stock; check the fit before cutting. Place the jig where every fin fills the slot depth. The jig does not set fin cant.</Note>
    {invalid && <Note as="p" tier="caution" className="hint">{invalid}</Note>}
    <div role="status">{status && <p className="hint">{status}</p>}</div>
    {error && <Note as="p" tier="caution" className="hint" role="alert">{error}</Note>}
  </div>;
}
