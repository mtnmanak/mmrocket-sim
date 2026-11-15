import type { MountMotor, SavedConfig } from '../model/design.js';
import { getExMotor, type ExMotor } from './exMotors.js';
import { applyOverlay, displayMotorManufacturer, getCatalogue, isCatalogueOverlayInitialized, motorLabel, withoutLabelDelay } from './motorDb.js';
import { loadStoredOverlay } from './catalogueOverlay.js';
import type { RepairedMotorSpec } from './thrustcurve.js';
import { noteText } from './noteField.js';

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
  return ex ? { ...exLabelEntry(ex, mm.spec.designation), motorId: exId }
    : matches.length === 1 ? matches[0] : undefined;
}

/** Labels follow catalogue updates without replacing the loaded flight data. */
export function motorLabelEntry(mm: Pick<MountMotor, 'spec' | 'meta'>, catalogue = labelCatalogue()) {
  return resolvedMotorEntry(mm, catalogue)
    ?? { designation: mm.spec.designation, manufacturerAbbrev: mm.meta.manufacturer,
      motorId: mm.meta.exMotorId ?? mm.meta.motorId };
}

/** One frozen loadout uses bare names unless different identities would collide.
 * EX realManufacturer is display-only and must never reach stored/exported names.
 */
export function loadoutMotorNames(entries: readonly { designation: string; manufacturerAbbrev?: string; motorId?: string }[],
  catalogue = labelCatalogue()): string[] {
  const catalogueById = new Map(catalogue.map(m => [m.motorId, m]));
  // Catalogue and EX ids identify curves. Legacy maker/designation evidence
  // names a motor regardless of delay; its serialization is never display text.
  const ids = entries.map(e => e.motorId && (catalogueById.has(e.motorId) || e.motorId.startsWith('ex:')
    || e.designation === 'unknown motor') ? e.motorId
    : JSON.stringify([e.manufacturerAbbrev, withoutLabelDelay(e.designation)]));
  const clashes = (names: string[]) => {
    const groups = new Map<string, Set<string>>();
    names.forEach((name, i) => groups.set(name, (groups.get(name) ?? new Set()).add(ids[i]!)));
    return groups;
  };
  const bare = entries.map(e => noteText(e.motorId === e.designation && e.manufacturerAbbrev === undefined
    ? e.designation : motorLabel(e, 0, {}, catalogue).replace(/-0$/, '')));
  const bareGroups = clashes(bare);
  const prefix = entries.map((e, i) => bareGroups.get(bare[i]!)!.size > 1 ? noteText(e.manufacturerAbbrev ?? '') : '');
  const prefixed = (name: string, i: number) => `${prefix[i]!} ${name}`.trim();
  let names = bare.map(prefixed);
  const makerGroups = clashes(names);
  // Keep raw case/impulse names before considering an ordinal. Strip delays
  // only when the remaining designation still tells these identities apart.
  const raw = entries.map(e => noteText(withoutLabelDelay(e.designation)));
  const rawGroups = clashes(raw.map(prefixed));
  names = names.map((name, i) => {
    const e = entries[i]!;
    const motor = e.motorId ? catalogueById.get(e.motorId) : undefined;
    // A one-motor label also needs D5-P versus D5 for stale weighing evidence.
    const suffixClash = motor && catalogue.some(m => m.motorId !== motor.motorId
      && m.manufacturerAbbrev === motor.manufacturerAbbrev && m.designation !== motor.designation
      && withoutLabelDelay(m.designation) === withoutLabelDelay(motor.designation));
    if (suffixClash) return prefixed(noteText(motor.designation), i);
    if (makerGroups.get(name)!.size === 1) return name;
    return prefixed(rawGroups.get(prefixed(raw[i]!, i))!.size === 1 || !motor ? raw[i]! : noteText(motor.designation), i);
  });
  const groups = clashes(names);
  const reserved = new Set(names);
  const allocated = new Map<string, string>();
  const collisions = new Map(names.flatMap((name, i) => groups.get(name)!.size > 1
    ? [[JSON.stringify([name, ids[i]]), name] as const] : []));
  // Allocate by stable name/identity keys, never by the caller's vector order.
  for (const key of [...collisions.keys()].sort()) {
    const name = collisions.get(key)!;
    let index = 1;
    let unique = `${name} (${index})`;
    while (reserved.has(unique)) unique = `${name} (${++index})`;
    allocated.set(key, unique);
    reserved.add(unique);
  }
  return names.map((name, i) => allocated.get(JSON.stringify([name, ids[i]])) ?? name);
}

/** Reject the whole resolved vector rather than publishing partial evidence. */
export function boundedLoadoutMotorNames(entries: Parameters<typeof loadoutMotorNames>[0], catalogue = labelCatalogue()): string[] | null {
  const names = loadoutMotorNames(entries, catalogue);
  return names.every(name => name.length <= 1024 && noteText(name).trim()) ? names : null;
}

/** Preserve resolved identities so a whole historical loadout can share clash handling. */
export function motorEntryForIdentity(identity: string, catalogue = labelCatalogue()) {
  const motor = catalogue.find(m => m.motorId === identity);
  if (motor) return motor;
  if (identity.startsWith('ex:')) {
    const ex = getExMotor(identity);
    return { ...exLabelEntry(ex, 'experimental motor (no longer in your library)'), motorId: identity };
  }
  if (/^[a-f0-9]{24}$/i.test(identity)) return { designation: 'unknown motor', motorId: identity };
  const slash = identity.indexOf('/');
  if (slash < 0 || slash === identity.length - 1 || identity.startsWith('[') || identity.startsWith('{')) {
    return { designation: 'unknown motor', motorId: identity };
  }
  const maker = identity.slice(0, slash), designation = identity.slice(slash + 1);
  const matches = catalogue.filter(m => m.manufacturerAbbrev === maker && m.designation === designation);
  return matches.length === 1 ? matches[0]! : { designation, manufacturerAbbrev: maker, motorId: identity };
}

/** Resolve recorded identities; raw unknown evidence belongs in identity fields. */
export function designationForMotorIdentity(identity: string, catalogue = labelCatalogue()): string {
  return loadoutMotorNames([motorEntryForIdentity(identity, catalogue)], catalogue)[0]!;
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
    : Number.isFinite(mm.spec.ejectionDelay) ? `${mm.spec.ejectionDelay} s delay`
      : mm.spec.ejectionDelay === Infinity ? 'plugged' : 'unknown delay';
  return `${[manufacturer, entry.designation].filter(Boolean).join(' ')}, ${delay} (${label})`;
}
