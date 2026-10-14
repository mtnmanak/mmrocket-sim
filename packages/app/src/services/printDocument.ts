import { escapeXml } from './xmlUtil.js';

/** Paper uses dark ink on white, independent of the screen theme. */
export function printDocument(title: string, body: string, templates = false): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeXml(title)} — MMRocket Sim</title><style>
* { box-sizing: border-box; } body { color:#000; background:#fff; font:14px/1.4 Arial,sans-serif; margin:16px; }
h1 { font-size:22px; margin:0 0 8px; overflow-wrap:anywhere; } h2 { font-size:16px; margin:12px 0 4px; break-after:avoid; }
p { margin:4px 0; } button { font:inherit; padding:8px 12px; border:2px solid #000; background:#fff; color:#000; cursor:pointer; }
button:focus-visible { outline:3px solid #000; outline-offset:3px; } button:hover { background:#eee; }
.toolbar { margin-bottom:16px; } .report { max-width:1000px; margin:auto; } .summary { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:4px 20px; }
.summary p { overflow-wrap:anywhere; } .note { border-left:3px solid #000; padding-left:8px; break-inside:avoid; }
.caution { color:#684500; } .danger { color:#a00000; } .schematic { width:100%; max-height:100px; }
table { border-collapse:collapse; width:100%; table-layout:fixed; font-size:12px; } th,td { text-align:left; vertical-align:top; padding:4px; border-bottom:1px solid #777; overflow-wrap:anywhere; }
thead { display: table-header-group; } tr { break-inside: avoid; } th:first-child { width:22%; } th:nth-child(3) { width:36%; }
.template-page { margin:0; width:210mm; height:279mm; break-after:page; } .template-page:last-child { break-after:auto; }
.template-page svg { display:block; width:210mm; height:279mm; } .template-scroll { overflow-x:auto; }
@media(max-width:500px) { .summary { grid-template-columns:1fr; } th,td { padding:3px; } }
@page { margin:${templates ? '0' : '10mm'}; }
@media print { .toolbar { display:none; } body { margin:0; font-size:10px; } h1 { font-size:18px; } h2 { font-size:12px; }
.summary { grid-template-columns:repeat(2,minmax(0,1fr)); } table { font-size:9px; } th,td { padding:3px; }
.template-scroll { overflow:visible; } .template-page { break-inside:avoid; } }
</style></head><body><div class="toolbar"><button id="print-document" type="button">Print / Save as PDF</button>
<p>${templates ? 'Use A4 or US Letter at 100%, with no fit to page and no margins. Check the ruler on every sheet.'
    : 'Choose Save as PDF in the browser print dialog. Short designs fit one page; longer parts lists continue on further pages.'}</p></div>${body}</body></html>`;
}

/** Synchronous user action so browsers can open the preview. */
export function openPrintDocument(html: string): void {
  const preview = window.open('', '_blank');
  if (!preview) throw new Error('The browser blocked the print preview. Allow pop-ups for the app, then try again.');
  preview.opener = null;
  preview.document.open(); preview.document.write(html); preview.document.close();
  const button = preview.document.getElementById('print-document');
  button?.addEventListener('click', () => { preview.focus(); preview.print(); });
  button?.focus();
}
