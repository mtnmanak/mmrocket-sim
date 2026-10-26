import type { FlightOverrides, IgnitionTuple, MountMotor } from '../model/design.js';
import type { SessionState } from './session.js';
import { carryFlags, cautionNote, noteFlags } from './importNotes.js';
import { knownIgnitionEvent } from './ignitionEvent.js';
import { canonicalEnum, SEPARATION_EVENT_VALUES } from '../tree/schema.js';

const table = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const sameFields = (a: Record<string, unknown>, b: Record<string, unknown>) =>
  Object.keys(a).length === Object.keys(b).length && Object.keys(b).every(k => a[k] === b[k]);

/** Validate persisted tuples before migration or projection can spread them onto nodes. */
export function sanitizeSessionFlightLayers(input: SessionState): SessionState {
  let repaired = false;
  const tuple = (v: unknown, family: keyof FlightOverrides, complete: boolean): Record<string, unknown> | undefined => {
    if (!table(v)) { repaired = true; return undefined; }
    const keys = family === 'ignitions' ? ['event', 'delay']
      : family === 'deployments' ? ['deployEvent', 'deployAltitude', 'deployDelay']
        : ['separationEvent', 'separationDelay', 'separationAltitude'];
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      let value = v[key];
      if (value === undefined && !complete) continue;
      if (key === 'event') {
        if (typeof value !== 'string' || !knownIgnitionEvent(value)) { repaired = true; return undefined; }
        value = knownIgnitionEvent(value)!;
      } else if (key.endsWith('Event')) {
        // Preserve desktop's recovery event strings, including unsupported future events.
        if (typeof value !== 'string' || (key === 'separationEvent' && !canonicalEnum(SEPARATION_EVENT_VALUES, value))) {
          repaired = true; return undefined;
        }
        if (key === 'separationEvent') value = canonicalEnum(SEPARATION_EVENT_VALUES, value)!;
      } else if (!finite(value)) { repaired = true; return undefined; }
      out[key] = typeof value === 'number' ? Math.max(0, value) : value;
    }
    if (sameFields(v, out)) return v;
    repaired = true;
    return out;
  };
  const map = <T>(v: Record<string, T> | undefined, clean: (entry: unknown) => T | undefined): Record<string, T> | undefined => {
    if (v === undefined) return v;
    if (!table(v)) { repaired = true; return {}; }
    const entries = Object.entries(v).flatMap(([id, value]) => {
      const next = clean(value);
      return next === undefined ? [] : [[id, next] as const];
    });
    return entries.length === Object.keys(v).length && entries.every(([id, value]) => v[id] === value)
      ? v : Object.fromEntries(entries);
  };
  const layers = <T extends FlightOverrides>(v: T, complete: boolean): T => {
    let next = v;
    for (const family of ['deployments', 'separations', 'ignitions'] as const) {
      const cleaned = map<unknown>(v[family], entry => tuple(entry, family, complete || family === 'ignitions'));
      if (cleaned !== v[family]) next = { ...next, [family]: cleaned };
    }
    return next;
  };
  const motors = (v: Record<string, MountMotor> | undefined) => map(v, entry => {
    const motor = entry as MountMotor;
    const ignition = tuple(motor.ignition, 'ignitions', true) as unknown as IgnitionTuple | undefined;
    return ignition === motor.ignition && ignition ? motor
      : { ...motor, ignition: ignition ?? { event: 'automatic', delay: 0 } };
  });
  let state = input;
  const ignitionDefaults = map(input.tree.ignitionDefaults, entry => tuple(entry, 'ignitions', true) as unknown as IgnitionTuple | undefined);
  if (ignitionDefaults !== input.tree.ignitionDefaults) state = { ...state, tree: { ...state.tree, ignitionDefaults } };
  if (input.detachedOverrides !== undefined) {
    const detachedOverrides = table(input.detachedOverrides) ? layers(input.detachedOverrides, true) : {};
    if (detachedOverrides !== input.detachedOverrides) { repaired = true; state = { ...state, detachedOverrides }; }
  }
  const mountMotors = motors(input.mountMotors);
  if (mountMotors !== input.mountMotors) state = { ...state, mountMotors };
  const savedConfigs = input.savedConfigs?.map(config => {
    const cleaned = layers(config as FlightOverrides, input.configLayers === 1);
    const records = motors(config.motors)!;
    return cleaned === config && records === config.motors ? config : { ...config, ...cleaned, motors: records };
  });
  if (savedConfigs?.some((c, i) => c !== input.savedConfigs![i])) state = { ...state, savedConfigs };
  if (repaired) {
    const notes = [...(state.treeRestoreNotes ?? [])];
    // Keep the loader's earlier consequence tiers when adding this repair.
    carryFlags(notes, noteFlags(state.treeRestoreNotes ?? []));
    cautionNote(notes, 'G04.flight-settings-repaired', 'Unreadable flight settings were removed or reset. Check ignition, deployment and separation before launching.');
    state = { ...state, treeRestoreNotes: notes };
  }
  return state;
}
