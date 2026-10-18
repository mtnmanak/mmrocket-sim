import type { MountMotor, SavedConfig } from '../model/design.js';
import { getExMotor, type ExMotor } from './exMotors.js';
import { applyOverlay, displayMotorManufacturer, getCatalogue, isCatalogueOverlayInitialized, motorLabel } from './motorDb.js';
import { loadStoredOverlay } from './catalogueOverlay.js';
import type { RepairedMotorSpec } from './thrustcurve.js';

let startupCatalogue: { base: ReturnType<typeof getCatalogue>; overlay: string; motors: ReturnType<typeof getCatalogue> } | undefined;

export function labelCatalogue() {
  // Only startup may look ahead to storage; later writes can belong to another tab.
  const base = getCatalogue();
  if (isCatalogueOverlayInitialized()) return base;
  const overlay = loadStoredOverlay();
  const key = JSON.stringify(overlay);
  // Preserve snapshot identity so startup labels share the clash index too
  // (board row 63, Eric 2026-10-06), until the stored overlay changes.
  if (startupCatalogue?.base !== base || startupCatalogue.overlay !== key) {
    startupCatalogue = { base, overlay: key, motors: applyOverlay(base, overlay) };
  }
  return startupCatalogue.motors;
}

function exLabelEntry(ex: ExMotor | undefined, fallback: string) {
  // Autosaved definitions may be incomplete. Naming a motor must not repair
  // its curve or assume that samples/snapshot arrays survived storage.
  const designation = ex?.flightSnapshot?.designation ?? ex?.designation;
  return { designation: typeof designation === 'string' && designation ? designation : fallback,
    manufacturerAbbrev: 'EX', realManufacturer: typeof ex?.realManufacturer === 'string' ? ex.realManufacturer : undefined };
}

function resolvedMotorEntry(mm: Pick<MountMotor, 'spec' | 'meta'>, catalogue: ReturnType<typeof getCatalogue>) {
  const exId = mm.meta.exMotorId ?? (mm.meta.motorId?.startsWith('ex:') ? mm.meta.motorId : undefined);
  const ex = exId ? (mm.spec as RepairedMotorSpec).exDefinition ?? getExMotor(exId) : undefined;
  const matches = exId ? [] : catalogue.filter(m => mm.meta.motorId
    ? m.motorId === mm.meta.motorId
    : m.designation === mm.spec.designation && m.manufacturerAbbrev === mm.meta.manufacturer);
  return ex ? exLabelEntry(ex, mm.spec.designation)
    : matches.length === 1 ? matches[0] : undefined;
}

/** Labels follow catalogue updates without replacing the loaded flight data. */
export function motorLabelEntry(mm: Pick<MountMotor, 'spec' | 'meta'>, catalogue = labelCatalogue()) {
  return resolvedMotorEntry(mm, catalogue)
    ?? { designation: mm.spec.designation, manufacturerAbbrev: mm.meta.manufacturer };
}

/** Re-label resolved stored motors without replacing their flown data or delay. */
export function restoreMotorLabels(motors: Record<string, MountMotor>, catalogue = labelCatalogue()): Record<string, MountMotor> {
  let result = motors;
  for (const [id, mm] of Object.entries(motors)) {
    // Crash recovery can preserve incomplete records for the writer's warning
    // (audit 2026-10-11, FC-4); labels must not prevent that download.
    if (!mm.spec || !mm.meta) continue;
    const entry = resolvedMotorEntry(mm, catalogue);
    if (!entry) continue;
    const label = motorLabel(entry, mm.spec.ejectionDelay, mm.meta, catalogue);
    if (label === mm.label && label === mm.meta.label) continue;
    if (result === motors) result = { ...motors };
    result[id] = { ...mm, label, meta: { ...mm.meta, label } };
  }
  return result;
}

export function restoreConfigLabels(config: SavedConfig, catalogue = labelCatalogue()): SavedConfig {
  const motors = restoreMotorLabels(config.motors, catalogue);
  return motors === config.motors ? config : { ...config, motors };
}

/** The unabridged identity and delay remain available when the strip truncates. */
export function motorTooltip(mm: MountMotor, catalogue = labelCatalogue()): string {
  // Old EX sessions lack exDefinition; their loaded spec still names the file motor.
  // Rendering its identity must not parse the entire imported-motor library.
  const isEx = mm.meta.exMotorId || mm.meta.motorId?.startsWith('ex:');
  const entry = isEx
    ? exLabelEntry((mm.spec as RepairedMotorSpec).exDefinition, mm.spec.designation)
    : motorLabelEntry(mm, catalogue);
  const manufacturer = displayMotorManufacturer(entry);
  const label = motorLabel(entry, mm.spec.ejectionDelay, mm.meta, catalogue);
  const delay = mm.meta.autoDelay ? 'automatic delay'
    : Number.isFinite(mm.spec.ejectionDelay) ? `${mm.spec.ejectionDelay} s delay` : 'plugged';
  return `${[manufacturer, entry.designation].filter(Boolean).join(' ')}, ${delay} (${label})`;
}
