import type { RocketTree, StaticInfo } from '@online-openrocket/engine';
import { savedConfigLabel, type MountMotor, type SavedConfig } from '../model/design.js';
import { motorMounts, primaryMountOf } from '../tree/treeModel.js';
import { buildDesign, type BuildHandle, type DesignBuildInput, type HandleFactory } from './buildDesign.js';
import { padMassSetKey } from './configSync.js';
import { attachedSet } from './importApply.js';
import { applyStageMass } from './stageMassOverrides.js';
import { resolveFlightState } from './flightState.js';
import { reconcileAllIncludedMotors } from './statedLaunchWeight.js';
import { hasAerodynamicForce, shownStability, stabilityPercent } from './simReport.js';

export interface StabilityRangeInput {
  tree: RocketTree;
  configs: SavedConfig[];
  workingMotors?: Record<string, MountMotor>;
  workingUnmatchedRefs?: SavedConfig['unmatchedRefs'];
  kbf: boolean;
  supersonic: boolean;
  hybrid?: boolean;
  measuredDryMassKg: number | null;
}
export interface StabilityCase {
  id: string;
  label: string;
  input: DesignBuildInput;
  unavailable?: string;
}
export interface StabilityCaseResult {
  id: string;
  label: string;
  info?: StaticInfo;
  cal?: number;
  pct?: number | null;
  unavailable?: string;
}
export interface StabilityRange {
  cases: StabilityCaseResult[];
  min: StabilityCaseResult | null;
  max: StabilityCaseResult | null;
  complete: boolean;
  builds: number;
}

/** N024: a read-only projection, including the same stage mass back-out as Apply. */
export function prepareStabilityCases(input: StabilityRangeInput): StabilityCase[] {
  const empty: SavedConfig = { id: 'empty', name: 'Empty rocket (no motor)', isDefault: false, motors: {} };
  const configs = [empty, ...input.configs];
  if (Object.keys(input.workingMotors ?? {}).length || Object.keys(input.workingUnmatchedRefs ?? {}).length) {
    configs.push({ id: 'working', name: 'Working settings', isDefault: false,
      motors: input.workingMotors ?? {}, unmatchedRefs: input.workingUnmatchedRefs });
  }
  return configs.map(config => {
    let tree = applyStageMass(input.tree, config.stageMassOverrides);
    const mountIds = new Set(motorMounts(tree).map(n => n.id));
    const motors = Object.fromEntries(Object.entries(config.motors).filter(([id]) => mountIds.has(id)));
    tree = reconcileAllIncludedMotors(tree, attachedSet(motors), { mass: kg => `${kg} kg`, length: m => `${m} m` }).tree;
    const effective = resolveFlightState(tree, [config], config.id, {}, motors);
    const assigned = Object.entries(effective.mountMotors);
    const liveStages = new Set<string>();
    const visit = (nodes: RocketTree['components']) => {
      for (const n of nodes) {
        if (n.id && (n.type === 'stage' || n.type === 'parallelstage')) liveStages.add(n.id);
        visit(n.children ?? []);
      }
    };
    visit(tree.components);
    const unresolvedMass = tree.components.some(n => typeof n['overrideIncludesMotor'] === 'string'
      && n['overrideIncludesMotor'] !== '');
    const unavailable = Object.entries(config.stageActiveness ?? {}).some(([id, active]) => liveStages.has(id) && !active)
      ? 'Inactive stages are not represented by the app.'
      : config.motorLoadoutRefusal || config.unmatched?.length
        || Object.keys(config.unmatchedRefs ?? {}).some(id => mountIds.has(id))
        ? 'Unresolved motor: the complete loadout cannot be calculated.'
        : unresolvedMass ? 'A stage mass or CG still includes an unresolved motor.' : undefined;
    return { id: config.id, label: savedConfigLabel(config), unavailable, input: {
      tree: effective.tree, assigned, kbf: input.kbf, supersonic: input.supersonic, hybrid: input.hybrid,
      measuredDryMassKg: input.measuredDryMassKg,
      primaryMountId: primaryMountOf(tree, assigned.map(([id]) => id)),
      currentSetKey: padMassSetKey(tree, effective.mountMotors),
    } };
  });
}

export function stabilityRange(cases: StabilityCaseResult[], builds = 0): StabilityRange {
  const results = cases.map(c => {
    if (!c.info || c.unavailable) return c;
    const cal = shownStability(c.info);
    return hasAerodynamicForce(c.info) && Number.isFinite(cal)
      ? { ...c, cal, pct: stabilityPercent(c.info) }
      : { ...c, unavailable: 'No defined aerodynamic normal force or static margin.' };
  });
  let min: StabilityCaseResult | null = null;
  let max: StabilityCaseResult | null = null;
  for (const c of results) {
    if (c.cal === undefined) continue;
    if (!min || c.cal < min.cal!) min = c;
    if (!max || c.cal > max.cal!) max = c;
  }
  return { cases: results, min, max, complete: results.every(c => c.cal !== undefined), builds };
}

/** Run only in the range worker: its reset cannot touch a flight's kernel instance. */
export class StabilityRangeCalculator<R extends BuildHandle> {
  private readonly cache = new Map<string, StaticInfo>();
  private readonly handles: HandleFactory<R>;
  constructor(handles: HandleFactory<R>) { this.handles = handles; }

  async calculate(input: StabilityRangeInput, cancelled: () => boolean = () => false): Promise<StabilityRange | null> {
    const results: StabilityCaseResult[] = [];
    let builds = 0;
    let sinceYield = 0;
    for (const c of prepareStabilityCases(input)) {
      if (cancelled()) return null;
      const before = builds;
      if (c.unavailable) results.push({ id: c.id, label: c.label, unavailable: c.unavailable });
      else {
        const key = JSON.stringify(c.input);
        let info = this.cache.get(key);
        let unavailable: string | undefined;
        if (!info) {
          const built = buildDesign(c.input, this.handles);
          builds++;
          if ('error' in built) unavailable = built.error;
          else if (built.motorFailures.length) unavailable = 'The kernel refused a motor; this loadout is unavailable.';
          else {
            info = built.info;
            this.cache.set(key, info);
            if (this.cache.size > 512) this.cache.delete(this.cache.keys().next().value!);
          }
        }
        results.push({ id: c.id, label: c.label, info, unavailable });
      }
      // A cache hit is cheap. Yield after each kernel build or a small batch of
      // hits: one timer per hit dominated the warm 256-case cost on Windows.
      if (builds !== before || ++sinceYield >= 16) {
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        sinceYield = 0;
      }
    }
    return cancelled() ? null : stabilityRange(results, builds);
  }
}
