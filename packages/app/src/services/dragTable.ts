import type { DragSweep } from '@online-openrocket/engine';
import { fmtSi, siToUi } from '../prefs/units.js';
import { APP_VERSION } from '../version.js';
import { hasAerodynamicForce } from './simReport.js';
import { foldTypography, oneLine } from './textFold.js';

/**
 * THE DRAG TABLE (.csv) — the Drag analysis panel's export, built here as
 * text; the panel only downloads it. Moved out of components/DragPanel.tsx
 * (audit 2026-09-22, extractions carried from 8 September): every other
 * exporter in the app lives in src/services/. DragPanel.cp.test.tsx pins the
 * file byte for byte through the panel; dragTable.test.ts tests it here.
 */

/**
 * CP per Mach as the chart and the CSV report it: `null` wherever the sweep's
 * plane makes no normal force.
 *
 * The sweep is ONE roll plane, and where its CNa is zero the kernel reports
 * cp = 0 — the nose tip — which is not a position but "nothing to measure"
 * (simReport.hasAerodynamicForce, the test the stat tiles use). Measured on
 * the real kernel: a 300 mm tube with two fins and no nose makes no lift in
 * that plane at any of the 60 sweep points, and the chart drew a flat 0 % —
 * a CP at the nose tip — until the 2026-09-22 audit.
 */
export function sweepCp(sweep: DragSweep): (number | null)[] {
  return sweep.cp.map((v, i) => (hasAerodynamicForce({ cna: sweep.cna[i] ?? 0 }) ? v : null));
}

export interface DragTableMeta {
  design: string;
  aeroModel: string;
  /** The length unit symbol the cp column and the roll line are written in. */
  lengthUnit: string;
  /** The SAME sentence the chart caption prints (DragPanel's conditionsText). */
  conditions: string;
  /** DragPanel's rollDependentCp for the design, when its CP depends on roll angle (m). */
  rollCp?: number | null;
}

/**
 * The full aerodynamic-coefficient table (RASAero feature #6: CD both power
 * states + CP + CNa vs Mach) — usable as input to external trajectory codes.
 * The leading #-comment lines say which app, design and aero model produced
 * the table: a bare drag-analysis.csv travels (one was posted to a forum as
 * the Supersonic model's curve when it was the classic model's).
 */
export function dragTableCsv(sweep: DragSweep, meta: DragTableMeta): string {
  const cols: [string, (number | null)[]][] = [
    ['mach', sweep.machs],
    ['cd_power_off', sweep.powerOff.total],
    ['cd_power_on', sweep.powerOn.total],
    // An empty cell where the sweep's plane makes no lift (sweepCp), never the
    // kernel's 0 — a trajectory code reads 0 as a CP at the nose tip.
    [`cp_${meta.lengthUnit}_from_nose`,
      sweepCp(sweep).map((v) => (v == null ? v : siToUi('length', meta.lengthUnit, v)))],
    ['cna_per_rad', sweep.cna],
    ['friction', sweep.powerOff.friction],
    ['pressure', sweep.powerOff.pressure],
    ['base_power_off', sweep.powerOff.base],
    ['base_power_on', sweep.powerOn.base],
    ...sweep.components.map((c): [string, number[]] =>
      [`cd_${oneLine(foldTypography(c.name)).replace(/[,\s]+/g, '_')}`, c.cd]),
  ];
  // Every header line is one line (oneLine: a newline in the design name would
  // break the comment block, and a comma would read as extra CSV
  // cells in naive parsers — the same reason the conditions line avoids its
  // own comma) and carries the app's typography folded to ASCII. The file
  // ships with no BOM, because its leading `#` block has to be the first bytes
  // for the tools that read it (services/fileName.ts, CSV_BOM) — so Excel
  // decodes it as ANSI, and the "20 °C — the kernel default" of the sea-level
  // line opened as "20 Â°C â€” the kernel default" (audit 2026-09-22). A name
  // the user wrote in another script still passes through as UTF-8: folding
  // it would throw the name away.
  const header = (s: string) => oneLine(foldTypography(s)).replace(/,/g, ';');
  const rows = [
    `# MMRocket Sim ${APP_VERSION}`,
    `# design: ${header(meta.design)}`,
    `# aero model: ${header(meta.aeroModel)}`,
    `# conditions: ${header(meta.conditions)}`,
    // One more comment line ONLY for a design whose CP depends on its roll
    // angle (rollDependentCp): the cp column is one roll plane, and a file that
    // travels without the chart's caption must still say so. Every other
    // design's file keeps the four-line block it always had.
    ...(meta.rollCp != null
      ? ['# cp: one roll plane (theta = 0 with the fins as drawn) - this design\'s CP depends on'
        + ' roll angle; the app\'s stability margin uses the forward-most CP over all roll angles: '
        + `${fmtSi('length', meta.lengthUnit, meta.rollCp, 3)} ${meta.lengthUnit} from nose`]
      : []),
    cols.map(([h]) => h).join(','),
  ];
  for (let i = 0; i < sweep.machs.length; i++) {
    rows.push(cols.map(([, v]) => (v[i] == null ? '' : v[i])).join(','));
  }
  return rows.join('\n');
}
