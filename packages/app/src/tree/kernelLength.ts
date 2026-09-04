import type { ComponentNode } from '@online-openrocket/engine';
import { axialLength } from './position.js';

/**
 * The axial extent a component is POSITIONED by — `RocketComponent.getLength()`
 * as the kernel reads it when it resolves a station.
 *
 * `position.axialLength` answers the same question for every type except one,
 * and this wrapper exists solely for that one: a RAIL BUTTON.
 *
 * A rail button carries no `length` key (neither the .ork reader nor the app's
 * defaults write one — tree/schema.ts:670 lists OD, ID, total height, base,
 * flange and screw, and nothing else), so `axialLength` fell through to its
 * `num(n,'length', num(n,'packedLength', 0.025))` tail and answered 25 mm. The
 * kernel answers 0: `RocketComponent.java:86` declares `protected double
 * length = 0` and RailButton never assigns it, and
 * `RailButton.getInstanceBoundingBox` puts the part at ±OD/2 ABOUT its
 * station — the station is the button's CENTRE, not its leading edge.
 *
 * That 25 mm mattered because `startFromPosition` subtracts the extent for the
 * 'middle' and 'bottom' methods, so every consumer that used 25 mm placed the
 * button somewhere the rocket does not fly it:
 *   • 'middle' (the app's own default for a new button) — 12.5 mm aft;
 *   • 'bottom' (what the .ork writer emits for surface parts) — 25 mm aft.
 * The most visible symptom was "Auto-place rail buttons", whose entire job is
 * to put the forward button exactly on the CG: on the default 'middle' method
 * it missed by 12.5 mm, on 'bottom' by 25 mm.
 *
 * ONE function for all consumers is the point. Before this, a button's axial
 * length was three different numbers in one app — the drawings used its outer
 * diameter (9.7 mm by default), the drag/slider/auto-place math used 25 mm,
 * and the flown part used 0.
 */
export function kernelLength(n: ComponentNode): number {
  if (n.type === 'railbutton') return 0;
  return axialLength(n);
}

/**
 * `n` as the helpers in `position.ts` must see it, for the ones that take a
 * NODE and compute the extent themselves (`anchorStarts`, which needs it for
 * the child AND for every sibling it aligns against).
 *
 * Writing a literal `length: 0` is not a trick: it is the kernel's own value
 * for this component, and it is exactly what makes `axialLength`'s tail return
 * 0 without that function having to change. Delete this the moment
 * `axialLength` grows the rail-button branch itself — `kernelLength` above
 * says what the branch should be.
 */
export function inKernelFrame(n: ComponentNode): ComponentNode {
  const fix = (c: ComponentNode): ComponentNode =>
    (c.type === 'railbutton' && c['length'] !== 0 ? ({ ...c, length: 0 } as ComponentNode) : c);
  const self = fix(n);
  // Only the DIRECT children matter: `anchorStarts` never descends further.
  const kids = self.children;
  if (!kids?.length) return self;
  let changed = false;
  const next = kids.map((c) => {
    const f = fix(c);
    if (f !== c) changed = true;
    return f;
  });
  return changed ? ({ ...self, children: next } as ComponentNode) : self;
}
