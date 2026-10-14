import type { ComponentInfo, ComponentNode, RocketTree, StaticInfo } from '@online-openrocket/engine';
import { fmtSi, type Quantity, type UnitSelection } from '../prefs/units.js';
import { layoutSchematic, schematicFrame, type SchematicShape } from '../tree/schematicLayout.js';
import { componentTable } from './componentTable.js';
import { asStageNodes } from '../tree/treeModel.js';
import { solidContextFor } from '../tree/solidContext.js';
import { centeringRingBore, ringOuterRadius } from '../tree/solidMesh.js';
import { formatWarning } from './simWarnings.js';
import { recordedConfiguration, runConfigurationHeading } from './runConfiguration.js';
import { dataHeaderLines, EXPORT_VARS } from './schematicExport.js';
import { aeroModelLabel, commentsOf, formatRunStability, formatRunWhenProse, formatStability, hasAerodynamicForce, listAnd,
  type DeploymentReport, type SimRun, type StabilityUnit } from './simReport.js';
import { escapeXml } from './xmlUtil.js';
import { printDocument } from './printDocument.js';

export interface DesignPrintInput {
  tree: RocketTree; info: StaticInfo | null; units: UnitSelection;
  radiusMode: 'radius' | 'diameter'; stabilityUnit?: StabilityUnit;
  withMotors: boolean; appVersion: string;
  currentLoadout?: string;
  infoFor?: (id: string) => ComponentInfo | null;
  run: SimRun | null; changedSince: readonly string[] | null;
}
const e = (value: unknown) => escapeXml(String(value));
const p = (s: string) => `<p>${e(s)}</p>`;
const note = (s: string, tier: 'information' | 'caution' | 'danger' = 'information') =>
  `<p class="note ${tier}">${tier === 'information' ? '' : `${tier === 'caution' ? 'Caution' : 'Danger'}: `}${e(s)}</p>`;

function schematic(tree: RocketTree): string {
  const frame = schematicFrame(tree, { cw: 900, chPx: 120, maxHeight: 120, rulers: false,
    rollW: 0, rollBar: 0, lanes: false, topReserve: 0 });
  const layout = layoutSchematic(tree, { ...frame, roll: 0, idPrefix: 'print' });
  const shape = (s: SchematicShape): string => {
    const attrs = Object.entries(s.attrs).filter(([, v]) => typeof v === 'string' || typeof v === 'number')
      .map(([k, v]) => `${k.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}="${e(v)}"`).join(' ');
    return `<${s.tag} ${attrs}>${s.text === undefined ? '' : e(s.text)}${(s.children ?? []).map(shape).join('')}</${s.tag}>`;
  };
  const clips = layout.clips.map(c => `<clipPath id="${e(c.id)}"><rect x="-100000" y="-100000" width="200000" height="${c.top + 100000}"/>
<rect x="-100000" y="${c.bottom}" width="200000" height="100000"/></clipPath>`).join('');
  let svg = `<svg class="schematic" aria-label="Current design schematic" role="img" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${frame.w} ${frame.h}"><defs>
<pattern id="bulkhead-hatch" patternUnits="userSpaceOnUse" width="5" height="5"><path d="M0 5 L5 0" stroke="#66748c" stroke-width="0.9"/></pattern>${clips}</defs>${layout.shapes.map(shape).join('')}</svg>`;
  for (const [variable, ink] of EXPORT_VARS) svg = svg.split(variable).join(ink);
  return svg;
}

/** C-A6: the selected flight never borrows figures from today's build. */
export function designPrintHtml(input: DesignPrintInput): string {
  const { tree, info, units: u, run } = input;
  const val = (q: Quantity, v: number | null | undefined, digits?: number) =>
    v === null || v === undefined || !Number.isFinite(v) ? 'Unknown' : `${fmtSi(q, u[q], v, digits)} ${u[q]}`;
  const sec = (v: number | null | undefined) => v == null || !Number.isFinite(v) ? 'Unknown' : `${Number(v.toFixed(3))} s`;
  const table = componentTable(tree, input, input.infoFor);
  const nodes: ComponentNode[] = [];
  const walk = (children: ComponentNode[]) => { for (const n of children) { nodes.push(n); walk(n.children ?? []); } };
  for (const stage of asStageNodes(tree)) walk(stage.children ?? []);
  const cells = table.rows.map((row, index) => {
    const dimensions = [6, ...table.headers.map((_, i) => i).filter(i => i >= 11 && /\((?:mm|cm|m|in|ft|°|rad)\)/.test(table.headers[i]!))]
      .filter(i => row[i] !== '').map(i => `${String(table.headers[i])}: ${String(row[i])}`).join('; ');
    const n = nodes[index];
    const ringDimensions: string[] = [];
    if (n && (n.type === 'centeringring' || n.type === 'bulkhead')) {
      const ctx = solidContextFor(tree, n), outer = ringOuterRadius(n, ctx);
      ringDimensions.push(`Outside diameter: ${val('length', outer.assumed ? null : 2 * outer.r, 3)}`);
      if (n.type === 'centeringring') {
        const bore = centeringRingBore(n, ctx, outer.r);
        ringDimensions.push(`Opening diameter: ${val('length', !outer.assumed && bore !== undefined && bore > 0 && bore < outer.r ? 2 * bore : null, 3)}`);
      }
    }
    return `<tr><td>${e(row[0])}<br>${e(row[1])}<br>${e(row[2])}</td><td>${e(row[4] || 'Unknown')}</td>
<td>${e([dimensions, ...ringDimensions].filter(Boolean).join('; ') || 'Unknown')}</td><td>${e(row[7])}</td><td>${e(row[8] === '' ? 'Unknown' : row[8])}</td></tr>`;
  }).join('');
  const header = dataHeaderLines({ name: tree.name ?? 'Rocket', info, units: u, withMotors: input.withMotors, appVersion: input.appVersion });
  if (info && hasAerodynamicForce(info)) header[3] = header[3]!.replace(/margin .*/, `margin ${formatStability(info, input.stabilityUnit)}`);
  const body = [`<main class="report"><h1>${e(tree.name ?? 'Rocket')}</h1><h2>Current design</h2>`,
    ...header.slice(1).map(p),
    p(`Current configuration and motor assignments: ${input.currentLoadout ?? 'Unknown'}`),
    ...(info ? [] : [note('Design summary unavailable: the current design has no completed build.', 'caution')]),
    schematic(tree), p('Schematic is fitted to the report, not a 1:1 cutting template.'),
    '<h2>Parts in the current design</h2>', p('Mass counts all copies of each part, including all fins of a fin set; parent mass excludes children. Unknown means no computed figure is available.'),
    `<table><thead><tr><th scope="col">Part / type / stage</th><th scope="col">Material</th><th scope="col">Dimensions</th><th scope="col">Copies</th><th scope="col">Mass (${e(u.mass)})</th></tr></thead><tbody>${cells}</tbody></table>`,
    '<h2>Selected flight / range card</h2>'];
  if (!run) body.push(p('No flight selected. Open a saved simulation or launch a flight, then print again.'));
  else {
    const stability = formatRunStability(run.launchStaticMarginCal, run.launchStaticMarginPct, input.stabilityUnit);
    body.push(p(`${run.rocket} — ${run.manufacturer} ${run.motor} — flown ${formatRunWhenProse(run.when)}`), p(`Run ID: ${run.id}`),
      p(`Configuration: ${recordedConfiguration(run) ?? 'Unknown'}${run.motorConfig ? ` (${run.motorConfig})` : ''}`),
      p(runConfigurationHeading(run, u.distance)),
      p(`Motor count: ${run.motorCount ?? (run.importedSummary ? 'Unknown' : 1)}; ejection delay flown: ${sec(run.delayS)}`),
      ...((run.boosterMotors ?? []).map(m => p(`Other motor: ${m}`))),
      p(`Aerodynamics: ${aeroModelLabel(run.aeroModel, run.rogersKbf)}`));
    if (run.importedSummary) body.push(note('Imported summary. Design match and safety are unknown; only the file’s recorded predictions are shown.', 'caution'));
    else if (input.changedSince === null) body.push(note('Design match unknown. These stored results cannot establish a match with the current design.', 'caution'));
    else if (input.changedSince.length) body.push(note(`${listAnd(input.changedSince)} changed since this flight. Its results describe the earlier rocket and conditions.`, 'caution'));
    else body.push(p('This flight matches the current design, motors, conditions and model.'));
    const results = [
      `Apogee: ${val('distance', run.maxAltitude)}; time to apogee: ${sec(run.timeToApogee)}`,
      `Peak ground speed: ${val('velocity', run.maxVelocity)}; Mach: ${Number.isFinite(run.maxMach) ? run.maxMach : 'Unknown'}`,
      `Peak acceleration: ${val('acceleration', run.maxAcceleration)}`,
      `Launch mass: ${val('mass', run.launchMass)}; recovery mass: ${val('mass', run.burnoutMassSettled ? run.burnoutMass : null)}`,
      `Launch CG: ${val('length', run.launchCG, 3)}; launch CP: ${val('length', run.launchCP, 3)}`,
      `Launch stability: ${stability.value} ${stability.unit}`,
      `Guide exit speed: ${val('velocity', run.rodExitVelocity)}; thrust : weight: ${run.thrustToWeightAtRod ?? 'Unknown'}`,
      `Wind: ${val('windspeed', run.windAvg)}; density altitude: ${val('distance', run.densityAltitudeM)}`,
      `Descent rate at landing: ${val('velocity', run.landingRate)}; impact ground speed: ${val('velocity', run.groundHitVelocity)}`,
      `Flight time: ${sec(run.totalFlightTime)}; landing distance: ${val('distance', run.landingDistanceM)}`,
      `Optimal delay: ${sec(run.optimumDelayS)}; recommended drill-to-fit delay: ${sec(run.recommendedDelayS)}`,
    ];
    body.push(`<div class="summary">${results.map(p).join('')}</div>`, '<h2>Recovery</h2>');
    const deployment = (d: DeploymentReport) => p(`${d.device}: opens at ${sec(d.time)}, ${val('distance', d.altitude)}; opening speed ${val('velocity', d.velocityAtDeployment)}; descent ${val('velocity', d.descentRate)}; ground speed ${val('velocity', d.groundSpeed)}; Cd ${d.cd ?? 'Unknown'}; diameter ${val('length', d.diameter, 3)}.`);
    if (run.deployments?.length) body.push(...run.deployments.map(deployment));
    else body.push(p(`Recovery device details unavailable. First recorded deployment: ${val('distance', run.altitudeAtDeployment)}; opening speed ${val('velocity', run.velocityAtDeployment)}.`));
    for (const branch of run.branches ?? []) body.push(p(`${branch.name}: ${branch.motorLabel ?? 'motor unknown'}; apogee ${val('distance', branch.apogee)}; recovery mass ${val('mass', branch.recoveryMass)}; landing descent ${val('velocity', branch.landingRate)}${branch.tumbles ? '; tumble recovery' : ''}.`), ...branch.deployments.map(deployment));
    body.push(...commentsOf(run).map(c => note(c.text, c.level === 'warning' ? 'danger' : c.level === 'caution' ? 'caution' : 'information')));
    for (const warning of run.simWarnings ?? []) {
      const w = formatWarning(warning, u);
      body.push(note(`${w.label}${w.detail ? ` — ${w.detail}` : ''} (${w.code})`, w.tier));
    }
    body.push(note('These are simulated predictions, not flight measurements or certification. Check the built rocket and launch conditions before flight.'));
  }
  body.push(p('MMRocket Sim uses the OpenRocket 24.12 core; GPL-3.0-or-later. mmrsim.mountainmanrockets.com'), '</main>');
  return printDocument(`${tree.name ?? 'Rocket'} — design and flight report`, body.join('\n'));
}
