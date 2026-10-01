import { describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { absoluteStations, anchorStarts, axialLength } from './position.js';
import { layoutSchematic, schematicFrame, type SchematicFrameOptions } from './schematicLayout.js';
import { buildPieces } from './pieces.js';
import { autoAlignFinSets } from './finAlign.js';
import { rocketLength } from './scaleRocket.js';
import { findNode } from './treeModel.js';
import { nodeLength, stageLength } from '../services/statedLaunchWeight.js';
import { addNewComponent } from '../services/addComponent.js';
import { RAIL_BUTTON_AFT_GAP } from '../services/railButtonPlacement.js';
import { exportOrk } from '../services/orkFile.js';
import { exportRkt } from '../services/rocksimFile.js';
import { exportCdx1 } from '../services/rasaeroFile.js';

/**
 * EVERY READER OF A CHAIN MEMBER'S LENGTH, AGREEING WITH THE KERNEL (audit
 * 2026-09-30, ledger row 373 REGRESSED).
 *
 * A nose cone, body tube or transition saved with no `length` — a pre-22-Sep
 * autosave or a hand-edited file — flies at the kernel bridge's default for
 * its type (ComponentFactory: nose 70 mm, tube 300 mm, transition 50 mm), and
 * `position.axialLength` answers with exactly that. Row 373 was marked fixed
 * when `position.ts` changed, but the side view, its frame, the pod length, the
 * snap ladder, the 3D pieces, Align fins, Scale rocket, the stated launch
 * weight, the property panel, the Add menu and all three file writers each
 * kept a fallback of their own — 0, 0.04, 0.1, 0.15 or 0.2 m. The 2D view
 * drew a zero-length tube with everything behind it 0.3 m too far forward,
 * and a dragged fin resolved against 0 while snapping against 0.2.
 *
 * One design, no lengths anywhere in its chain, walked through each of them.
 */

const R = 0.02;
const NOSE = 0.07, TUBE = 0.3, TRANS = 0.05;

const fin = { id: 'fin', type: 'trapezoidfinset', finCount: 3, rootChord: 0.05, tipChord: 0.03,
  sweep: 0.02, height: 0.03, position: { method: 'bottom', offset: 0 } };

const design = (tubeKids: Record<string, unknown>[] = [fin]): RocketTree => ({
  name: 'No lengths',
  components: [{
    id: 's1', type: 'stage', children: [
      { id: 'nc', type: 'nosecone', shape: 'ogive', aftRadius: R },
      { id: 'bt', type: 'bodytube', outerRadius: R, children: tubeKids },
      { id: 'tr', type: 'transition', shape: 'conical', foreRadius: R, aftRadius: 0.015 },
    ],
  }],
} as unknown as RocketTree);

const withPod = (): RocketTree => design([fin, {
  id: 'pod', type: 'podset', instanceCount: 1, radiusOffset: 0, angleOffset: 0,
  position: { method: 'top', offset: 0 },
  children: [
    { id: 'pn', type: 'nosecone', shape: 'conical', aftRadius: 0.008 },
    { id: 'pb', type: 'bodytube', outerRadius: 0.008 },
  ],
}]);

const node = (t: RocketTree, id: string): ComponentNode => findNode(t, id)!;

describe('a chain with no length keys is read at the kernel\'s lengths everywhere', () => {
  it('axialLength — the kernel bridge\'s defaults, and a pod as the sum of its chain', () => {
    const t = withPod();
    expect(axialLength(node(t, 'nc'))).toBeCloseTo(NOSE, 12);
    expect(axialLength(node(t, 'bt'))).toBeCloseTo(TUBE, 12);
    expect(axialLength(node(t, 'tr'))).toBeCloseTo(TRANS, 12);
    expect(axialLength(node(t, 'pod'))).toBeCloseTo(NOSE + TUBE, 12);
  });

  it('absoluteStations — the frame the kernel reports positionX in', () => {
    const st = absoluteStations(withPod());
    expect(st.get('bt')!.start).toBeCloseTo(NOSE, 12);
    expect(st.get('tr')!.start).toBeCloseTo(NOSE + TUBE, 12);
    expect(st.get('fin')!.start).toBeCloseTo(NOSE + TUBE - 0.05, 12);
    expect(st.get('pb')!.start).toBeCloseTo(NOSE + NOSE, 12);
  });

  const FRAME: SchematicFrameOptions = {
    cw: 640, chPx: 480, maxHeight: 480, rulers: false, rollW: 0, rollBar: 0, lanes: false, topReserve: 0,
  };

  it('the side view: its frame, its tubes, the pod chain, a fin, and the drag frame', () => {
    const t = withPod();
    const f = schematicFrame(t, FRAME);
    expect(f.totalLen).toBeCloseTo(NOSE + TUBE + TRANS, 12);
    const l = layoutSchematic(t, { scale: f.scale, cy: f.cy, x0: f.x0, roll: 0, idPrefix: 't' });
    const at = (m: number) => f.x0 + m * f.scale;
    const body = l.shapes.find((s) => s.key === 'bt:body')!;
    expect(Number(body.attrs['x'])).toBeCloseTo(at(NOSE), 9);
    expect(Number(body.attrs['width'])).toBeCloseTo(TUBE * f.scale, 9);
    const trans = l.shapes.find((s) => s.key === 'tr:transition')!;
    expect(Number(String(trans.attrs['d']).split(' ')[1])).toBeCloseTo(at(NOSE + TUBE), 9);
    const podTube = l.shapes.find((s) => s.key === 'pod#0/pb:body')!;
    expect(Number(podTube.attrs['x'])).toBeCloseTo(at(NOSE + NOSE), 9);
    expect(Number(podTube.attrs['width'])).toBeCloseTo(TUBE * f.scale, 9);
    const finPoly = l.shapes.find((s) => s.key === 'fin:fin0')!;
    expect(Number(String(finPoly.attrs['points']).split(',')[0])).toBeCloseTo(at(NOSE + TUBE - 0.05), 9);
    // The drag resolves an offset in this frame, and snaps with anchorStarts.
    expect(l.grips.get('fin')!.pLen).toBeCloseTo(TUBE, 12);
  });

  it('the snap ladder anchors a Bottom fin flush with the tube\'s real aft end', () => {
    const t = design();
    expect(anchorStarts(node(t, 'bt'), node(t, 'fin'))).toContainEqual(expect.closeTo(TUBE - 0.05, 12));
  });

  it('the 3D pieces — and the STL, OBJ and glTF built from them', () => {
    const { pieces, totalLen } = buildPieces(design());
    expect(totalLen).toBeCloseTo(NOSE + TUBE + TRANS, 12);
    const body = pieces.find((p) => p.key.startsWith('body'))!;
    expect(body.position![0]).toBeCloseTo(NOSE + TUBE / 2, 12);
  });

  it('Align fins reads the tube at 300 mm: two sets 30 mm apart do not overlap', () => {
    // A: top, 0-220 mm. B: bottom, 250-300 mm on the 300 mm tube — but at
    // 150-200 mm, overlapping A, on the 200 mm this used to assume.
    const t = design([
      { id: 'a', type: 'trapezoidfinset', finCount: 4, rootChord: 0.22, tipChord: 0.03, sweep: 0.02,
        height: 0.03, position: { method: 'top', offset: 0 } },
      { id: 'b', type: 'trapezoidfinset', finCount: 4, rootChord: 0.05, tipChord: 0.03, sweep: 0.02,
        height: 0.03, position: { method: 'bottom', offset: 0 } },
    ]);
    expect(autoAlignFinSets(t).changes).toEqual([]);
  });

  it('Scale rocket\'s headline length', () => {
    expect(rocketLength(withPod())).toBeCloseTo(NOSE + TUBE + TRANS, 12);
  });

  it('the stated-launch-weight frame', () => {
    const t = design();
    expect(nodeLength(node(t, 'bt'))).toBeCloseTo(TUBE, 12);
    expect(stageLength(t.components[0])).toBeCloseTo(NOSE + TUBE + TRANS, 12);
  });

  it('a new rail button pair on the tube is spaced on its real 300 mm', () => {
    const { node: rb } = addNewComponent(design([]), 'bt', 'railbutton', null);
    // The fallback rule: the middle of the tube to one inch short of its end.
    expect(rb['instanceSeparation'] as number).toBeCloseTo(TUBE - RAIL_BUTTON_AFT_GAP - TUBE / 2, 12);
  });

  /** The text of the first `<tag>` after `<open>`, as a number. */
  const after = (xml: string, open: string, tag: string): number => {
    const from = xml.indexOf(open);
    expect(from, `${open} in the file`).toBeGreaterThanOrEqual(0);
    const m = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml.slice(from));
    return Number(m![1]);
  };

  it('.ork writes the lengths the design flew', () => {
    const xml = exportOrk({ name: 'x', tree: design() });
    expect(after(xml, '<nosecone>', 'length')).toBeCloseTo(NOSE, 12);
    expect(after(xml, '<bodytube>', 'length')).toBeCloseTo(TUBE, 12);
    expect(after(xml, '<transition>', 'length')).toBeCloseTo(TRANS, 12);
  });

  it('.rkt writes them too, and a Middle part is centred on the tube\'s real length', () => {
    const xml = exportRkt({ name: 'x', tree: design() });
    expect(after(xml, '<NoseCone>', 'Len')).toBeCloseTo(NOSE * 1000, 9);
    expect(after(xml, '<BodyTube>', 'Len')).toBeCloseTo(TUBE * 1000, 9);
    expect(after(xml, '<Transition>', 'Len')).toBeCloseTo(TRANS * 1000, 9);
    // RockSim has no Middle: the writer converts to front-referenced, as
    // desktop's BasePartDTO does, offset + (parent - part) / 2 — with the
    // kernel's length for both. A freeform fin carries neither `length` nor
    // `rootChord`, so its own length read as 0 there too.
    const mid = exportRkt({ name: 'x', tree: design([{ id: 'ff', type: 'freeformfinset', finCount: 3,
      points: [[0, 0], [0.02, 0.03], [0.05, 0.03], [0.06, 0]], position: { method: 'middle', offset: 0 } }]) });
    expect(after(mid, '<CustomFinSet>', 'Xb')).toBeCloseTo(((TUBE - 0.06) / 2) * 1000, 9);
  });

  it('.CDX1 writes them too (RASAero inches)', () => {
    const xml = exportCdx1({ name: 'x', tree: design() });
    const IN = 39.37;
    expect(after(xml, '<NoseCone>', 'Length')).toBeCloseTo(NOSE * IN, 3);
    expect(after(xml, '<BodyTube>', 'Length')).toBeCloseTo(TUBE * IN, 3);
  });
});
