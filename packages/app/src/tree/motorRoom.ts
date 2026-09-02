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
 *   that exist to stop a motor going further.
 *
 * Deliberately NOT an obstruction:
 *
 * - a **centering ring** or **tube coupler** around or inside the mount. A
 *   ring's bore is the motor tube's outside — the motor passes through it —
 *   and treating it as a stop would return a few millimetres on almost every
 *   high-power rocket.
 * - a **mass component** (owner ruling, 2026-09-01). This used to block, on
 *   the reasoning that a mass component is how an altimeter sled gets
 *   modelled. That was wrong, and his own 4" Wildman Extreme is the
 *   counter-example: he models the **motor retainer** as a mass component near
 *   the aft end to get the CG right, and *"a motor retainer is designed to
 *   keep a motor in place, not block it from being installed"*. Blocking on it
 *   measured the room from the retainer forward and reported a few centimetres
 *   on a rocket that takes a 74mm case.
 *
 *   The general point, and it is why this is the right rule rather than a
 *   special case: a mass component is a **mass abstraction with no bore and no
 *   radius**, so nothing about it says whether a motor can pass. Guessing that
 *   it cannot is the guess that breaks a real design. Anything genuinely in
 *   the way has a component type that says so — an engine block or a bulkhead.
 *
 * - a **parachute**, **streamer** or **shock cord** in the mount, which have
 *   never blocked and must not start: they move out of the way when a motor is
 *   loaded (owner, same ruling).
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

/**
 * Components a motor case cannot pass through.
 *
 * Keep this list to things whose PURPOSE is to stop a motor. See the note
 * above on why a mass component is not one of them.
 */
const BLOCKING = new Set(['engineblock', 'bulkhead']);

const DISPLAY: Record<string, string> = {
  engineblock: 'engine block',
  bulkhead: 'bulkhead',
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
