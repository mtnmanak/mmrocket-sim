import type { MotorMatchContext } from './motorMatchPolicy.js';
import { parseDecimal } from './xmlUtil.js';
import type { XmlDocument, XmlElement } from './xmlParse.js';

const value = (el: XmlElement | null, tag: string): number => {
  const raw = el?.querySelector(`:scope > ${tag}`)?.textContent?.trim();
  return raw ? parseDecimal(raw) : NaN;
};

export interface RocksimMotorIndex {
  mountsBySerial: ReadonlyMap<string, XmlElement | null>;
  mountFacts: Map<XmlElement, { tagName: string; bore: number; isMotorMount: number }>;
  simulationSets: ReadonlyMap<XmlElement, readonly XmlElement[]>;
  fileVersion: number;
  stageCount: number;
  useKnownMass: number;
  stage3Mass: number;
}

/** One design walk per import; duplicate serials remain ambiguous. */
export function indexRocksimMotors(
  doc: XmlDocument, design: XmlElement, simulationSets: RocksimMotorIndex['simulationSets'],
): RocksimMotorIndex {
  const mountsBySerial = new Map<string, XmlElement | null>();
  for (const el of design.querySelectorAll('SerialNo')) {
    const serial = el.textContent?.trim() ?? '';
    mountsBySerial.set(serial, mountsBySerial.has(serial) ? null : el.parentElement);
  }
  return { mountsBySerial, mountFacts: new Map(), simulationSets, fileVersion: value(doc.documentElement, 'FileVersion'),
    stageCount: value(design, 'StageCount'), useKnownMass: value(design, 'UseKnownMass'),
    stage3Mass: value(design, 'Stage3Mass') };
}

const engineSetCount = (sim: XmlElement, index: RocksimMotorIndex): number =>
  index.simulationSets.get(sim)?.length ?? 0;

/** A serial can name any element, including a padded unknown subtree. Read
 * only its direct children, once, even when many simulations name it. */
function mountFacts(mount: XmlElement | null, index: RocksimMotorIndex) {
  if (!mount) return undefined;
  let facts = index.mountFacts.get(mount);
  if (!facts) {
    const fields = new Map<string, number>();
    for (const child of mount.children) {
      if (['ID', 'IsMotorMount'].includes(child.tagName) && !fields.has(child.tagName)) {
        const raw = child.textContent?.trim();
        fields.set(child.tagName, raw ? parseDecimal(raw) : NaN);
      }
    }
    facts = { tagName: mount.tagName, bore: fields.get('ID') ?? NaN,
      isMotorMount: fields.get('IsMotorMount') ?? NaN };
    index.mountFacts.set(mount, facts);
  }
  return facts;
}

/** A stored result can identify a possible curve mismatch without a dry-mass
 * override. Seconds have the same meaning in legacy v2/v3 and v4 files.
 * Never attribute the final burnout of a cluster or staged flight to one motor.
 */
export function rocksimBurnTime(engineSet: XmlElement, index: RocksimMotorIndex): number | undefined {
  const sim = engineSet.closest('SimulationResults');
  const stageCount = index.stageCount;
  if (stageCount !== 1 || !sim
    || engineSetCount(sim, index) !== 1 || value(engineSet, 'EngineCount') !== 1) return undefined;
  const ignition = value(engineSet, 'IgnitionDelay');
  const burn = value(sim, 'TimeToBurnout') - ignition;
  return Number.isFinite(ignition) && ignition >= 0 && Number.isFinite(burn) && burn > 0 ? burn : undefined;
}

/** Raw XML provenance only: defaults/sanitized geometry are not measurements.
 * RockSim v4 stores Mass0 in grams. Older v3 corpus files store kilograms;
 * they are deliberately ineligible rather than guessed from the magnitude.
 * An enabled single-stage dry-mass override is the only accepted dry mass.
 */
export function rocksimMotorEvidence(engineSet: XmlElement, index: RocksimMotorIndex): MotorMatchContext {
  const context: MotorMatchContext = { source: 'rocksim' };
  const serial = engineSet.querySelector(':scope > MountSerialNo')?.textContent?.trim();
  const mount = serial === undefined ? null : index.mountsBySerial.get(serial) ?? null;
  const facts = mountFacts(mount, index);
  const bore = facts?.bore ?? NaN;
  if (facts?.tagName === 'BodyTube' && facts.isMotorMount === 1 && bore > 0 && Number.isFinite(bore)) context.mountBoreMm = bore;
  const sim = engineSet.closest('SimulationResults');
  const { fileVersion, stageCount, useKnownMass } = index;
  if (fileVersion !== 4 || stageCount !== 1
    || useKnownMass !== 1 || !sim
    || engineSetCount(sim, index) !== 1 || value(engineSet, 'EngineCount') !== 1
    || facts?.isMotorMount !== 1) return context;
  const loadedMassG = value(sim, 'Mass0');
  const dryMassG = index.stage3Mass;
  const ignition = value(engineSet, 'IgnitionDelay');
  const burnTimeS = value(sim, 'TimeToBurnout') - ignition;
  if (![loadedMassG, dryMassG, burnTimeS].every(v => Number.isFinite(v) && v > 0)
    || !Number.isFinite(ignition) || ignition < 0 || loadedMassG <= dryMassG) return context;
  context.physical = { provenance: 'rocksim-single-stage-single-motor-known-dry-mass', loadedMassG, dryMassG,
    motorMassG: loadedMassG - dryMassG, burnTimeS };
  return context;
}
