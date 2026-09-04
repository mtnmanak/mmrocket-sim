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
 * is allowed to stick out past it).
 *
 * **THE MOUNT TUBE IS NOT A LIMIT** (owner ruling, 2026-09-01b): *"motors are
 * allowed to be longer than the motor mount tube. The motor mount tube merely
 * provides a framework for the motor to sit in — motors are frequently longer
 * than the motor mount tube. In most dual deploy rockets, the first real
 * obstruction that stops a motor is the aft bulkhead on the electronics bay."*
 * So the search walks forward out of the mount and on up the stage, and it
 * stops at the first thing a motor case cannot pass:
 *
 * - an **engine block** or **bulkhead** ANYWHERE forward in the same stage,
 *   inside the mount or not — the two components that exist to stop a motor,
 *   and the ebay's aft bulkhead is the one he means;
 * - the aft end of a **nose cone**, which a motor cannot enter;
 * - the aft end of a **transition that narrows going forward**, which closes
 *   down below the tube the motor is travelling up;
 * - failing all of those, the stage's own forward end. It never crosses a
 *   STAGE boundary: stages separate, so a booster's motor cannot run up into
 *   the sustainer.
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
 *
 * **Read `limitedBy` before trusting the number.** Since the mount stopped
 * being a limit, a design that models no internal structure at all can measure
 * most of its own airframe — and it will say so, naming the nose cone or the
 * front of the airframe rather than a bulkhead. That is the honest answer to
 * "nothing is in the way", and it is the cue to model the ebay bulkhead if a
 * real number is wanted.
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
  nosecone: 'the nose cone',
  transition: 'the transition',
};

/** Chain members stack nose-to-tail; everything else sits inside its parent. */
const CHAIN = new Set(['nosecone', 'bodytube', 'transition']);

interface Station { start: number; end: number; node: ComponentNode }

/**
 * Every component in one stage, with its axial extent measured from that
 * stage's FORE end and increasing aft — the same frame the schematic lays out
 * in (`position.ts`: chain members stack and ignore their own position field;
 * everything else is placed inside its parent by `startFromPosition`).
 */
function stationsInStage(stage: ComponentNode): Map<string, Station> {
  const out = new Map<string, Station>();
  const descend = (parent: ComponentNode, pStart: number, pLen: number): void => {
    for (const child of parent.children ?? []) {
      const cLen = axialLength(child);
      const pos = (child.position ?? { method: 'top', offset: 0 }) as ComponentPosition;
      const start = pStart + startFromPosition(pos, cLen, pLen);
      if (child.id) out.set(child.id, { start, end: start + cLen, node: child });
      descend(child, start, cLen);
    }
  };
  let x = 0;
  for (const member of stage.children ?? []) {
    const len = CHAIN.has(member.type) ? axialLength(member) : 0;
    if (member.id) out.set(member.id, { start: x, end: x + len, node: member });
    descend(member, x, len);
    if (CHAIN.has(member.type)) x += len;
  }
  return out;
}

/** A transition closes down going forward, so a motor cannot continue past it. */
const narrowsForward = (n: ComponentNode): boolean =>
  num(n, 'foreRadius', 0) < num(n, 'aftRadius', 0);

export function estimateMotorRoom(tree: RocketTree, mountId: string): MotorRoom | null {
  const mount = findNode(tree, mountId);
  if (!mount) return null;
  if (!(axialLength(mount) > 0)) return null;

  // The mount's own stage. The walk never leaves it: stages separate, so a
  // booster's motor cannot run forward into the sustainer.
  let stations: Map<string, Station> | null = null;
  for (const c of tree.components ?? []) {
    if (c.type !== 'stage') continue;
    const s = stationsInStage(c);
    if (s.has(mountId)) { stations = s; break; }
  }
  if (!stations) {
    // A legacy flat tree has no stage wrappers: the component list is itself
    // one nose-to-tail chain, which is how the schematic reads it too.
    const flat = {
      type: 'stage',
      children: (tree.components ?? []).filter((c) => c.type !== 'stage'),
    } as ComponentNode;
    const s = stationsInStage(flat);
    if (s.has(mountId)) stations = s;
  }
  if (!stations) return null;

  const mine = stations.get(mountId);
  if (!mine) return null;
  const mountAft = mine.end;

  // The forward limit, as a station. 0 is the stage's own fore end, which is
  // the answer when a design models nothing in the way at all.
  let limit = 0;
  let limitedBy: string | null = null;

  for (const { end, node } of stations.values()) {
    if (node.id === mountId) continue;
    const blocks = BLOCKING.has(node.type)
      || node.type === 'nosecone'
      || (node.type === 'transition' && narrowsForward(node));
    if (!blocks) continue;
    // The blocking face is the component's AFT end — a motor seats right up
    // against it — and anything aft of where the motor starts is behind it.
    if (end > mountAft) continue;
    if (end > limit) {
      limit = end;
      limitedBy = node.name ?? DISPLAY[node.type] ?? node.type;
    }
  }

  // THE OVERHANG IS SIGNED, and clamping it at 0 was an over-report. The motor
  // seats with its aft face at `mountAft + overhang` (that is what the field
  // means — schema.ts labels it "Motor overhang (past aft end)" and lets it run
  // to −50 mm on both mount types), so the room forward of that face is
  // `mountAft - limit + overhang`. A positive overhang lengthened the estimate
  // correctly; a NEGATIVE one — a motor recessed so a retainer cap can close
  // over it, the ordinary min-diameter build — was silently thrown away, so a
  // mount with `motorOverhang: -0.02` reported 20 mm more room than it has.
  // That number is what the "Max motor length" ⌾ button writes and what gates
  // the motor browser, so it offered cases that do not fit the airframe.
  const room = mountAft - limit + num(mount, 'motorOverhang', 0);
  // Still the guard that catches the other end: a recess deep enough to close
  // the gap entirely (or a limit aft of the mount) yields no room at all.
  if (!(room > 0)) return null;
  return {
    lengthM: room,
    limitedBy: limitedBy ?? 'the front of the airframe',
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
