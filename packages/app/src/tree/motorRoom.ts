import type { ComponentNode, ComponentPosition, RocketTree } from '@online-openrocket/engine';
import { axialLength, startFromPosition } from './position.js';
import { findNode } from './treeModel.js';

/**
 * How long a motor this mount has room for — the estimate behind the
 * "Max motor length" field's ⌾ button (owner, 2026-08-30: *"the length from
 * the aft of the motor tube to whatever the first obstruction would be — a
 * bulkhead in an ebay, a baffle, the nosecone, etc."*).
 *
 * It measures forward from the mount's AFT end, because that is where a motor
 * seats (the 2D view draws it flush there, and `motorOverhang` is how far it
 * is allowed to stick out past it). It stops at the first thing a motor case
 * cannot pass:
 *
 * - the mount tube's own forward end;
 * - an **engine block** or **bulkhead** inside the mount — the two components
 *   that exist to stop a motor going further;
 * - a **mass component** inside the mount, which is how people model an
 *   altimeter sled or a nose weight sitting in the tube.
 *
 * Deliberately NOT an obstruction: a **centering ring** or **tube coupler**
 * around or inside the mount. A ring's bore is the motor tube's outside — the
 * motor passes through it — and treating it as a stop would return a few
 * millimetres on almost every high-power rocket.
 *
 * It is an ESTIMATE and the UI says so. It cannot know about a baffle modelled
 * as something else, wadding, or a chute packed hard against the block.
 */
export interface MotorRoom {
  /** Metres, including any motorOverhang the mount allows. */
  lengthM: number;
  /** What set the limit, for the note under the field. */
  limitedBy: string;
}

const num = (n: ComponentNode, key: string, fb: number): number =>
  typeof n[key] === 'number' ? (n[key] as number) : fb;

/** Components a motor case cannot pass through. */
const BLOCKING = new Set(['engineblock', 'bulkhead', 'masscomponent']);

const DISPLAY: Record<string, string> = {
  engineblock: 'engine block',
  bulkhead: 'bulkhead',
  masscomponent: 'mass component',
};

export function estimateMotorRoom(tree: RocketTree, mountId: string): MotorRoom | null {
  const mount = findNode(tree, mountId);
  if (!mount) return null;
  const mountLen = axialLength(mount);
  if (!(mountLen > 0)) return null;

  // Forward limit as a distance from the mount's fore end; 0 = the tube's own
  // front, which is the answer when nothing is in the way.
  let limit = 0;
  let limitedBy = mount.name ?? 'the mount tube';
  let named = false;

  for (const child of mount.children ?? []) {
    if (!BLOCKING.has(child.type)) continue;
    const cLen = axialLength(child);
    const pos = (child.position ?? { method: 'top', offset: 0 }) as ComponentPosition;
    const start = startFromPosition(pos, cLen, mountLen);
    // The blocking face is the component's AFT end — a motor can sit right up
    // against it.
    const aft = start + cLen;
    if (aft > limit) {
      limit = aft;
      limitedBy = child.name ?? DISPLAY[child.type] ?? child.type;
      named = true;
    }
  }

  const room = mountLen - limit + Math.max(0, num(mount, 'motorOverhang', 0));
  if (!(room > 0)) return null;
  return {
    lengthM: room,
    limitedBy: named ? limitedBy : `the front of ${limitedBy}`,
  };
}

/**
 * The tightest estimate across several mounts — what a per-STAGE limit wants,
 * since one number has to serve every mount in the stage. Null when no mount
 * yields one.
 */
export function estimateMotorRoomForMounts(tree: RocketTree, mountIds: string[]): MotorRoom | null {
  let best: MotorRoom | null = null;
  for (const id of mountIds) {
    const r = estimateMotorRoom(tree, id);
    if (r && (!best || r.lengthM < best.lengthM)) best = r;
  }
  return best;
}
