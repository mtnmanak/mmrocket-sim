import { readFileSync } from 'node:fs';
import { strFromU8, unzipSync } from 'fflate';
import { SaxesParser } from 'saxes';

/**
 * Deterministic .ork files carrying desktop-style stored flights, built on the
 * committed reference.ork design: the API import-memory tests and
 * scripts/import-memory.mjs (the before/after measurement) share it.
 *
 * The stored flight follows desktop OpenRocket's saved shape: <simulation>
 * wrappers with <conditions> and <configid>, a <flightdata> carrying the ten
 * summary attributes and <warning>s, then one <databranch> per stage with
 * <event>s and one <datapoint> of comma-separated values per time step. Values
 * are synthetic (not a flight of this design), and the same for the same input.
 */
export const REFERENCE_CONFIG = 'b61d1bfe-9ef0-4607-9756-382bf2bab907';
export const SECOND_CONFIG = 'c0ffee00-0000-4000-8000-000000000002';

const TYPES = ['Time', 'Altitude', 'Vertical velocity', 'Vertical acceleration', 'Total velocity', 'Total acceleration',
  'Position East of launch', 'Position North of launch', 'Lateral distance', 'Lateral direction', 'Lateral velocity',
  'Lateral acceleration', 'Latitude', 'Longitude', 'Gravitational acceleration', 'Angle of attack', 'Roll rate',
  'Pitch rate', 'Yaw rate', 'Mass', 'Motor mass', 'Longitudinal moment of inertia', 'Rotational moment of inertia',
  'CP location', 'CG location', 'Stability margin calibers', 'Mach number', 'Reynolds number', 'Thrust', 'Drag force',
  'Drag coefficient', 'Axial drag coefficient', 'Friction drag coefficient', 'Pressure drag coefficient',
  'Base drag coefficient', 'Normal force coefficient', 'Pitch moment coefficient', 'Yaw moment coefficient',
  'Side force coefficient', 'Roll moment coefficient', 'Roll forcing coefficient', 'Roll damping coefficient',
  'Pitch damping coefficient', 'Coriolis acceleration', 'Reference length', 'Reference area', 'Vertical orientation (zenith)',
  'Lateral orientation (azimuth)', 'Wind velocity', 'Air temperature', 'Air pressure', 'Speed of sound'];

export interface StoredSimulation {
  name?: string;
  /** The <configid>; omitted for a configuration-less simulation. */
  configId?: string | null;
  status?: string;
  /** Datapoints in each branch; 0 writes an empty branch. */
  points: number;
  /** Branches (stages) of stored data. Default 1. */
  branches?: number;
  /** Extra <conditions> children, appended after the defaults. */
  conditions?: string;
  /** Replaces the default launch-rod/wind/site conditions. */
  baseConditions?: string;
  /** Written before the branches, inside <flightdata> (warnings by default). */
  flightdataHead?: string;
  /** Written inside each branch after its datapoints. */
  branchTail?: string;
  /** Simulation children after <flightdata> (for example <simwarnings>). */
  after?: string;
  /** No <flightdata> at all (a not-yet-simulated row). */
  noFlightdata?: boolean;
}

export interface StoredFlightDesign {
  simulations: StoredSimulation[];
  /** Swap the trapezoidal fins for a freeform set with this cross-section. */
  freeformFins?: 'rounded' | 'airfoil';
  /** Add SECOND_CONFIG (same C6, 3 s delay); `default` makes it the active one. */
  secondConfig?: 'listed' | 'default';
}

const referenceXml = () => strFromU8(unzipSync(new Uint8Array(readFileSync(
  new URL('../../app/src/services/__fixtures__/reference.ork', import.meta.url))))['rocket.ork']!);

/** One value per column, fixed-point like the desktop's short doubles. */
function row(i: number, columns: number): string {
  const values: string[] = [(i * 0.01).toFixed(2)];
  for (let j = 1; j < columns; j++) values.push((((i * 7919 + j * 104_729) % 1_000_003) / 997).toFixed(4));
  return values.join(',');
}

const EVENTS = [['launch', 0], ['ignition', 0], ['liftoff', 0.02], ['launchrod', 0.31], ['burnout', 1.86],
  ['apogee', 6.4], ['ejection', 6.86], ['recoverydevicedeployment', 6.86], ['groundhit', 40.2], ['simulationend', 40.2]] as const;

function branch(name: string, points: number, columns: number, tail: string, out: string[]): void {
  out.push(`      <databranch name="${name}" types="${TYPES.slice(0, columns).join(',')}">\n`);
  for (const [type, time] of EVENTS) out.push(`        <event time="${time}" type="${type}" source="${name}"/>\n`);
  for (let i = 0; i < points; i++) out.push(`        <datapoint>${row(i, columns)}</datapoint>\n`);
  out.push(tail, '      </databranch>\n');
}

const DEFAULT_CONDITIONS = `        <launchrodlength>1.2</launchrodlength>
        <launchrodangle>4.0</launchrodangle>
        <launchroddirection>90.0</launchroddirection>
        <windaverage>3.0</windaverage>
        <windturbulence>0.1</windturbulence>
        <launchaltitude>120.0</launchaltitude>
        <launchlatitude>40.5</launchlatitude>
        <launchlongitude>-105.1</launchlongitude>
        <geodeticmethod>spherical</geodeticmethod>
        <atmosphere model="isa"/>
        <timestep>0.05</timestep>
`;

function simulation(sim: StoredSimulation, columns: number, out: string[]): void {
  out.push(`    <simulation status="${sim.status ?? 'loaded'}">\n      <name>${sim.name ?? 'Stored flight'}</name>\n`,
    '      <simulator>RK4Simulator</simulator>\n      <calculator>BarrowmanCalculator</calculator>\n      <conditions>\n');
  const configId = sim.configId === undefined ? REFERENCE_CONFIG : sim.configId;
  if (configId !== null) out.push(`        <configid>${configId}</configid>\n`);
  out.push(sim.baseConditions ?? DEFAULT_CONDITIONS, sim.conditions ?? '', '      </conditions>\n');
  if (!sim.noFlightdata) {
    out.push('      <flightdata maxaltitude="182.3" maxvelocity="61.2" maxacceleration="140.4" maxmach="0.18" timetoapogee="6.4" '
      + 'flighttime="40.2" groundhitvelocity="4.9" launchrodvelocity="14.1" deploymentvelocity="9.8" optimumdelay="4.5">\n');
    out.push(sim.flightdataHead ?? '        <warning>Large angle of attack encountered.</warning>\n');
    const branches = sim.branches ?? 1;
    for (let b = 0; b < branches; b++) branch(b === 0 ? 'Sustainer' : `Booster ${b}`, sim.points, columns, sim.branchTail ?? '', out);
    out.push('      </flightdata>\n');
  }
  out.push(sim.after ?? '', '    </simulation>\n');
}

/** The reference design with these stored simulations, as rocket.ork XML text. */
export function storedFlightXml(design: StoredFlightDesign, columns = TYPES.length): string {
  let xml = referenceXml();
  const crossSection = design.freeformFins;
  if (crossSection) {
    xml = xml.replace(/<trapezoidfinset>[\s\S]*?<\/trapezoidfinset>/, match => match
      .replaceAll('trapezoidfinset>', 'freeformfinset>')
      .replace('Trapezoidal Fin Set', 'Freeform Fin Set')
      .replace('<crosssection>square</crosssection>', `<crosssection>${crossSection}</crosssection>`)
      .replace(/<rootchord>[\s\S]*<height>[^<]*<\/height>/, '<finpoints><point x="0.0" y="0.0"/><point x="0.02" y="0.03"/>'
        + '<point x="0.045" y="0.03"/><point x="0.05" y="0.0"/></finpoints>'));
  }
  if (design.secondConfig) {
    const isDefault = design.secondConfig === 'default';
    xml = xml.replace(`<motorconfiguration configid="${REFERENCE_CONFIG}" default="true">`,
      `<motorconfiguration configid="${REFERENCE_CONFIG}"${isDefault ? '' : ' default="true"'}>`)
      .replace('    <referencetype>', `    <motorconfiguration configid="${SECOND_CONFIG}"${isDefault ? ' default="true"' : ''}>
      <stage number="0" active="true"/>
    </motorconfiguration>
    <referencetype>`)
      .replace('                  <ignitionconfiguration', `                  <motor configid="${SECOND_CONFIG}">
                    <type>single</type>
                    <manufacturer>custom</manufacturer>
                    <digest>gen-c6</digest>
                    <designation>C6</designation>
                    <diameter>0.018</diameter>
                    <length>0.07</length>
                    <delay>3.0</delay>
                  </motor>
                  <ignitionconfiguration`);
  }
  const out: string[] = [];
  for (const sim of design.simulations) simulation(sim, columns, out);
  return xml.replace('<simulations>\n  </simulations>', `<simulations>\n${out.join('')}  </simulations>`);
}

/** Exact structure of a generated file, counted by saxes: what the measurement reports. */
export function xmlStats(xml: string): { chars: number; utf8Bytes: number; elements: number; maxDepth: number; datapoints: number } {
  let elements = 0, depth = 0, maxDepth = 0, datapoints = 0;
  const sax = new SaxesParser({ xmlns: true });
  sax.on('opentag', tag => {
    elements++;
    maxDepth = Math.max(maxDepth, ++depth);
    if (tag.name === 'datapoint') datapoints++;
  });
  sax.on('closetag', () => { depth--; });
  sax.write(xml).close();
  return { chars: xml.length, utf8Bytes: new TextEncoder().encode(xml).byteLength, elements, maxDepth, datapoints };
}
