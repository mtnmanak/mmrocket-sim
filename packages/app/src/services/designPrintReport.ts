import type { ComponentInfo, ComponentNode, RocketTree, StaticInfo } from '@online-openrocket/engine';
import { fmtSi, type Quantity, type UnitSelection } from '../prefs/units.js';
import { layoutSchematic, schematicFrame, type SchematicShape } from '../tree/schematicLayout.js';
import { componentTable } from './componentTable.js';
import { asStageNodes, mountName } from '../tree/treeModel.js';
import { solidContextFor } from '../tree/solidContext.js';
import { kernelFinPoints } from '../tree/finOutline.js';
import { finRootChord } from '../tree/finTab.js';
import { finOutline } from './finTemplate.js';
import { paperRingDimensions, paperRingOuterRadius } from './paperTemplates.js';
import { validDelayResolution } from './autoDelaySolver.js';
import { formatWarning } from './simWarnings.js';
import { recordedConfiguration, runConfigurationHeading } from './runConfiguration.js';
import { dataHeaderLines, EXPORT_VARS } from './schematicExport.js';
import { aeroModelLabel, commentsOf, formatRunStability, formatRunWhenProse, formatStability, hasAerodynamicForce, describeRunChanges,
  type DeploymentReport, type SimRun, type StabilityUnit } from './simReport.js';
import { escapeXml } from './xmlUtil.js';
import { printDocument } from './printDocument.js';

export interface DesignPrintInput {
  tree: RocketTree; info: StaticInfo | null; units: UnitSelection;
  radiusMode: 'radius' | 'diameter'; stabilityUnit?: StabilityUnit;
  withMotors: boolean; appVersion: string;
  currentLoadout?: string;
  motorFailures?: readonly { mountId: string; text: string }[];
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
    const finDimensions: string[] = [];
    if (n?.type === 'freeformfinset') {
      const points = kernelFinPoints(finOutline(n).map(({ x, y }) => [x, y]));
      finDimensions.push(`Root chord: ${val('length', finRootChord({ ...n, points }), 3)}`,
        `Span from root: ${val('length', Math.max(...points.map(([, y]) => y)), 3)}`,
        `Axial extent: ${val('length', Math.max(...points.map(([x]) => x)) - Math.min(...points.map(([x]) => x)), 3)}`);
    }
    const ringDimensions: string[] = [];
    let ringCaution = '';
    if (n && (n.type === 'centeringring' || n.type === 'bulkhead')) {
      try {
        const ctx = solidContextFor(tree, n);
        const outer = paperRingOuterRadius(n, ctx);
        ringDimensions.push(`Outside diameter: ${val('length', 2 * outer, 3)}`);
        const { bore } = paperRingDimensions(n, ctx);
        if (bore !== undefined) ringDimensions.push(`Opening diameter: ${val('length', 2 * bore, 3)}`);
      } catch (error) {
        if (!ringDimensions.length) ringDimensions.push('Outside diameter: Unknown');
        if (n.type === 'centeringring') ringDimensions.push('Opening diameter: Unknown');
        ringCaution = note(`${error instanceof Error ? error.message : 'Ring dimensions unavailable.'} Do not cut from unresolved dimensions.`, 'caution');
      }
    }
    const materials = [`Material density (${u.density})`, 'Surface density (kg/m²)', 'Line material', 'Line density (kg/m)',
      'Fillet material', `Fillet material density (${u.density})`]
      .map(label => ({ label, value: row[table.headers.indexOf(label)] }))
      .filter(({ label, value }) => value !== '' && value !== undefined && !(label === 'Line material' && n?.type === 'shockcord'))
      .map(({ label, value }) => `${label}: ${String(value)}`);
    return `<tr><td>${e(row[0])}<br>${e(row[1])}<br>${e(row[2])}</td><td>${[e(row[4] || 'Unknown'), ...materials.map(e)].join('<br>')}</td>
<td>${e([dimensions, ...finDimensions, ...ringDimensions].filter(Boolean).join('; ') || 'Unknown')}${ringCaution}</td><td>${e(row[7])}</td><td>${e(row[8] === '' ? 'Unknown' : row[8])}</td></tr>`;
  }).join('');
  const header = dataHeaderLines({ name: tree.name ?? 'Rocket', info, units: u, withMotors: input.withMotors, appVersion: input.appVersion });
  if (info && hasAerodynamicForce(info)) header[3] = header[3]!.replace(/margin .*/, `margin ${formatStability(info, input.stabilityUnit)}`);
  const failures = input.motorFailures ?? [];
  const omitted = (id: string) => `${mountName(nodes.find(n => n.id === id))} (${id})`;
  // C-A6: a partial build is valid, but cannot describe the complete assigned loadout.
  if (info && failures.length) {
    header[2] = `Dry mass ${val('mass', info.massEmpty)}; loaded mass for the complete assigned loadout: Unknown`;
    header[3] = 'CG, CP and stability for the complete assigned loadout: Unknown';
  }
  const body = [`<main class="report"><h1>${e(tree.name ?? 'Rocket')}</h1><h2>Current design</h2>`,
    ...header.slice(1).map(p),
    ...(failures.length ? [note(`The current build omits motors on ${failures.map(f => omitted(f.mountId)).join('; ')}. Its mass, CG and stability do not describe the complete assigned loadout. With all assigned motors, the rocket can have more mass and less stability margin.`, 'caution')] : []),
    p(`Current configuration and motor assignments: ${input.currentLoadout ?? 'Unknown'}`),
    ...failures.map(f => note(`Motor omitted from build on ${omitted(f.mountId)}: ${f.text}`, 'caution')),
    ...(info ? [] : [note('Design summary unavailable: the current design has no completed build.', 'caution')]),
    schematic(tree), p('Schematic is fitted to the report, not a 1:1 cutting template.'),
    '<h2>Parts in the current design</h2>', p('Mass counts all copies of each part, including all fins of a fin set; parent mass excludes children. Unknown means no computed figure is available.'),
    `<table><thead><tr><th scope="col">Part / type / stage</th><th scope="col">Material</th><th scope="col">Dimensions</th><th scope="col">Copies</th><th scope="col">Mass (${e(u.mass)})</th></tr></thead><tbody>${cells}</tbody></table>`,
    '<h2>Selected flight / range card</h2>'];
  if (!run) body.push(p('No flight selected. Open a saved simulation or launch a flight, then print again.'));
  else {
    const stability = formatRunStability(run.launchStaticMarginCal, run.launchStaticMarginPct, input.stabilityUnit);
    const motorCountScope = run.importedSummary ? 'scope not recorded'
      : run.batch || run.motorConfig ? 'candidate group' : 'primary mount/group';
    body.push(p(`${run.rocket} — ${run.manufacturer} ${run.motor} — flown ${formatRunWhenProse(run.when)}`), p(`Run ID: ${run.id}`),
      p(`Configuration: ${recordedConfiguration(run) ?? 'Unknown'}${run.motorConfig ? ` (${run.motorConfig})` : ''}`),
      p(runConfigurationHeading(run, u.altitude)),
      p(`Motor count (${motorCountScope}): ${run.motorCount ?? 'Unknown'}`),
      p('Complete flight motor count: Unknown (not recorded).'),
      ...((run.boosterMotors ?? []).map(m => p(`Other motor: ${m}`))),
      p(`Aerodynamics: ${aeroModelLabel(run.aeroModel, run.rogersKbf)}`));
    if (run.importedSummary) body.push(note('Imported summary. Design match and safety are unknown; only the file’s recorded predictions are shown.', 'caution'));
    else if (input.changedSince === null) body.push(note('Design match unknown. These stored results cannot establish a match with the current design.', 'caution'));
    else if (input.changedSince.length) body.push(note(`${describeRunChanges(input.changedSince, 'since this flight')}. Its results describe the earlier rocket and conditions.`, 'caution'));
    else body.push(p('This flight matches the current design, motors, conditions and model.'));
    if (validDelayResolution(run.delayResolution)) {
      const rows = run.delayResolution.mounts.map(m => {
        const flown = m.flownDelay === 'plugged' ? 'plugged — no ejection charge' : sec(m.flownDelay);
        const marks = (m.exception === 'plugged-on-charge' ? ' · hypothetical charge (motor sold plugged)' : '')
          + (m.mode === 'auto' && m.rawOptimum !== null && m.rawOptimum < 0 ? ' · limited by burnout' : '');
        return `<tr><th scope="row">${e(`${m.mountName} (${m.mountId})`)}</th><td>${e(m.motorIdentity)}</td>
<td>${e(m.branchName === null || m.branchId === null ? 'Unknown' : `${m.branchName} (${m.branchId})`)}</td>
<td>${e(m.exception ? 'plugged → Auto (charge recovery)' : m.mode)}</td><td>${e(sec(m.rawOptimum))}</td>
<td>${e(sec(m.recommendedDelay))}</td><td>${e(flown + marks)}${m.caution ? note(m.caution, 'caution') : ''}</td></tr>`;
      }).join('');
      body.push(p('Auto targets each mount’s recovery-free branch apogee, rounded to a whole second.'),
        `<table aria-label="Per-mount ejection delays"><caption>Ejection delays by mount — selected flight</caption>
<thead><tr><th scope="col">Mount</th><th scope="col">Recorded motor identity</th><th scope="col">Branch</th><th scope="col">Mode</th>
<th scope="col">Ballistic optimum</th><th scope="col">Recommended</th><th scope="col">Flown delay</th></tr></thead><tbody>${rows}</tbody></table>`);
    } else {
      body.push(note(run.delayResolution === undefined
        ? 'Legacy scalar delay evidence. Other mounts’ delays are not recorded; do not apply the primary motor’s recommendation to them.'
        : 'Per-mount delay evidence is invalid or incomplete. Only the recorded primary motor scalar is shown; other mounts’ delays cannot be established.', 'caution'),
      p(`Primary motor ejection delay flown: ${run.delayS === Infinity ? 'plugged — no ejection charge' : sec(run.delayS)}`),
      p(`${run.delayS === Infinity ? 'Hypothetical primary motor-eject recommendation (motor has no ejection charge). ' : ''}Primary motor optimal delay: ${sec(run.optimumDelayS)}; recommended drill-to-fit delay: ${sec(run.recommendedDelayS)}`));
    }
    const results = [
      `Apogee: ${val('altitude', run.maxAltitude)}; time to apogee: ${sec(run.timeToApogee)}`,
      `Peak ground speed: ${val('velocity', run.maxVelocity)}; Mach: ${Number.isFinite(run.maxMach) ? run.maxMach : 'Unknown'}`,
      `Peak acceleration: ${val('acceleration', run.maxAcceleration)}`,
      `Launch mass: ${val('mass', run.launchMass)}; recovery mass: ${val('mass', run.burnoutMassSettled ? run.burnoutMass : null)}`,
      `Launch CG: ${val('length', run.launchCG, 3)}; launch CP: ${val('length', run.launchCP, 3)}`,
      `Launch stability: ${stability.value} ${stability.unit}`,
      `Guide exit speed: ${val('velocity', run.rodExitVelocity)}; thrust : weight: ${run.thrustToWeightAtRod ?? 'Unknown'}`,
      `Wind: ${val('windspeed', run.windAvg)}; density altitude: ${val('altitude', run.densityAltitudeM)}`,
      `Descent rate at landing: ${val('velocity', run.landingRate)}; impact ground speed: ${val('velocity', run.groundHitVelocity)}`,
      `Flight time: ${sec(run.totalFlightTime)}; landing distance: ${val('distance', run.landingDistanceM)}`,
    ];
    body.push(`<div class="summary">${results.map(p).join('')}</div>`, '<h2>Recovery</h2>');
    const deployment = (d: DeploymentReport) => p(`${d.device}: opens at ${sec(d.time)}, ${val('altitude', d.altitude)}; opening speed ${val('velocity', d.velocityAtDeployment)}; descent ${val('velocity', d.descentRate)}; ground speed ${val('velocity', d.groundSpeed)}; Cd ${d.cd ?? 'Unknown'}; diameter ${val('length', d.diameter, 3)}.`);
    if (run.deployments?.length) body.push(...run.deployments.map(deployment));
    else if (run.importedSummary) body.push(p(`Recorded summary deployment ground speed: ${val('velocity', run.velocityAtDeployment)}; device and opening order not recorded. This cannot establish a device's air-relative opening speed.`));
    else body.push(p(`Recovery device details unavailable. First recorded deployment: ${val('altitude', run.altitudeAtDeployment)}; opening speed ${val('velocity', run.velocityAtDeployment)}.`));
    for (const branch of run.branches ?? []) body.push(p(`${branch.name}: ${branch.motorLabel ?? 'motor unknown'}; apogee ${val('altitude', branch.apogee)}; recovery mass ${val('mass', branch.recoveryMass)}; landing descent ${val('velocity', branch.landingRate)}${branch.tumbles ? '; tumble recovery' : ''}.`), ...branch.deployments.map(deployment));
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
