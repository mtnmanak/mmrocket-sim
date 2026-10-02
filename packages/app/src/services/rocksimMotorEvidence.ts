import type { MotorMatchContext } from './motorMatchPolicy.js';
import { parseDecimal } from './xmlUtil.js';
import type { XmlDocument, XmlElement } from './xmlParse.js';

const value = (el: XmlElement | null, tag: string): number => {
  const raw = el?.querySelector(`:scope > ${tag}`)?.textContent?.trim();
  return raw ? parseDecimal(raw) : NaN;
};

/** Raw XML provenance only: defaults/sanitized geometry are not measurements.
 * RockSim v4 stores Mass0 in grams. Older v3 corpus files store kilograms;
 * they are deliberately ineligible rather than guessed from the magnitude.
 * An enabled single-stage dry-mass override is the only accepted dry mass.
 */
export function rocksimMotorEvidence(doc: XmlDocument, engineSet: XmlElement): MotorMatchContext {
  const context: MotorMatchContext = { source: 'rocksim' };
  const design = doc.querySelector('RocketDesign');
  const serial = engineSet.querySelector(':scope > MountSerialNo')?.textContent?.trim();
  const mounts = [...(design?.querySelectorAll('SerialNo') ?? [])]
    .filter(el => el.textContent?.trim() === serial).map(el => el.parentElement!);
  const mount = mounts.length === 1 ? mounts[0]! : null;
  const bore = value(mount, 'ID');
  if (mount?.tagName === 'BodyTube' && value(mount, 'IsMotorMount') === 1 && bore > 0 && Number.isFinite(bore)) context.mountBoreMm = bore;
  const sim = engineSet.closest('SimulationResults');
  if (value(doc.documentElement, 'FileVersion') !== 4 || value(design, 'StageCount') !== 1
    || value(design, 'UseKnownMass') !== 1 || !sim
    || sim.querySelectorAll('EngineSet').length !== 1 || value(engineSet, 'EngineCount') !== 1
    || !mount || value(mount, 'IsMotorMount') !== 1) return context;
  const loadedMassG = value(sim, 'Mass0');
  const dryMassG = value(design, 'Stage3Mass');
  const ignition = value(engineSet, 'IgnitionDelay');
  const burnTimeS = value(sim, 'TimeToBurnout') - ignition;
  if (![loadedMassG, dryMassG, burnTimeS].every(v => Number.isFinite(v) && v > 0)
    || !Number.isFinite(ignition) || ignition < 0 || loadedMassG <= dryMassG) return context;
  context.physical = { provenance: 'rocksim-single-stage-single-motor-known-dry-mass', loadedMassG, dryMassG,
    motorMassG: loadedMassG - dryMassG, burnTimeS };
  return context;
}
