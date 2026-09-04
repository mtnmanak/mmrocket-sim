// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ComponentNode } from '@online-openrocket/engine';
import { CDX1_ENGINE_EXPORT, exportCdx1, importCdx1, rasaeroManufacturerAbbrev } from './rasaeroFile.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(join(here, '__fixtures__', name), 'utf8');

function flatten(nodes: ComponentNode[]): ComponentNode[] {
  const out: ComponentNode[] = [];
  const walk = (ns: ComponentNode[]) => {
    for (const n of ns) {
      out.push(n);
      walk(n.children ?? []);
    }
  };
  walk(nodes);
  return out;
}

describe('RASAero import — desktop fixture files', () => {
  it('imports the three-stage rocket as three stages', () => {
    const r = importCdx1(fixture('Three-stage rocket.CDX1'));
    expect(r.tree.components.length).toBe(3);
    expect(r.tree.components.map((s) => s.name)).toEqual(['Sustainer', 'Booster', 'Booster 2']);
    // Every booster stage has a body tube.
    for (const st of r.tree.components.slice(1)) {
      expect((st.children ?? []).some((c) => c.type === 'bodytube')).toBe(true);
    }
  });

  it('imports the complex two-stage design with inch→meter conversion', () => {
    const r = importCdx1(fixture('Complex.Two-Stage.CDX1'));
    expect(r.tree.components.length).toBe(2);
    const all = flatten(r.tree.components);
    const nose = all.find((c) => c.type === 'nosecone')!;
    // Tangent Ogive → ogive with shape parameter 1.
    expect(nose['shape']).toBe('ogive');
    // RASAero geometry is inches: every radius must be plausible meters.
    for (const c of all) {
      for (const k of ['aftRadius', 'outerRadius', 'foreRadius']) {
        if (typeof c[k] === 'number') {
          expect(c[k] as number).toBeGreaterThan(0.001);
          expect(c[k] as number).toBeLessThan(0.5);
        }
      }
    }
    // Fins exist, and fins on the boat tail became freeform.
    expect(all.some((c) => c.type === 'trapezoidfinset')).toBe(true);
    const transitions = all.filter((c) => c.type === 'transition');
    expect(transitions.length).toBeGreaterThan(0);
    expect(transitions.every((t) => t['shape'] === 'conical')).toBe(true);
    const transFins = transitions.flatMap((t) => (t.children ?? []).filter((c) => c.type.endsWith('finset')));
    expect(transFins.every((f) => f.type === 'freeformfinset')).toBe(true);

    // Recovery slots became parachutes with deployment settings.
    const chutes = all.filter((c) => c.type === 'parachute');
    expect(chutes.length).toBe(2);
    expect(chutes.some((c) => c['deployEvent'] === 'apogee')).toBe(true);
    expect(chutes.some((c) => c['deployEvent'] === 'altitude')).toBe(true);

    // Honest notes: mass caveat. Motors now import as flight configurations
    // (see the simulations tests), so the old "add a mount" hint is gone.
    expect(r.notes.join(' ')).toMatch(/no material or wall data/);
    expect(r.notes.join(' ')).not.toMatch(/Motors in the RASAero file/);
  });

  it('imports the show-off design with its launch lug', () => {
    const r = importCdx1(fixture('Show-off.CDX1'));
    const all = flatten(r.tree.components);
    expect(all.some((c) => c.type === 'launchlug')).toBe(true);
  });
});

/**
 * The parts that OVERLAP instead of stacking. RASAero's part list is flat and
 * two of its kinds slide over/into the part they belong to, so they add NO
 * length to the airframe: a `<FinCan>` (a tube over the tube in front of it)
 * and a `<BoatTail>` sitting above a `<Booster>` (recessed into that booster).
 *
 * We used to stack both end to end. Measured with the shipped kernel, that
 * built @Buckeye's MESOS files 160.82 in long against the 147.32 in their own
 * `<Location>` fields imply (+9.2 %), Complex.Two-Stage 74.00 against 65.00
 * (+13.8 %) and Show-off 25.34 against 22.00 (+15.2 %) — with CP, CG and
 * stability all dragged aft with the length, and two phantom DISCONTINUITY
 * warnings at the joints that only existed because of the stacking.
 *
 * Desktop OpenRocket models both as inline pod sets (FinCanHandler.java:46-58,
 * BoattailHandler.java:52-65) and so do we now. A pod contributes no axial
 * length, which is the whole fix.
 */
describe('RASAero import — overlapping parts become inline pods', () => {
  const IN = 39.37;
  const stageTubes = (stage: ComponentNode) => (stage.children ?? []).filter((c) => c.type === 'bodytube');
  const podsOn = (node: ComponentNode) =>
    (node.children ?? []).filter((c) => (c.type as string) === 'podset');

  it('slides a fin can over the tube in front of it instead of stacking it', () => {
    const r = importCdx1(fixture('Complex.Two-Stage.CDX1'));
    const sustainer = r.tree.components[0]!;
    // Nothing named "Fin can" is a stage-level body tube any more.
    expect((sustainer.children ?? []).some((c) => c.type === 'bodytube' && /Fin can/.test(String(c.name))))
      .toBe(false);

    const host = stageTubes(sustainer).at(-1)!;
    const pod = podsOn(host).find((p) => p.name === 'Fin can')!;
    expect(pod).toBeDefined();
    // Desktop's exact placement: one instance, RadiusMethod.FREE radius 0,
    // AxialMethod.BOTTOM offset 0 (FinCanHandler.java:49-57).
    expect(pod['instanceCount']).toBe(1);
    expect(pod['radiusMethod']).toBe('free');
    expect(pod['radiusOffset']).toBe(0);
    expect(pod['angleOffset']).toBe(0);
    expect(pod.position?.method).toBe('bottom');
    expect(pod.position?.offset).toBeCloseTo(0, 9);

    // …holding the conical shoulder then the can tube (FinCanHandler.java:93
    // prepends the shoulder at index 0).
    const kids = pod.children ?? [];
    expect(kids.map((c) => [c.type, c.name])).toEqual([
      ['transition', 'Fin can shoulder'],
      ['bodytube', 'Fin can tube'],
    ]);
    expect((kids[0]!['length'] as number) * IN).toBeCloseTo(0.25, 6); // <ShoulderLength>
    expect((kids[0]!['foreRadius'] as number) * 2 * IN).toBeCloseTo(3, 6); // <InsideDiameter>
    expect((kids[0]!['aftRadius'] as number) * 2 * IN).toBeCloseTo(3.25, 6); // the can's own OD
    expect((kids[1]!['length'] as number) * IN).toBeCloseTo(6, 6);

    // The fins came with it — they are the reason a fin can matters at all.
    const fins = (kids[1]!.children ?? []).find((c) => c.type === 'trapezoidfinset')!;
    expect(fins['finCount']).toBe(5);
    expect((fins['rootChord'] as number) * IN).toBeCloseTo(6, 6);

    expect(r.notes.join(' ')).toMatch(/fin can slides over the tube in front of it/);
    expect(r.notes.join(' ')).not.toMatch(/the sliding overlap is not modeled/);
  });

  it('recesses a boat tail into the booster below it', () => {
    const r = importCdx1(fixture('Complex.Two-Stage.CDX1'));
    const sustainer = r.tree.components[0]!;
    expect((sustainer.children ?? []).some((c) => c.type === 'transition' && c.name === 'Boat tail'))
      .toBe(false);

    const host = stageTubes(sustainer).at(-1)!;
    const pod = podsOn(host).find((p) => p.name === 'Boat tail pod')!;
    expect(pod).toBeDefined();
    expect(pod['instanceCount']).toBe(1);
    expect(pod['radiusMethod']).toBe('free');
    // TOP / the host tube's own length — BoattailHandler.java:64-65 exactly, so
    // the pod's front sits on the host tube's aft face and the booster below
    // starts at the same station the boat tail does.
    expect(pod.position?.method).toBe('top');
    expect(pod.position?.offset).toBeCloseTo(host['length'] as number, 12);
    expect((pod.children ?? []).map((c) => [c.type, c.name])).toEqual([['transition', 'Boat tail']]);

    expect(r.notes.join(' ')).toMatch(/boat tail slides inside the booster below it/);
  });

  it('a boat tail behind a fin can still narrows from the FIN CAN’s diameter', () => {
    // The fore radius of a .CDX1 transition is implicit — it comes from the
    // part in front of it. Once the fin can moved into a pod, the preceding
    // stage-level SIBLING became the host tube the can covers, and taking the
    // radius from there quietly shrank the boat tail's front: measured,
    // Complex.Two-Stage went 3.25 → 3.00 in and MESOS_Last_Preflight_File
    // 3.21 → 3.15 in, both contradicting the files' own <BoatTail><Diameter>.
    // The importer therefore tracks the airframe radius AT the station, which
    // the fin can updates even though it adds no length.
    const r = importCdx1(fixture('Complex.Two-Stage.CDX1'));
    const bt = flatten(r.tree.components).find((c) => c.name === 'Boat tail')!;
    expect((bt['foreRadius'] as number) * 2 * IN).toBeCloseTo(3.25, 4); // the file's own <Diameter>
    expect((bt['aftRadius'] as number) * 2 * IN).toBeCloseTo(2.75, 4);
  });

  it('leaves a single-stage boat tail inline (no booster to recess into)', () => {
    // Desktop pod-ises EVERY boat tail; we deliberately do not. It is
    // numerically free either way (ARCAS-Long - 2 measures 53.5001 in /
    // CG 37.4201 / CP 40.6627 / 1.4412 cal both ways), but TreeSchematic
    // computes the drawing's total length from the TOP-LEVEL chain only, so a
    // pod hanging past its host tube would draw off the canvas edge and
    // mis-scale the whole schematic. With a booster below it the pod can never
    // overhang, which is why the rule is narrowed to that case.
    const r = importCdx1(fixture('ARCAS-Long - 2.CDX1'));
    const sustainer = r.tree.components[0]!;
    expect(r.tree.components.length).toBe(1);
    expect((sustainer.children ?? []).some((c) => c.type === 'transition' && c.name === 'Boat tail'))
      .toBe(true);
    expect(flatten(r.tree.components).some((c) => (c.type as string) === 'podset')).toBe(false);
  });

  it('leaves the stage motor mount on the host tube, not inside the pod', () => {
    // Desktop's getMotorMountForStage (SimulationHandler.java:219-228) walks
    // DIRECT stage children only, and a PodSet is not a MotorMount — so the
    // host body tube stays the mount. It is also numerically identical: the
    // pod is bottom-flush, both tubes end at the same station (55 in on this
    // file), and OpenRocket seats a motor from the mount's AFT face.
    const r = importCdx1(fixture('Complex.Two-Stage.CDX1'));
    const mount = stageTubes(r.tree.components[0]!).at(-1)!;
    expect(mount.name).toBe('Body tube');
    expect(mount['motorMount']).toBe(true);
    expect(r.motors[mount.id!]!.designation).toBe('J90W');
    // …and the can's tube is NOT a mount.
    const canTube = podsOn(mount).find((p) => p.name === 'Fin can')!.children!
      .find((c) => c.type === 'bodytube')!;
    expect(canTube['motorMount']).toBeUndefined();
  });

  it('reports a booster whose stored <Location> disagrees with the parts above it', () => {
    // READ-ONLY. <Booster><Location> is the shoulder start, which is exactly
    // the running station once the overlapping parts stop inflating it. Across
    // the corpus it agrees everywhere except ThreeCarbYen-2018's second
    // booster, whose stored value sits one shoulder length ahead of the stack —
    // a <Location> RASAero never reflowed. Positioning from it would silently
    // move that design, so we say so and build from the parts.
    const stale = `<?xml version="1.0"?><RASAeroDocument><RocketDesign>
      <NoseCone><PartType>NoseCone</PartType><Length>10</Length><Diameter>3</Diameter>
        <Shape>Tangent Ogive</Shape><Location>0</Location></NoseCone>
      <BodyTube><PartType>BodyTube</PartType><Length>20</Length><Diameter>3</Diameter>
        <Location>10</Location></BodyTube>
      <Booster><PartType>Booster</PartType><Length>15</Length><Diameter>3</Diameter>
        <InsideDiameter>3</InsideDiameter><ShoulderLength>2</ShoulderLength>
        <Location>28</Location></Booster>
      </RocketDesign></RASAeroDocument>`;
    const bad = importCdx1(stale);
    expect(bad.notes.join(' ')).toMatch(/Booster: the file says it starts at 28 in, but the parts above it add up to 30\.000 in/);

    // …and it stays quiet on the files that agree, which is every other one.
    for (const name of ['Complex.Two-Stage.CDX1', 'Show-off.CDX1', 'Three-stage rocket.CDX1',
      'launch-stage-motorless.CDX1']) {
      expect(importCdx1(fixture(name)).notes.join(' '), name).not.toMatch(/but the parts above it add up to/);
    }
  });

  it('MEASURED: the kernel builds each fixture at the length its own file states', async () => {
    // Exact, re-measured with the shipped kernel — not tolerances to tune.
    // Complex.Two-Stage and Show-off MOVE (74.00 → 65.00 in and 25.34 → 22.00);
    // the other three are the regression control and must not budge.
    const { OrkRocket, resetEngine } = await import('@online-openrocket/engine');
    const { engineTree } = await import('../tree/treeModel.js');
    const expected: [string, number][] = [
      ['Complex.Two-Stage.CDX1', 1.651003302], // 65.0000 in — was 74.0000
      ['Show-off.CDX1', 0.558801118], //           22.0000 in — was 25.3400
      ['ARCAS-Long - 2.CDX1', 1.358902718], //     53.5000 in — unchanged
      ['Three-stage rocket.CDX1', 0.560020320], // 22.0480 in — unchanged
      ['launch-stage-motorless.CDX1', 2.400304801], // 94.5000 in — unchanged
    ];
    for (const [name, lengthM] of expected) {
      resetEngine();
      const info = OrkRocket.buildTree(engineTree(importCdx1(fixture(name)).tree)).staticInfo();
      expect(info.length, name).toBeCloseTo(lengthM, 8);
    }
  }, 120000);

  it('MEASURED: the phantom joint warnings the stacking invented are gone', async () => {
    const { OrkRocket, resetEngine } = await import('@online-openrocket/engine');
    const { engineTree } = await import('../tree/treeModel.js');
    resetEngine();
    const complex = OrkRocket.buildTree(engineTree(importCdx1(fixture('Complex.Two-Stage.CDX1')).tree))
      .staticInfo().warningTexts;
    // Was: DISCONTINUITY "Body tube","Fin can" and "Boat tail","Booster
    // shoulder" — both artefacts of stacking parts that overlap. What is left
    // is the one real step, into the 6 in booster shoulder.
    expect(complex.some((w) => /DISCONTINUITY/.test(w) && /Fin can|Boat tail/.test(w))).toBe(false);
    expect(complex.some((w) => /DISCONTINUITY/.test(w) && /"Body tube", "Booster shoulder"/.test(w))).toBe(true);
    // The overlap the pod really is, said honestly (desktop raises it too).
    expect(complex.some((w) => /PODSET_OVERLAP/.test(w) && /Fin can/.test(w))).toBe(true);

    // Show-off GAINS a truthful one: its 1.5 in tube really does step to
    // 2.73 in, a step the stacked fin can used to bridge. Ship the honest
    // warning rather than hide it.
    resetEngine();
    const showoff = OrkRocket.buildTree(engineTree(importCdx1(fixture('Show-off.CDX1')).tree))
      .staticInfo().warningTexts;
    expect(showoff.some((w) => /DISCONTINUITY/.test(w) && /"Body tube", "Body tube"/.test(w))).toBe(true);
    expect(showoff.some((w) => /DISCONTINUITY/.test(w) && /Fin can|Boat tail/.test(w))).toBe(false);
  }, 120000);
});

describe('RASAero import — supersonic airfoils, launch site, simulations', () => {
  it('imports the ARCAS double-wedge airfoil, deriving the TE chamfer', () => {
    const r = importCdx1(fixture('ARCAS-Long - 2.CDX1'));
    const fins = flatten(r.tree.components).find((c) => c.type === 'trapezoidfinset')!;
    expect(fins['crossSection']).toBe('airfoil'); // desktop parity for supersonic sections
    expect(fins['airfoilSection']).toBe('doublewedge');
    expect(fins['airfoilLeDiamond']).toBeCloseTo(1.4863 / 39.37, 6); // FX1
    // TE = (Chord + TipChord)/2 − FX1; the file's stale <FX3> 0.465 matches nothing.
    expect(fins['airfoilTeDiamond']).toBeCloseTo(0.0326695, 6);
    expect(fins['finLeRadius']).toBeUndefined(); // LERadius 0
  });

  it('imports the ARCAS launch site in SI (pressure 0 = unset)', () => {
    const r = importCdx1(fixture('ARCAS-Long - 2.CDX1'));
    expect(r.launch!.launchAltitudeM).toBeCloseTo(3933 / 3.28084, 3); // FEET
    expect(r.launch!.temperatureC).toBeCloseTo((80 - 32) * 5 / 9, 6); // °F
    expect(r.launch!.launchRodLengthM).toBeCloseTo(12 / 3.28084, 4); // FEET, not inches
    expect(r.launch!.launchRodAngleDeg).toBe(0);
    expect(r.launch!.windAverage).toBe(0);
    expect(r.launch!.pressureHPa).toBeNull(); // unset → explicit ISA, never absent
  });

  it('reports what the ARCAS import dropped, and invents no motors', () => {
    const r = importCdx1(fixture('ARCAS-Long - 2.CDX1'));
    // Its only <Simulation> carries no engines: no mounts, no configurations.
    expect(r.motors).toEqual({});
    expect(r.configs).toEqual([]);
    expect(r.chosenConfigId).toBeNull();
    const joined = r.notes.join(' ');
    expect(joined).toMatch(/protuberance/i);
    expect(joined).toMatch(/BluntRadius/);
  });

  /**
   * §7.5e. Chuck Rogers' ARCAS carries `<StreamlinedWithBaseDrag>0.178</…>` —
   * the four fin-root anchors, entered as one total frontal area in square
   * inches. It used to reach us as a note and nothing else, and the validation
   * fixture records the omission as "kernel CD reads LOW".
   */
  it('imports the ARCAS <Protuberance> as a real component, area exact', () => {
    const r = importCdx1(fixture('ARCAS-Long - 2.CDX1'));
    const prots = flatten(r.tree.components).filter((c) => (c.type as string) === 'protuberance');
    expect(prots).toHaveLength(1);
    const p = prots[0]!;
    expect(p['dragClass']).toBe('streamlinedbase');
    expect(p['count']).toBe(1);
    // Equal-area square (Rogers' own convention), so the area survives exactly.
    const IN2 = 39.37 * 39.37;
    expect((p['width'] as number) * (p['height'] as number) * IN2).toBeCloseTo(0.178, 9);
    expect(p['width']).toBe(p['height']);
    // It hangs off the body tube that declared it, not the stage.
    const tube = flatten(r.tree.components).find((c) => c.type === 'bodytube')!;
    expect((tube.children ?? []).some((c) => c.id === p.id)).toBe(true);
    // …and the note SAYS it imported, with the area, instead of the old
    // "protuberance drag is not modeled".
    expect(r.notes.join(' ')).toContain('Imported 1 RASAero protuberance on Body tube (0.1780 in²)');
    expect(r.notes.join(' ')).not.toMatch(/protuberance drag is not modeled/);
  });

  it('leaves a design with no <Protuberance> block untouched', () => {
    for (const f of ['RMA53D02 - 2.CDX1', 'Show-off.CDX1', 'Three-stage rocket.CDX1']) {
      const r = importCdx1(fixture(f));
      expect(flatten(r.tree.components).filter((c) => (c.type as string) === 'protuberance'))
        .toHaveLength(0);
    }
  });

  /**
   * The desktop's own two-stage sample carries BOTH kinds on one tube:
   * 0.25 in² with base drag and 0.25 in² of inclined flat plate at 30°.
   * Two entries, two components, and the plate angle arrives in RADIANS.
   */
  it('imports both protuberance kinds from one <Protuberance> block', () => {
    const r = importCdx1(fixture('Complex.Two-Stage.CDX1'));
    const prots = flatten(r.tree.components).filter((c) => (c.type as string) === 'protuberance');
    expect(prots).toHaveLength(2);
    const IN2 = 39.37 * 39.37;
    const base = prots.find((p) => p['dragClass'] === 'streamlinedbase')!;
    const plate = prots.find((p) => p['dragClass'] === 'plate')!;
    expect((base['width'] as number) * (base['height'] as number) * IN2).toBeCloseTo(0.25, 9);
    expect((plate['width'] as number) * (plate['height'] as number) * IN2).toBeCloseTo(0.25, 9);
    expect(plate['plateAngle']).toBeCloseTo(Math.PI / 6, 12); // 30° as radians
    expect(base['plateAngle']).toBeUndefined();
    // Straight back out, both slots, degrees at the file boundary again. Only
    // the stage that owns them — this two-stage sample's BOOSTER has extra
    // transitions the exporter refuses for unrelated reasons.
    const owner = r.tree.components.find(
      (s) => flatten([s]).some((c) => c.id === base.id))!;
    const out = exportCdx1({ name: 'Complex', tree: { name: 'Complex', components: [owner] } });
    expect(out).toMatch(/<StreamlinedWithBaseDrag>0\.25<\/StreamlinedWithBaseDrag>/);
    expect(out).toMatch(/<InclinedPlate1Angle>30<\/InclinedPlate1Angle>/);
    expect(out).toMatch(/<InclinedPlate1FrontalArea>0\.25<\/InclinedPlate1FrontalArea>/);
  });

  it('round-trips protuberances back out to <Protuberance>, summed per class', () => {
    const r = importCdx1(fixture('ARCAS-Long - 2.CDX1'));
    const out = exportCdx1({ name: 'ARCAS', tree: r.tree });
    expect(out).toMatch(/<Protuberance>/);
    expect(out).toMatch(/<StreamlinedWithBaseDrag>0\.178<\/StreamlinedWithBaseDrag>/);
    expect(out).toMatch(/<StreamlinedNoBaseDrag>0<\/StreamlinedNoBaseDrag>/);
    expect(out).toMatch(/<InclinedPlate1Angle>0<\/InclinedPlate1Angle>/);
    // …and re-importing our own output gives the same area back.
    const back = importCdx1(out);
    const p = flatten(back.tree.components).find((c) => (c.type as string) === 'protuberance')!;
    const IN2 = 39.37 * 39.37;
    expect((p['width'] as number) * (p['height'] as number) * IN2).toBeCloseTo(0.178, 9);
  });

  it('exports inclined plates grouped by angle into RASAero\'s two slots', () => {
    const r = importCdx1(fixture('ARCAS-Long - 2.CDX1'));
    const tube = flatten(r.tree.components).find((c) => c.type === 'bodytube')!;
    const plate = (deg: number, side: number, count: number): ComponentNode => ({
      type: 'protuberance', dragClass: 'plate', plateAngle: (deg * Math.PI) / 180,
      width: side, height: side, length: side, count, mass: 0,
      position: { method: 'middle', offset: 0 },
    } as unknown as ComponentNode);
    // 30° twice (must SUM), 60° once, 20° once — three distinct angles into two
    // slots, so the smallest total folds into its nearest kept angle.
    const s = 0.01;
    tube.children = [...(tube.children ?? []),
      plate(30, s, 2), plate(30, s, 1), plate(60, s, 4), plate(20, s, 1)];
    const out = exportCdx1({ name: 'ARCAS', tree: r.tree });
    const IN2 = 39.37 * 39.37;
    const a = (n: number) => n * s * s * IN2;
    const angle1 = /<InclinedPlate1Angle>([\d.]+)<\/InclinedPlate1Angle>/.exec(out)![1]!;
    const area1 = /<InclinedPlate1FrontalArea>([\d.]+)<\/InclinedPlate1FrontalArea>/.exec(out)![1]!;
    const angle2 = /<InclinedPlate2Angle>([\d.]+)<\/InclinedPlate2Angle>/.exec(out)![1]!;
    const area2 = /<InclinedPlate2FrontalArea>([\d.]+)<\/InclinedPlate2FrontalArea>/.exec(out)![1]!;
    expect(Number(angle1)).toBeCloseTo(60, 1); // 4 units — the largest
    expect(Number(area1)).toBeCloseTo(a(4), 3);
    expect(Number(angle2)).toBeCloseTo(30, 1); // 2 + 1 summed
    // The lone 20° (1 unit) folds into 30°, the nearest kept angle: 3 + 1 = 4.
    expect(Number(area2)).toBeCloseTo(a(4), 3);
    // Nothing lost: the two slots carry every square inch that went in.
    expect(Number(area1) + Number(area2)).toBeCloseTo(a(8), 3);
  });

  it('imports the ARCAS Mach-Alt conditions table, deduplicated and SI', () => {
    const r = importCdx1(fixture('ARCAS-Long - 2.CDX1'));
    // The file writes its ten rows SIX times over (60 <Item>s) — RASAero's
    // editor repeats the block per grid page. Undeduplicated, the repeats make
    // the engine's Mach interpolator walk a non-monotone ladder.
    expect(r.machAlt).toHaveLength(10);
    expect(r.machAlt!.map(([m]) => m)).toEqual([0, 0.42, 0.9, 1.05, 1.2, 1.5, 2, 4, 5, 25]);
    // Feet → metres, and Mach-ascending (the engine interpolates assuming it).
    expect(r.machAlt![2]![1]).toBeCloseTo(25000 / 3.28084, 3); // 25 kft at M0.9
    expect(r.machAlt![9]![1]).toBeCloseTo(122500 / 3.28084, 3);
    for (let i = 1; i < r.machAlt!.length; i++) {
      expect(r.machAlt![i]![0]).toBeGreaterThan(r.machAlt![i - 1]![0]);
    }
    // Same table the validation harness carries by hand for the two ARCAS
    // cells (validation/anchors.json `machAlt`, ft already converted) — so the
    // in-app comparison now runs at the harness's own tunnel-Re conditions
    // without anyone retyping them. Agreement to 1 cm.
    const harness: [number, number][] = [[0, 0], [0.42, 0.3], [0.9, 7620], [1.05, 9296.4],
      [1.2, 10058.4], [1.5, 11277.6], [2, 13411.2], [4, 17983.2], [5, 19202.4]];
    for (const [i, [mach, altM]] of harness.entries()) {
      expect(r.machAlt![i]![0]).toBe(mach);
      expect(Math.abs(r.machAlt![i]![1] - altM)).toBeLessThan(0.01);
    }
    // And it's advertised, or nobody would know to switch conditions.
    expect(r.notes.join(' ')).toMatch(/Mach-Alt conditions table \(10 points/);
  });

  it('imports the RMA Mach-Alt table (already unique) and leaves table-less files alone', () => {
    const rma = importCdx1(fixture('RMA53D02 - 2.CDX1'));
    expect(rma.machAlt).toHaveLength(5);
    expect(rma.machAlt!.map(([m]) => m)).toEqual([0, 2.5, 5, 10, 25]);
    expect(rma.machAlt![2]![1]).toBeCloseTo(4750 / 3.28084, 3); // the one non-zero row
    // The note quotes the table's HIGHEST altitude, not its last row (which is
    // back at sea level here).
    expect(rma.notes.join(' ')).toMatch(/5 points, to 4750 ft/);
    // Files with no <MachAlt> element carry no table and gain no note.
    const plain = importCdx1(fixture('Complex.Two-Stage.CDX1'));
    expect(plain.machAlt).toBeUndefined();
    expect(plain.notes.join(' ')).not.toMatch(/Mach-Alt/);
  });

  it('imports the RMA hexagonal-blunt-base airfoil (no TE chamfer)', () => {
    const r = importCdx1(fixture('RMA53D02 - 2.CDX1'));
    const fins = flatten(r.tree.components).find((c) => c.type === 'trapezoidfinset')!;
    expect(fins['airfoilSection']).toBe('hexbluntbase');
    expect(fins['crossSection']).toBe('airfoil');
    expect(fins['airfoilLeDiamond']).toBeCloseTo(0.189 / 39.37, 7);
    expect(fins['airfoilTeDiamond']).toBeUndefined();
  });

  it('turns each engine-carrying simulation into a flight configuration', () => {
    const r = importCdx1(fixture('Complex.Two-Stage.CDX1'));
    expect(r.configs.length).toBe(2);
    expect(r.chosenConfigId).toBe(r.configs[0]!.id);
    expect(r.configs[0]!.isDefault).toBe(true);
    expect(r.configs[1]!.isDefault).toBe(false);

    // RASAero's mount for a stage is its aft-most body tube.
    const lastTube = (stage: ComponentNode): ComponentNode => {
      const tubes = (stage.children ?? []).filter((c) => c.type === 'bodytube');
      return tubes[tubes.length - 1]!;
    };
    const sustainerMount = lastTube(r.tree.components[0]!);
    const boosterMount = lastTube(r.tree.components[1]!);
    expect(sustainerMount['motorMount']).toBe(true);
    expect(boosterMount['motorMount']).toBe(true);

    const cfg1 = r.configs[0]!;
    const sus = cfg1.motors[sustainerMount.id!]!;
    expect(sus.designation).toBe('J90W');
    expect(sus.manufacturer).toBe('AT');
    expect(sus.delay).toBe(Infinity); // RASAero is apogee-deploy: plugged
    expect(sus.ignitionEvent).toBe('burnout'); // upper stage lights at booster burnout
    const boo = cfg1.motors[boosterMount.id!]!;
    expect(boo.designation).toBe('I170G');
    expect(boo.ignitionEvent).toBe('automatic'); // bottom stage
    expect(boo.delay).toBe(0);
    // IncludeBooster1 True: separation 2 s after burnout, keyed by the stage.
    expect(cfg1.separations[r.tree.components[1]!.id!])
      .toEqual({ separationEvent: 'burnout', separationDelay: 2 });

    const cfg2 = r.configs[1]!;
    expect(cfg2.motors[sustainerMount.id!]!.designation).toBe('J180T');
    expect(cfg2.motors[boosterMount.id!]!.designation).toBe('I215R');

    // The first engine-carrying simulation is the applied configuration.
    expect(r.motors).toEqual(cfg1.motors);
  });

  it('bakes the chosen configuration separation onto the booster stage node', () => {
    // App.applyImported applies configs, not stage settings — a fresh import
    // must carry burnout + delay on the node itself, or the kernel separates
    // on its default (ejection charge, 0 s).
    const r = importCdx1(fixture('Complex.Two-Stage.CDX1'));
    const booster = r.tree.components[1]!;
    expect(booster['separationEvent']).toBe('burnout');
    expect(booster['separationDelay']).toBe(2); // Booster1SeparationDelay
  });

  it('flies sustainer-only when IncludeBooster1 is False (desktop enableMotorMount parity)', () => {
    const xml = fixture('Complex.Two-Stage.CDX1')
      .replace(/<IncludeBooster1>True<\/IncludeBooster1>/g, '<IncludeBooster1>False</IncludeBooster1>');
    const r = importCdx1(xml);
    expect(r.configs.length).toBe(2);
    const lastTube = (stage: ComponentNode): ComponentNode => {
      const tubes = (stage.children ?? []).filter((c) => c.type === 'bodytube');
      return tubes[tubes.length - 1]!;
    };
    const sustainerMount = lastTube(r.tree.components[0]!);
    for (const cfg of r.configs) {
      expect(Object.keys(cfg.motors)).toEqual([sustainerMount.id]);
      expect(cfg.separations).toEqual({});
    }
    // The excluded booster's tube gets no mount flag and its stage no separation.
    expect(lastTube(r.tree.components[1]!)['motorMount']).toBeUndefined();
    expect(r.tree.components[1]!['separationEvent']).toBeUndefined();
    expect(r.tree.components[1]!['separationDelay']).toBeUndefined();
  });
});

describe('RASAero export', () => {
  const design = {
    name: 'CdxOut',
    tree: {
      name: 'CdxOut',
      components: [
        {
          type: 'stage' as const, id: 's0', name: 'Sustainer',
          children: [
            { type: 'nosecone' as const, id: 'n', length: 0.3, aftRadius: 0.0508, thickness: 0.002, shape: 'haack', shapeParameter: 0 },
            {
              type: 'bodytube' as const, id: 'b', length: 1.0, outerRadius: 0.0508, thickness: 0.001,
              children: [
                { type: 'trapezoidfinset' as const, id: 'f', finCount: 4, rootChord: 0.15, tipChord: 0.07, sweep: 0.05, height: 0.11, thickness: 0.004, crossSection: 'airfoil', position: { method: 'bottom' as const, offset: 0 } },
                { type: 'parachute' as const, id: 'p', diameter: 0.9, deployEvent: 'apogee' },
              ],
            },
          ],
        },
      ],
    },
    launchMassKg: 4.5,
    launchCgM: 0.85,
  };

  it('writes a valid CDX1 that round-trips through our importer', () => {
    const xml = exportCdx1(design);
    expect(xml).toContain('<FileVersion>2</FileVersion>');
    expect(xml).toContain('<Shape>Von Karman Ogive</Shape>');
    // 4-inch airframe: 0.0508 m radius → 4 in diameter (trailing zeros stripped).
    expect(xml).toMatch(/<Diameter>4(\.000\d?)?<\/Diameter>/);
    expect(xml).toContain('<AirfoilSection>Subsonic NACA</AirfoilSection>');
    expect(xml).toContain('<SustainerLaunchWt>9.9208</SustainerLaunchWt>');

    const back = importCdx1(xml);
    const all = flatten(back.tree.components);
    const nose = all.find((c) => c.type === 'nosecone')!;
    expect(nose['shape']).toBe('haack');
    expect(nose['length']).toBeCloseTo(0.3, 3);
    const fins = all.find((c) => c.type === 'trapezoidfinset')!;
    expect(fins['finCount']).toBe(4);
    expect(fins['rootChord']).toBeCloseTo(0.15, 3);
    const chute = all.find((c) => c.type === 'parachute')!;
    expect(chute['deployEvent']).toBe('apogee');
  });

  it('rejects fin counts RASAero cannot hold (3–8)', () => {
    const bad = structuredClone(design);
    (bad.tree.components[0]!.children![1]!.children![0] as ComponentNode)['finCount'] = 2;
    expect(() => exportCdx1(bad)).toThrow(/3–8 fins/);
  });

  it('converts trapezoid-shaped freeform fins instead of dropping them', () => {
    const d = {
      name: 'FF',
      tree: {
        components: [{
          type: 'stage' as const, id: 's', name: 'Sustainer',
          children: [
            { type: 'nosecone' as const, id: 'n', length: 0.2, aftRadius: 0.025, thickness: 0.002, shape: 'ogive' },
            {
              type: 'bodytube' as const, id: 'b', length: 0.6, outerRadius: 0.025, thickness: 0.001,
              children: [{
                type: 'freeformfinset' as const, id: 'f', finCount: 3, thickness: 0.003,
                points: [[0, 0], [0.04, 0.06], [0.09, 0.06], [0.12, 0]] as [number, number][],
                position: { method: 'bottom' as const, offset: 0 },
              }],
            },
          ],
        }],
      },
    };
    const xml = exportCdx1(d);
    expect(xml).toContain('<Fin>');
    const back = importCdx1(xml);
    const fins = flatten(back.tree.components).find((c) => c.type === 'trapezoidfinset')!;
    expect(fins['rootChord']).toBeCloseTo(0.12, 3);
    expect(fins['tipChord']).toBeCloseTo(0.05, 3);
    expect(fins['sweep']).toBeCloseTo(0.04, 3);
    expect(fins['height']).toBeCloseTo(0.06, 3);
  });

  it('throws (never silently drops) fins RASAero cannot represent', () => {
    const withFin = (fin: ComponentNode) => ({
      name: 'X',
      tree: {
        components: [{
          type: 'stage' as const, id: 's', name: 'Sustainer',
          children: [
            { type: 'nosecone' as const, id: 'n', length: 0.2, aftRadius: 0.025, thickness: 0.002, shape: 'ogive' },
            { type: 'bodytube' as const, id: 'b', length: 0.6, outerRadius: 0.025, thickness: 0.001, children: [fin] },
          ],
        }],
      },
    });
    expect(() => exportCdx1(withFin({
      type: 'freeformfinset', id: 'f', finCount: 3, thickness: 0.003,
      points: [[0, 0], [0.02, 0.04], [0.05, 0.06], [0.09, 0.05], [0.12, 0]],
    } as ComponentNode))).toThrow(/trapezoid/i);
    expect(() => exportCdx1(withFin({
      type: 'ellipticalfinset', id: 'f', finCount: 3, rootChord: 0.08, height: 0.05, thickness: 0.003,
    } as ComponentNode))).toThrow(/elliptical/i);
  });

  it('round-trips booster shoulder and boat-tail geometry', () => {
    const d = {
      name: 'B',
      tree: {
        components: [
          {
            type: 'stage' as const, id: 's0', name: 'Sustainer',
            children: [
              { type: 'nosecone' as const, id: 'n', length: 0.2, aftRadius: 0.02, thickness: 0.002, shape: 'conical' },
              { type: 'bodytube' as const, id: 'b0', length: 0.5, outerRadius: 0.02, thickness: 0.001 },
            ],
          },
          {
            type: 'stage' as const, id: 's1', name: 'Booster',
            children: [
              { type: 'transition' as const, id: 'sh', length: 0.05, foreRadius: 0.02, aftRadius: 0.03, thickness: 0.002, shape: 'conical' },
              { type: 'bodytube' as const, id: 'b1', length: 0.4, outerRadius: 0.03, thickness: 0.001 },
              { type: 'transition' as const, id: 'bt', length: 0.06, foreRadius: 0.03, aftRadius: 0.02, thickness: 0.002, shape: 'conical' },
            ],
          },
        ],
      },
    };
    const xml = exportCdx1(d);
    expect(xml).toContain('<ShoulderLength>1.9685</ShoulderLength>'); // 0.05 m in inches
    const back = importCdx1(xml);
    const booster = back.tree.components[1]!;
    const trans = (booster.children ?? []).filter((c) => c.type === 'transition');
    expect(trans.length).toBe(2);
    expect(trans[0]!['length']).toBeCloseTo(0.05, 3);
    expect(trans[1]!['length']).toBeCloseTo(0.06, 3);
    expect(trans[1]!['aftRadius']).toBeCloseTo(0.02, 3);
  });

  it('rejects non-conical transitions', () => {
    const bad = structuredClone(design);
    const children = bad.tree.components[0]!.children! as ComponentNode[];
    children.push({
      type: 'transition', id: 't', length: 0.1, foreRadius: 0.0508, aftRadius: 0.03, shape: 'ogive',
    } as ComponentNode);
    expect(() => exportCdx1(bad)).toThrow(/conical/);
  });

  it('round-trips a double-wedge supersonic airfoil (AirfoilSection/LERadius/FX1)', () => {
    const d = structuredClone(design);
    const fin = d.tree.components[0]!.children![1]!.children![0] as ComponentNode;
    fin['airfoilSection'] = 'doublewedge';
    fin['finLeRadius'] = 0.002;
    fin['airfoilLeDiamond'] = 0.03;
    fin['airfoilTeDiamond'] = 0.08; // = (0.15 + 0.07)/2 − 0.03, RASAero-consistent
    const xml = exportCdx1(d);
    expect(xml).toContain('<AirfoilSection>Double Wedge</AirfoilSection>');
    expect(xml).toContain('<LERadius>0.0787</LERadius>'); // 0.002 m in inches
    expect(xml).toContain('<FX1>1.1811</FX1>'); // 0.03 m in inches
    expect(xml).toContain('<FX3>0</FX3>'); // derived for a double wedge, never written
    const back = importCdx1(xml);
    const fins = flatten(back.tree.components).find((c) => c.type === 'trapezoidfinset')!;
    expect(fins['airfoilSection']).toBe('doublewedge');
    expect(fins['finLeRadius']).toBeCloseTo(0.002, 5);
    expect(fins['airfoilLeDiamond']).toBeCloseTo(0.03, 5);
    expect(fins['airfoilTeDiamond']).toBeCloseTo(0.08, 5);
  });

  it('writes FX3 for a hexagonal airfoil and reads it back', () => {
    const d = structuredClone(design);
    const fin = d.tree.components[0]!.children![1]!.children![0] as ComponentNode;
    fin['airfoilSection'] = 'hexagonal';
    fin['airfoilLeDiamond'] = 0.03;
    fin['airfoilTeDiamond'] = 0.04;
    const xml = exportCdx1(d);
    expect(xml).toContain('<AirfoilSection>Hexagonal</AirfoilSection>');
    expect(xml).toContain('<FX3>1.5748</FX3>'); // 0.04 m in inches
    const back = importCdx1(xml);
    const fins = flatten(back.tree.components).find((c) => c.type === 'trapezoidfinset')!;
    expect(fins['airfoilSection']).toBe('hexagonal');
    expect(fins['airfoilTeDiamond']).toBeCloseTo(0.04, 5);
  });

  it('writes the launch panel into <LaunchSite> and round-trips it', () => {
    const launch = {
      launchAltitudeM: 3933 / 3.28084, temperatureC: 26.6667, pressureHPa: 850,
      launchRodAngleDeg: 5, launchRodLengthM: 3.6576, windAverage: 4.4704,
    };
    const xml = exportCdx1({ ...design, launch });
    expect(xml).toMatch(/<Altitude>3933(\.\d+)?<\/Altitude>/); // FEET
    expect(xml).toMatch(/<RodLength>12(\.\d+)?<\/RodLength>/); // FEET
    expect(xml).toMatch(/<Temperature>80(\.\d+)?<\/Temperature>/); // °F
    expect(xml).toMatch(/<WindSpeed>10(\.\d+)?<\/WindSpeed>/); // mph
    const back = importCdx1(xml);
    expect(back.launch!.launchAltitudeM).toBeCloseTo(3933 / 3.28084, 2);
    expect(back.launch!.pressureHPa).toBeCloseTo(850, 1);
    expect(back.launch!.launchRodAngleDeg).toBeCloseTo(5, 6);
    expect(back.launch!.launchRodLengthM).toBeCloseTo(3.6576, 4);
    expect(back.launch!.windAverage).toBeCloseTo(4.4704, 4);
  });

  it('defaults <LaunchSite> fields: null pressure→0, null temperature→59', () => {
    const xml = exportCdx1({ ...design, launch: { temperatureC: null, pressureHPa: null } });
    expect(xml).toContain('<Pressure>0</Pressure>'); // RASAero's own "unset"
    expect(xml).toContain('<Temperature>59</Temperature>'); // no unset in the format
    // No launch at all keeps the historical constants.
    const bare = exportCdx1(design);
    expect(bare).toContain('<Pressure>29.92</Pressure>');
    expect(bare).toContain('<Temperature>59</Temperature>');
    expect(bare).toContain('<RodLength>10</RodLength>');
  });

  it('preserves airfoil and launch site through ARCAS import→export→import', () => {
    const first = importCdx1(fixture('ARCAS-Long - 2.CDX1'));
    const xml = exportCdx1({ name: first.name, tree: first.tree, launch: first.launch });
    const back = importCdx1(xml);
    const fins = flatten(back.tree.components).find((c) => c.type === 'trapezoidfinset')!;
    expect(fins['airfoilSection']).toBe('doublewedge');
    expect(fins['airfoilLeDiamond']).toBeCloseTo(1.4863 / 39.37, 6);
    expect(fins['airfoilTeDiamond']).toBeCloseTo(0.0326695, 6);
    expect(back.launch!.launchAltitudeM).toBeCloseTo(first.launch!.launchAltitudeM!, 2);
    expect(back.launch!.temperatureC).toBeCloseTo(first.launch!.temperatureC!, 3);
    expect(back.launch!.launchRodLengthM).toBeCloseTo(first.launch!.launchRodLengthM!, 3);
    expect(back.launch!.pressureHPa).toBeNull(); // unset → explicit ISA, never absent
  });

  it('writes the Mach-Alt table back in feet — once each, not RASAero’s repeats', () => {
    const first = importCdx1(fixture('ARCAS-Long - 2.CDX1'));
    const xml = exportCdx1({ name: first.name, tree: first.tree, machAlt: first.machAlt });
    expect(xml).toContain('<Item>0.9, 25000</Item>');
    expect(xml).toContain('<Item>25, 122500</Item>');
    expect(xml.match(/<Item>/g)).toHaveLength(10); // the file had 60
    const back = importCdx1(xml);
    expect(back.machAlt).toEqual(first.machAlt);
  });

  it('writes the empty <MachAlt> element when the design has no table', () => {
    // RASAero's own "unset", and what every export did before the table existed.
    expect(exportCdx1(design)).toContain('<MachAlt></MachAlt>');
  });

  it('keeps top/middle-positioned fins in place instead of snapping them to the tube bottom', () => {
    const d = structuredClone(design);
    const fin = d.tree.components[0]!.children![1]!.children![0] as ComponentNode;
    fin['position'] = { method: 'top', offset: 0 }; // fins at the tube TOP
    const back = importCdx1(exportCdx1(d));
    const fins = flatten(back.tree.components).find((c) => c.type === 'trapezoidfinset')!;
    // Tube 1.0 m, root 0.15 m: bottom-referenced offset −0.85 puts the fin
    // front edge at the tube top (the old code exported offset 0 = bottom).
    expect(fins.position?.method).toBe('bottom');
    expect(fins.position?.offset).toBeCloseTo(-0.85, 6);
  });

  it('every bundled .CDX1 fixture builds in the kernel', async () => {
    // The regression this pins: a fin with TipChord 0 on a boat tail produced a
    // repeated tip point, which the kernel reads as a self-intersection and
    // reports via a Java %g format TeaVM does not implement — buildTree died
    // with "Unknown format conversion: g" and the design had no CG/CP/Simulate.
    // Import-only assertions were green throughout, so the build is the test.
    const { OrkRocket, resetEngine } = await import('@online-openrocket/engine');
    const { engineTree } = await import('../tree/treeModel.js');
    for (const name of ['Complex.Two-Stage.CDX1', 'Show-off.CDX1', 'Three-stage rocket.CDX1',
      'ARCAS-Long - 2.CDX1', 'RMA53D02 - 2.CDX1']) {
      resetEngine();
      const r = importCdx1(fixture(name));
      const info = OrkRocket.buildTree(engineTree(r.tree)).staticInfo();
      expect(Number.isFinite(info.mass), `${name}: mass`).toBe(true);
      expect(info.mass, `${name}: mass > 0`).toBeGreaterThan(0);
      expect(Number.isFinite(info.cp), `${name}: cp`).toBe(true);
    }
  }, 120000);

  /**
   * ACCEPTANCE for the protuberance component (§7.5e), measured end to end:
   * open Chuck Rogers' own "ARCAS-Long - 2.CDX1", lower it, and see what the
   * kernel's total CD actually does — against the same design with the
   * protuberance removed.
   *
   * RE-MEASURED 2026-08-25 after the streamlined classes became
   * body-CD-referenced (RASAero's Streamlined Protuberance Method, TRF 197641
   * #1 — see treeModel.protuberanceCd):
   *
   *   frontal area 0.178 in² of a 2.25 in body (3.976 in² reference)
   *     ⇒ area ratio 0.044768
   *   body CD at Mach 0.3, fins stripped: 0.311401 without base drag,
   *     0.354024 with it
   *   ⇒ ΔCD = 0.354024 × 0.044768 = +0.0158488, at every Mach, exactly the
   *     override.  (It was +0.0098489 under the retired flat Cd 0.22.)
   *
   * Against RASAero's OWN per-Mach version of the same method on this design —
   * area ratio × the body CD at each Mach, Re-matched to the file's Mach–Alt
   * table — the true curve runs +0.0092973 (M3.0) to +0.0206119 (M0.05), and
   * is +0.015808 at M0.3, +0.015857 at M0.6, +0.018063 at M1.0, +0.013111 at
   * M1.8. Our Mach-flat scalar sits INSIDE that band everywhere and is exact
   * at M0.3–0.6; the retired 0.0098489 sat below the entire band except above
   * M2.9. That is the whole gain, and the remaining error is the Mach-flatness
   * the scalar `overrideCD` hook forces.
   *
   * And the things that must NOT move: friction, pressure and base CD, mass,
   * CG, CP, the reference diameter and the aerodynamic length — a protuberance
   * is drag and nothing else, exactly as RASAero prints it.
   */
  it('ARCAS: the imported protuberance delivers its frontal-area drag and nothing else', async () => {
    const { OrkRocket, resetEngine } = await import('@online-openrocket/engine');
    const { bodyDragReference, engineTree, protuberanceDeliveredCd, protuberanceFrontalArea, referenceArea } =
      await import('../tree/treeModel.js');
    const r = importCdx1(fixture('ARCAS-Long - 2.CDX1'));
    const prot = flatten(r.tree.components).find((c) => (c.type as string) === 'protuberance')!;
    const expected = protuberanceDeliveredCd(r.tree, prot);
    expect(expected).toBeCloseTo(0.0158488, 7);
    // …and it IS the method, not a number: area ratio × this body's own CD.
    const body = bodyDragReference(r.tree);
    expect(body.measured).toBe(true);
    expect(body.noBase).toBeCloseTo(0.311401, 6);
    expect(body.withBase).toBeCloseTo(0.354024, 6);
    const ratio = protuberanceFrontalArea(prot) / referenceArea(r.tree);
    expect(ratio).toBeCloseTo(0.044768, 6);
    expect(expected).toBeCloseTo(ratio * body.withBase, 12);
    // The retired constant was 1.61× low on this design.
    expect(expected / (0.22 * ratio)).toBeCloseTo(1.6095, 3);

    const without = {
      ...r.tree,
      components: JSON.parse(JSON.stringify(r.tree.components)) as ComponentNode[],
    };
    const strip = (ns: ComponentNode[]): ComponentNode[] => ns
      .filter((n) => (n.type as string) !== 'protuberance')
      .map((n) => (n.children ? { ...n, children: strip(n.children) } : n));
    without.components = strip(without.components);

    // The file's own Mach-Alt table (its rows are the harness's arcas machAlt).
    const opts = {
      machMin: 0.05, machMax: 5, machStep: 0.025, aoaDeg: 0,
      machAlt: r.machAlt ?? undefined,
    };
    const run = (t: typeof r.tree) => {
      resetEngine();
      const rocket = OrkRocket.buildTree(engineTree(t));
      return { info: rocket.staticInfo(), sweep: rocket.dragSweep(opts) };
    };
    const a = run(r.tree);
    const b = run(without);

    // Drag: exactly the override, at every Mach on the grid.
    for (let i = 0; i < a.sweep.machs.length; i++) {
      expect(a.sweep.powerOff.total[i]! - b.sweep.powerOff.total[i]!).toBeCloseTo(expected, 9);
      // …and it is ALL override: the three computed buckets do not move.
      expect(a.sweep.powerOff.friction[i]!).toBeCloseTo(b.sweep.powerOff.friction[i]!, 12);
      expect(a.sweep.powerOff.pressure[i]!).toBeCloseTo(b.sweep.powerOff.pressure[i]!, 12);
      expect(a.sweep.powerOff.base[i]!).toBeCloseTo(b.sweep.powerOff.base[i]!, 12);
    }
    // Statics: untouched, to the last bit.
    expect(a.info.mass).toBe(b.info.mass);
    expect(a.info.cg).toBe(b.info.cg);
    expect(a.info.cp).toBe(b.info.cp);
    expect(a.info.cna).toBe(b.info.cna);
    expect(a.info.refDiameter).toBe(b.info.refDiameter);
    expect(a.info.lengthAerodynamic).toBe(b.info.lengthAerodynamic);
    expect(a.info.warningTexts).toEqual(b.info.warningTexts);
  }, 120000);

  it('resolves a transition fore radius from the part in front, not its own <Diameter>', () => {
    // .CDX1 stores <Diameter> as a duplicate of <RearDiameter> on a transition;
    // the real front diameter is implicit. Taking it literally made every
    // mid-body transition a cylinder and stepped the airframe.
    const r = importCdx1(fixture('Complex.Two-Stage.CDX1'));
    const parts = flatten(r.tree.components);
    const transitions = parts.filter((c) => c.type === 'transition' && c.name === 'Transition');
    expect(transitions.length).toBeGreaterThanOrEqual(2);
    // 3" tube -> 2.5" tube, then 2.5" -> 3": both are real tapers, not cylinders.
    for (const t of transitions) {
      expect(t['foreRadius']).not.toBeCloseTo(t['aftRadius'] as number, 9);
    }
  });

  it('writes an inline fin-can / boat-tail pod back out as <FinCan> and <BoatTail>', async () => {
    // The importer's two pods are invisible to the stage walk (nosecone |
    // bodytube | transition), so without this the export lost both parts
    // outright: Show-off went from 6 parts to 5, a silent round-trip loss
    // worse than the mis-stationed <BodyTube> it replaced. Desktop loses them
    // too — its RocketDesignDTO walks only the axial chain — so this goes
    // deliberately beyond desktop parity.
    //
    // Show-off, not Complex.Two-Stage: Complex's BOOSTER boat tail WIDENS
    // (6 → 6.5 in) and the booster writer refuses it for unrelated reasons,
    // which the "refuses a booster with extra transitions" test already pins.
    const { OrkRocket, resetEngine } = await import('@online-openrocket/engine');
    const { engineTree } = await import('../tree/treeModel.js');
    const first = importCdx1(fixture('Show-off.CDX1'));
    const xml = exportCdx1({ name: 'Show-off', tree: first.tree });

    const finCan = /<FinCan>[\s\S]*?<\/FinCan>/.exec(xml)![0];
    expect(finCan).toMatch(/<PartType>FinCan<\/PartType>/);
    expect(finCan).toMatch(/<Length>2\.34<\/Length>/);
    expect(finCan).toMatch(/<Diameter>2\.73<\/Diameter>/);
    expect(finCan).toMatch(/<InsideDiameter>1\.5<\/InsideDiameter>/);
    expect(finCan).toMatch(/<ShoulderLength>0\.23<\/ShoulderLength>/);
    // Location is the HOST tube's aft station and Offset is the can's front
    // measured back from it — the file's own convention, −<Length> when flush.
    expect(finCan).toMatch(/<Location>8<\/Location>/);
    expect(finCan).toMatch(/<Offset>-2\.34<\/Offset>/);
    expect(finCan).toMatch(/<Fin>/); // the fins came back with it

    const boatTail = /<BoatTail>[\s\S]*?<\/BoatTail>/.exec(xml)![0];
    expect(boatTail).toMatch(/<PartType>BoatTail<\/PartType>/);
    expect(boatTail).toMatch(/<Location>19<\/Location>/);
    expect(boatTail).toMatch(/<RearDiameter>0\.25<\/RearDiameter>/);

    // <Booster><Location> is the SHOULDER start, not the body start — 19 here,
    // the same station the recessed boat tail claims. We used to add the
    // shoulder length, which walked the booster one shoulder aft on every
    // export → import.
    const booster = /<Booster>[\s\S]*?<\/Booster>/.exec(xml)![0];
    expect(booster).toMatch(/<Location>19<\/Location>/);

    // …and the whole trip is length-neutral, which is the point.
    const back = importCdx1(xml);
    resetEngine();
    const a = OrkRocket.buildTree(engineTree(first.tree)).staticInfo();
    resetEngine();
    const b = OrkRocket.buildTree(engineTree(back.tree)).staticInfo();
    expect(b.length).toBeCloseTo(a.length, 6);
    expect(b.length * 39.37).toBeCloseTo(22, 6);
  }, 120000);
});

describe('RASAero engine export (gated — see CDX1_ENGINE_EXPORT)', () => {
  // Single-stage with the mount tube id 'b'; the AeroTech J350W is a motor
  // RASAero II's own database definitely ships (the hand-off test file in
  // docs/User files/ uses the same one).
  const design = {
    name: 'EngineOut',
    tree: {
      name: 'EngineOut',
      components: [
        {
          type: 'stage' as const, id: 's0', name: 'Sustainer',
          children: [
            { type: 'nosecone' as const, id: 'n', length: 0.3048, aftRadius: 0.0381, thickness: 0.002, shape: 'ogive' },
            {
              type: 'bodytube' as const, id: 'b', length: 0.9144, outerRadius: 0.0381, thickness: 0.001,
              children: [
                { type: 'trapezoidfinset' as const, id: 'f', finCount: 3, rootChord: 0.1524, tipChord: 0.0762, sweep: 0.0762, height: 0.0762, thickness: 0.0032, position: { method: 'bottom' as const, offset: 0 } },
                { type: 'parachute' as const, id: 'p', diameter: 0.9144, deployEvent: 'apogee' },
              ],
            },
          ],
        },
      ],
    },
    launchMassKg: 2.72,
    launchCgM: 0.762,
    motors: { b: { designation: 'J350W', manufacturer: 'AeroTech' } },
  };

  it('is ON by default — proven against real RASAero II 2026-08-25', () => {
    // docs/User files/rasaero-engine-export-test.CDX1 opened cleanly in
    // RASAero II ("Motor: J350W  (AT)", Loaded Wt. 5.9966 lb) — screenshot
    // alongside it. The constant stays the one-line revert if a tester ever
    // hits the NullReferenceException on a motor RASAero's database lacks.
    expect(CDX1_ENGINE_EXPORT).toBe(true);
    const xml = exportCdx1(design);
    expect(xml).toContain('<SustainerEngine>J350W  (AT)</SustainerEngine>');
    expect(xml).toContain('<IncludeBooster1>False</IncludeBooster1>');
  });

  it('still writes no engine string when the caller opts out', () => {
    const xml = exportCdx1({ ...design, engineExport: false });
    expect(xml).not.toContain('Engine>');
  });

  it('writes the desktop engine string (two spaces) directly before SustainerLaunchWt', () => {
    const xml = exportCdx1({ ...design, engineExport: true });
    // RASAeroCommonConstants.OPENROCKET_TO_RASAERO_MOTOR parity:
    // 'DESIGNATION  (ABBREV)', exactly two spaces.
    expect(xml).toContain('<SustainerEngine>J350W  (AT)</SustainerEngine>\n<SustainerLaunchWt>');
    // A motorless single-stage sim still claims no boosters.
    expect(xml).toContain('<IncludeBooster1>False</IncludeBooster1>');
    expect(xml).toContain('<IncludeBooster2>False</IncludeBooster2>');
  });

  it('round-trips the engine through our own importer as a flight configuration', () => {
    const back = importCdx1(exportCdx1({ ...design, engineExport: true }));
    expect(back.configs.length).toBe(1);
    const motors = Object.values(back.configs[0]!.motors);
    expect(motors.length).toBe(1);
    expect(motors[0]!.designation).toBe('J350W');
    expect(motors[0]!.manufacturer).toBe('AT');
    expect(motors[0]!.delay).toBe(Infinity); // RASAero is apogee-deploy: plugged
  });

  it('omits (never guesses) engines whose manufacturer RASAero does not document', () => {
    const xml = exportCdx1({
      ...design,
      motors: { b: { designation: 'D9', manufacturer: 'Klima' } },
      engineExport: true,
    });
    // A name RASAero's database lacks is the NRE — the whole reason for the gate.
    expect(xml).not.toContain('Engine>');
    expect(xml).toContain('<SustainerLaunchWt>'); // block still complete
  });

  it('maps manufacturers to RASAero abbreviations (desktop RASAeroCommonConstants parity)', () => {
    expect(rasaeroManufacturerAbbrev('AeroTech')).toBe('AT'); // thrustcurve abbrev
    expect(rasaeroManufacturerAbbrev('AeroTech-RMS')).toBe('AT'); // .eng variant
    expect(rasaeroManufacturerAbbrev('Cesaroni')).toBe('CTI');
    expect(rasaeroManufacturerAbbrev('Cesaroni Technology Inc.')).toBe('CTI'); // .ork full name
    expect(rasaeroManufacturerAbbrev('Estes')).toBe('ES');
    expect(rasaeroManufacturerAbbrev('Loki')).toBe('LR');
    expect(rasaeroManufacturerAbbrev('R.A.T.T. Works')).toBe('RTW'); // punctuation-normalized
    expect(rasaeroManufacturerAbbrev('Klima')).toBeNull(); // not in RASAero's set
    expect(rasaeroManufacturerAbbrev('EX')).toBeNull();
    expect(rasaeroManufacturerAbbrev(undefined)).toBeNull();
  });

  it('writes a booster engine with IncludeBooster1 True and round-trips both motors', () => {
    const twoStage = {
      name: 'TwoUp',
      tree: {
        components: [
          {
            type: 'stage' as const, id: 's0', name: 'Sustainer',
            children: [
              { type: 'nosecone' as const, id: 'n', length: 0.25, aftRadius: 0.0381, thickness: 0.002, shape: 'ogive' },
              { type: 'bodytube' as const, id: 'b0', length: 0.7, outerRadius: 0.0381, thickness: 0.001 },
            ],
          },
          {
            type: 'stage' as const, id: 's1', name: 'Booster',
            children: [
              {
                type: 'bodytube' as const, id: 'b1', length: 0.5, outerRadius: 0.0381, thickness: 0.001,
                children: [
                  { type: 'trapezoidfinset' as const, id: 'f1', finCount: 3, rootChord: 0.12, tipChord: 0.05, sweep: 0.05, height: 0.07, thickness: 0.003, position: { method: 'bottom' as const, offset: 0 } },
                ],
              },
            ],
          },
        ],
      },
      motors: {
        b0: { designation: 'J350W', manufacturer: 'AeroTech' },
        b1: { designation: 'K550W', manufacturer: 'AeroTech' },
      },
      engineExport: true,
    };
    const xml = exportCdx1(twoStage);
    expect(xml).toContain('<Booster1Engine>K550W  (AT)</Booster1Engine>\n<Booster1LaunchWt>');
    expect(xml).toContain('<IncludeBooster1>True</IncludeBooster1>');
    expect(xml).toContain('<IncludeBooster2>False</IncludeBooster2>');
    const back = importCdx1(xml);
    expect(back.configs.length).toBe(1);
    const designations = Object.values(back.configs[0]!.motors).map((m) => m.designation).sort();
    expect(designations).toEqual(['J350W', 'K550W']);
  });

  it('round-trips staged separation timers (Booster1SeparationDelay / Booster2Delay)', () => {
    // v0.071 made the ignition delays survive a .CDX1 round trip; the
    // separation timers were still hard-coded 0 on export, so a staged design
    // silently lost part of its staging every time it was written out.
    const mkStage = (id: string, name: string, delay: number) => ({
      type: 'stage' as const, id: `s_${id}`, name,
      separationEvent: 'burnout', separationDelay: delay,
      children: [
        {
          type: 'bodytube' as const, id, length: 0.5, outerRadius: 0.0381, thickness: 0.001,
          children: [
            { type: 'trapezoidfinset' as const, id: `f_${id}`, finCount: 3, rootChord: 0.12, tipChord: 0.05, sweep: 0.05, height: 0.07, thickness: 0.003, position: { method: 'bottom' as const, offset: 0 } },
          ],
        },
      ],
    });
    const xml = exportCdx1({
      ...design,
      tree: {
        ...design.tree,
        components: [...design.tree.components, mkStage('b1', 'Booster', 3), mkStage('b2', 'Booster 2', 1.5)],
      },
      motors: {
        ...design.motors,
        b1: { designation: 'K550W', manufacturer: 'AeroTech' },
        b2: { designation: 'L850W', manufacturer: 'AeroTech' },
      },
      engineExport: true,
    });
    expect(xml).toContain('<Booster1SeparationDelay>3</Booster1SeparationDelay>');
    expect(xml).toContain('<Booster2Delay>1.5</Booster2Delay>');
    // …and our own importer bakes them straight back onto the stage nodes.
    const back = importCdx1(xml);
    expect(back.tree.components[1]!['separationEvent']).toBe('burnout');
    expect(back.tree.components[1]!['separationDelay']).toBe(3);
    expect(back.tree.components[2]!['separationEvent']).toBe('burnout');
    expect(back.tree.components[2]!['separationDelay']).toBe(1.5);
  });

  it('writes 0 for a separation delay RASAero cannot express (non-burnout event)', () => {
    // The field means "seconds after this booster's burnout"; an
    // ejection-charge separation's delay counts from a different event, so it
    // stays at RASAero's own 0 — the same guard the ignition delays apply.
    const booster = {
      type: 'stage' as const, id: 's1', name: 'Booster',
      separationDelay: 3, // kernel-default ejection event, no separationEvent set
      children: [
        {
          type: 'bodytube' as const, id: 'b1', length: 0.5, outerRadius: 0.0381, thickness: 0.001,
          children: [
            { type: 'trapezoidfinset' as const, id: 'f1', finCount: 3, rootChord: 0.12, tipChord: 0.05, sweep: 0.05, height: 0.07, thickness: 0.003, position: { method: 'bottom' as const, offset: 0 } },
          ],
        },
      ],
    };
    const xml = exportCdx1({
      ...design,
      tree: { ...design.tree, components: [...design.tree.components, booster] },
      motors: { ...design.motors, b1: { designation: 'K550W', manufacturer: 'AeroTech' } },
      engineExport: true,
    });
    expect(xml).toContain('<Booster1SeparationDelay>0</Booster1SeparationDelay>');
  });

  it('puts the loaded mass/CG in the LAST stage cell, not the sustainer (cells are cumulative)', () => {
    // RASAero's per-stage cells are the vehicle from the nose down to that
    // stage: a RASAero-written two-stage file carries sustainer 4.06 lb / CG
    // 35.96 in against booster1 5.64 lb / CG 43.06 in
    // (__fixtures__/Complex.Two-Stage.CDX1). `design` supplies only the WHOLE
    // rocket's 2.72 kg / 0.762 m, which is Booster1's cell here and not the
    // sustainer's — the sustainer's own weight is unknown, and 0 is RASAero's
    // "not entered".
    const booster = {
      type: 'stage' as const, id: 's1', name: 'Booster',
      children: [
        {
          type: 'bodytube' as const, id: 'b1', length: 0.5, outerRadius: 0.0381, thickness: 0.001,
          children: [
            { type: 'trapezoidfinset' as const, id: 'f1', finCount: 3, rootChord: 0.12, tipChord: 0.05, sweep: 0.05, height: 0.07, thickness: 0.003, position: { method: 'bottom' as const, offset: 0 } },
          ],
        },
      ],
    };
    const xml = exportCdx1({
      ...design,
      tree: { ...design.tree, components: [...design.tree.components, booster] },
      motors: { ...design.motors, b1: { designation: 'K550W', manufacturer: 'AeroTech' } },
      engineExport: true,
    });
    expect(xml).toContain('<SustainerLaunchWt>0</SustainerLaunchWt>');
    expect(xml).toContain('<SustainerCG>0</SustainerCG>');
    expect(xml).not.toContain('<SustainerLaunchWt>5.9966</SustainerLaunchWt>');
    expect(xml).toContain('<Booster1LaunchWt>5.9966</Booster1LaunchWt>'); // 2.72 kg → lb
    expect(xml).toContain('<Booster1CG>29.9999</Booster1CG>'); // 0.762 m → in
    expect(xml).toContain('<Booster2LaunchWt>0</Booster2LaunchWt>'); // no third stage
    // The booster is still claimed, with its engine — unchanged behaviour.
    expect(xml).toContain('<Booster1Engine>K550W  (AT)</Booster1Engine>');
    expect(xml).toContain('<IncludeBooster1>True</IncludeBooster1>');
  });

  it('a three-stage design fills BOOSTER 2, the only cell that means the whole stack', () => {
    // The stack size where the old and the new cell choice differ most, and
    // the one no test observed: the two-stage case asserts Booster2 is 0,
    // which a resolver capped at Booster1 would also produce. Mutating
    // `lastStage` to Math.min(stagesIn.length - 1, 1) passes the whole file
    // without this.
    const mkStage = (id: string, name: string) => ({
      type: 'stage' as const, id: `s_${id}`, name,
      children: [
        {
          type: 'bodytube' as const, id, length: 0.5, outerRadius: 0.0381, thickness: 0.001,
          children: [
            { type: 'trapezoidfinset' as const, id: `f_${id}`, finCount: 3, rootChord: 0.12, tipChord: 0.05, sweep: 0.05, height: 0.07, thickness: 0.003, position: { method: 'bottom' as const, offset: 0 } },
          ],
        },
      ],
    });
    const xml = exportCdx1({
      ...design,
      tree: {
        ...design.tree,
        components: [...design.tree.components, mkStage('b1', 'Booster'), mkStage('b2', 'Booster 2')],
      },
      motors: {
        ...design.motors,
        b1: { designation: 'K550W', manufacturer: 'AeroTech' },
        b2: { designation: 'L850W', manufacturer: 'AeroTech' },
      },
      engineExport: true,
    });
    expect(xml).toContain('<SustainerLaunchWt>0</SustainerLaunchWt>');
    expect(xml).toContain('<Booster1LaunchWt>0</Booster1LaunchWt>');
    expect(xml).toContain('<Booster1CG>0</Booster1CG>');
    expect(xml).toContain('<Booster2LaunchWt>5.9966</Booster2LaunchWt>');
    expect(xml).toContain('<Booster2CG>29.9999</Booster2CG>');
    expect(xml).toContain('<IncludeBooster2>True</IncludeBooster2>');
  });

  it('keeps the single-stage sustainer cells (the RASAero-proven combination)', () => {
    const xml = exportCdx1({ ...design, engineExport: true });
    expect(xml).toContain('<SustainerLaunchWt>5.9966</SustainerLaunchWt>');
    expect(xml).toContain('<SustainerCG>29.9999</SustainerCG>');
    expect(xml).toContain('<Booster1LaunchWt>0</Booster1LaunchWt>');
    expect(xml).toContain('<Booster1CG>0</Booster1CG>');
  });
});

/**
 * A RASAero file's first <Simulation> is often a sustainer-only study, with
 * <IncludeBooster1>False</IncludeBooster1> or an engine string we cannot parse.
 * Opening it left the launch stage motorless: the rocket sat on the pad and the
 * kernel aborted with "no motors ignited", while a later simulation in the very
 * same file flew.
 */
describe('RASAero — which simulation gets opened', () => {
  /**
   * A real two-stage file from the beta corpus. Its FIRST <Simulation> carries
   * <IncludeBooster1>False</IncludeBooster1>, so the launch stage gets no motor
   * and the rocket cannot leave the pad — the kernel aborts with "no motors
   * ignited" and the user sees a two-point flight to 0 m. Later simulations in
   * the same file fly.
   */
  it('skips a first simulation that leaves the launch stage without a motor', () => {
    const r = importCdx1(fixture('launch-stage-motorless.CDX1'));
    // More than one configuration is declared, and the applied one is NOT the first.
    expect(r.configs.length).toBeGreaterThan(1);
    expect(r.chosenConfigId).not.toBe(r.configs[0]!.id);
    // A motor is on a mount inside the LAST stage — the one that has to light first.
    const stages = r.tree.components.filter((c) => c.type === 'stage');
    const bottomMounts = new Set<string>();
    const walk = (nodes: ComponentNode[]) => {
      for (const n of nodes) {
        if (n['motorMount'] === true && n.id) bottomMounts.add(n.id);
        walk(n.children ?? []);
      }
    };
    walk(stages[stages.length - 1]?.children ?? []);
    expect(Object.keys(r.motors).some((id) => bottomMounts.has(id))).toBe(true);
    // …and the note names both simulations by their number IN THE FILE.
    expect(r.notes.join(' ')).toMatch(/Simulation 1 in this file puts no motor on the launch stage/);
    expect(r.notes.join(' ')).toMatch(/Simulation \d+ was opened instead/);
  });

  it('never opens a silently unflyable configuration when every simulation excludes the booster', () => {
    // The silent variant of the case above: EVERY simulation carries
    // <IncludeBooster1>False</IncludeBooster1>, so no configuration motors the
    // tree's bottom stage at all. The sustainer used to be keyed 'burnout' —
    // waiting on a booster that never lights — so the kernel aborted "no
    // motors ignited" with no explanatory note anywhere.
    const xml = fixture('Complex.Two-Stage.CDX1')
      .replace(/<IncludeBooster1>True<\/IncludeBooster1>/g, '<IncludeBooster1>False</IncludeBooster1>');
    const r = importCdx1(xml);
    expect(r.configs.length).toBe(2);
    // Each configuration's lone motor (the sustainer's) ignites at LAUNCH.
    for (const cfg of r.configs) {
      const motors = Object.values(cfg.motors);
      expect(motors).toHaveLength(1);
      expect(motors[0]!.ignitionEvent).toBe('launch');
    }
    // …and the import says what happened and what to do about it.
    expect(r.notes.join(' ')).toMatch(/No simulation in this file puts a motor on Booster/);
    expect(r.notes.join(' ')).toMatch(/flies along unpowered/);
  });

  it('drops the slot ignition delay when a motor is rekeyed to launch', () => {
    // SustainerIgnitionDelay counts from the stage BELOW's burnout, and RASAero
    // ignores it in a sim that excludes that stage. Keeping it on the rekeyed
    // 'launch' motor made the delay launch-clock-relative instead: a
    // SustainerIgnitionDelay=8 file whose sims all set IncludeBooster1=False
    // imported as a rocket sitting on the pad for 8 s — a flight RASAero never
    // produces.
    const xml = fixture('Complex.Two-Stage.CDX1')
      .replace(/<IncludeBooster1>True<\/IncludeBooster1>/g, '<IncludeBooster1>False</IncludeBooster1>')
      .replace(/<SustainerIgnitionDelay>0<\/SustainerIgnitionDelay>/g, '<SustainerIgnitionDelay>8</SustainerIgnitionDelay>');
    const r = importCdx1(xml);
    for (const cfg of r.configs) {
      const m = Object.values(cfg.motors)[0]!;
      expect(m.ignitionEvent).toBe('launch');
      expect(m.ignitionDelay).toBe(0);
    }
  });

  it('leaves a file whose first simulation is flyable alone', () => {
    const r = importCdx1(fixture('Complex.Two-Stage.CDX1'));
    expect(r.chosenConfigId).toBe(r.configs[0]?.id ?? null);
    expect(r.notes.join(' ')).not.toMatch(/opened instead/);
  });
});

/**
 * The measured launch weight and CG (`<SustainerLaunchWt>` / `<SustainerCG>`
 * and the Booster1/Booster2 twins). These used to be read only to print a note
 * saying they were NOT applied, and the fabricated 2 mm-wall mass distribution
 * flew instead — 36 of the 39 corpus files carrying one imported at under HALF
 * their own stated loaded weight, which made them statically unstable
 * (docs/research/trf-file-corpus-2026-08-25.md §1). Every assertion below is on
 * a field that did not exist on these nodes before that fix.
 */
describe('RASAero import — measured launch weight and CG', () => {
  const LB = 2.20462262;
  const IN = 39.37;
  const lbToKg = (lb: number) => lb / LB;
  /** The catalog mass the app will actually load for a designation, in kg —
      sourced from the same `findDbMotor` the importer and App both call, so a
      motor-database refresh moves the expectation with the code. */
  const motorKg = async (designation: string): Promise<number> => {
    const { findDbMotor } = await import('./motorDb.js');
    return findDbMotor(designation)!.totalWeightG / 1000;
  };

  it('inverts RASAero’s CUMULATIVE stack weights on a RASAero-written two-stage file', async () => {
    // Complex.Two-Stage.CDX1, simulation 1: sustainer 4.06 lb / J90W,
    // booster1 5.64 lb / I170G. Booster1LaunchWt is the WHOLE STACK plus both
    // motors, so the booster's own mass needs the sustainer's 4.06 lb taken
    // out as well as its own motor — the inversion desktop's
    // applyBooster1MassOverride does and our exporter's comment describes.
    const r = importCdx1(fixture('Complex.Two-Stage.CDX1'));
    const [sustainer, booster] = r.tree.components as [ComponentNode, ComponentNode];
    const j90w = await motorKg('J90W');
    const i170g = await motorKg('I170G');

    expect(sustainer['overrideMass']).toBeCloseTo(lbToKg(4.06) - j90w, 9);
    expect(sustainer['overrideSubcomponentsMass']).toBe(true);
    expect(booster['overrideMass']).toBeCloseTo(lbToKg(5.64) - i170g - lbToKg(4.06), 9);
    expect(booster['overrideSubcomponentsMass']).toBe(true);
    // Reading the cell as the booster's OWN loaded weight would give this,
    // 5.6x too heavy — the failure the cumulative inversion exists to prevent.
    expect(booster['overrideMass']).not.toBeCloseTo(lbToKg(5.64) - i170g, 3);
    // The note carries the arithmetic in the file's own units.
    expect(r.notes.join(' ')).toMatch(/Applied from simulation 1.*4\.060 lb − J90W.*= 2\.180 lb/);
    expect(r.notes.join(' ')).toMatch(/5\.640 lb − I170G 1\.164 lb − 4\.060 lb above = 0\.416 lb/);
    // …and the note that used to say the opposite is gone.
    expect(r.notes.join(' ')).not.toMatch(/not applied to the stages/);
  });

  it('survives a round trip through our OWN exporter, which writes 0 above the last stage', async () => {
    // exportCdx1 can fill only the bottom stage's cumulative cells — it is
    // handed one loaded mass for the whole rocket — so it writes 0 into every
    // stage above, RASAero's own "not entered". Reading that 0 back as a real
    // stated weight subtracts nothing from the booster's cumulative cell and
    // drops the WHOLE stack's mass onto the booster alone, on top of the
    // sustainer's un-overridden fabricated mass: heavier every pass, CG wrong,
    // and a stable design flipped unstable. Desktop has the same hole; we
    // cannot, because we are the tool writing the 0.
    // Exactly the shape exportCdx1 emits for a two-stage design: the bottom
    // stage's cumulative cells filled, the sustainer's zeroed. Built by
    // zeroing one cell of a real RASAero file so nothing else varies.
    const ours = fixture('Complex.Two-Stage.CDX1')
      .replace(/<SustainerLaunchWt>[^<]*</, '<SustainerLaunchWt>0<');
    const stages = importCdx1(ours).tree.components as ComponentNode[];

    // Nothing above the bottom stage stated a weight, so nothing above it is
    // overridden — the honest outcome, not an invented one.
    expect(stages[0]?.['overrideMass']).toBeUndefined();
    // And the booster must NOT quietly absorb the whole stack. Before the
    // guard it took 5.64 lb − its own motor − 0, i.e. the sustainer's mass too.
    const i170g = await motorKg('I170G');
    expect(stages[1]?.['overrideMass'] ?? 0).not.toBeCloseTo(lbToKg(5.64) - i170g, 6);
    expect(stages[1]?.['overrideMass']).toBeUndefined();
  });

  it('takes the weights from the CHOSEN simulation, not the first one', () => {
    // launch-stage-motorless.CDX1's simulation 1 leaves the launch stage
    // unpowered, so the importer opens simulation 2 — and 2 states 3.5 lb
    // where 1 states 3. Desktop applies the FIRST simulation's numbers; we
    // deliberately differ, because the motor backed out of the weight has to
    // be the motor actually loaded, and that is the chosen configuration's.
    const r = importCdx1(fixture('launch-stage-motorless.CDX1'));
    expect(r.notes.join(' ')).toMatch(/Simulation 2 was opened instead/);
    const sustainer = r.tree.components[0]!;
    expect((sustainer['overrideMass'] as number) * LB).toBeCloseTo(3.5 - 2.725, 3);
    expect((sustainer['overrideMass'] as number) * LB).not.toBeCloseTo(3 - 2.725, 3);
    expect(r.notes.join(' ')).toMatch(/Applied from simulation 2/);
  });

  it('treats a LaunchWt of 0 as RASAero’s "not entered", and still uses the CG', () => {
    // ARCAS-Long - 2.CDX1: SustainerLaunchWt 0 with SustainerCG 37.42 and no
    // engine. Desktop skips the mass override on 0 and applies the CG
    // unchanged (no motor to back out) — so do we.
    const r = importCdx1(fixture('ARCAS-Long - 2.CDX1'));
    const sustainer = r.tree.components[0]!;
    expect(sustainer['overrideMass']).toBeUndefined();
    expect(sustainer['overrideSubcomponentsMass']).toBeUndefined();
    expect(sustainer['overrideCGX']).toBeCloseTo(37.42 / IN, 9);
    expect(sustainer['overrideSubcomponentsCG']).toBe(true);
    // With a stage still on its computed mass, the 2 mm-wall caveat stands.
    expect(r.notes.join(' ')).toMatch(/walls default to 2 mm; review masses/);
  });

  it('skips a booster whose LaunchWt is 0 even with IncludeBooster1 True', () => {
    // Show-off.CDX1 keeps IncludeBooster1 True over a 0 Booster1LaunchWt —
    // RASAero's own "not entered", not a real zero.
    const r = importCdx1(fixture('Show-off.CDX1'));
    for (const st of r.tree.components) {
      expect(st['overrideMass']).toBeUndefined();
      expect(st['overrideCGX']).toBeUndefined();
    }
    // And the sustainer's 1 lb is skipped for a different reason worth saying
    // out loud: Apogee's 1/4A2 is catalogued with no loaded weight, so it
    // cannot be backed out — and App cannot load it either.
    expect(r.notes.join(' ')).toMatch(/1\/4A2/);
    expect(r.notes.join(' ')).toMatch(/isn’t in the motor database with a loaded weight/);
  });

  it('never overrides with a mass the subtraction cannot produce', () => {
    // launch-stage-motorless.CDX1 simulation 2: Booster1LaunchWt 14 lb with an
    // M1350W (10.6 lb) on it and 3.5 lb of sustainer above — 14 − 10.6 − 3.5 =
    // −0.1 lb. Desktop would write a mass here; a negative one is exactly the
    // authoritative-looking wrong number the guards exist for.
    const r = importCdx1(fixture('launch-stage-motorless.CDX1'));
    const booster = r.tree.components[1]!;
    expect(booster['overrideMass']).toBeUndefined();
    expect(booster['overrideCGX']).toBeUndefined();
    expect(r.notes.join(' ')).toMatch(/NOT applied from the RASAero simulation/);
    expect(r.notes.join(' ')).toMatch(/leaves -0\.100 lb, which is not a mass/);
  });

  it('applies the booster CG once the airframe matches RASAero’s own', () => {
    // HISTORY, because this test used to assert the opposite. Complex.Two-Stage's
    // booster CG landed 6.06 in AHEAD of the booster's own front and was
    // skipped — not because the file disagreed with itself, but because OUR
    // airframe disagreed with RASAero's: we stacked the fin can behind its tube
    // and the boat tail above the booster, which pushed the booster stage 9 in
    // aft of where the file puts it. Both are inline pods now, the booster
    // starts at the 55 in its own <Location> states, and the back-transform
    // lands inside the stage. The skip line is gone with its cause.
    const r = importCdx1(fixture('Complex.Two-Stage.CDX1'));
    const booster = r.tree.components[1]!;
    expect(booster['overrideCGX']).toBeCloseTo(0.138803089, 9); // 5.465 in from the booster's own front
    expect(booster['overrideSubcomponentsCG']).toBe(true);
    expect(booster['overrideMass']).toBeDefined();
    expect(r.notes.join(' ')).toMatch(/CG 5\.46 in from its own front/);
    expect(r.notes.join(' ')).not.toMatch(/which is outside the stage/);
  });

  it('still refuses a back-transformed CG that lands outside the stage', () => {
    // The guard itself, on the same file with its booster CG moved 2 in aft.
    // The back-transform is a lever — 43.06 in lands 5.46 in into the booster,
    // 45.00 in lands 31.77 in into a 10.00 in stage — so a stated CG that
    // cannot be true is not a small error, and writing it anyway would be
    // exactly the authoritative-looking wrong number these guards exist for.
    const r = importCdx1(fixture('Complex.Two-Stage.CDX1')
      .replace('<Booster1CG>43.06</Booster1CG>', '<Booster1CG>45</Booster1CG>'));
    const booster = r.tree.components[1]!;
    expect(booster['overrideCGX']).toBeUndefined();
    expect(booster['overrideSubcomponentsCG']).toBeUndefined();
    expect(booster['overrideMass']).toBeDefined(); // mass is frame-independent
    expect(r.notes.join(' ')).toMatch(/stated CG 45\.00 in works out to .*which is outside the stage/);
  });

  it('applies nothing at all to a file with no <Simulation> block', () => {
    for (const name of ['Three-stage rocket.CDX1', 'RMA53D02 - 2.CDX1']) {
      const r = importCdx1(fixture(name));
      for (const st of r.tree.components) {
        expect(st['overrideMass'], name).toBeUndefined();
        expect(st['overrideCGX'], name).toBeUndefined();
      }
      expect(r.notes.join(' '), name).not.toMatch(/Applied from/);
    }
  });

  it('ACCEPTANCE: the kernel flies the file’s own loaded mass and CG', async () => {
    // End to end, in the real kernel: write a .CDX1 whose simulation states a
    // 4.5 kg rocket balancing at 0.85 m with a J90W in it, read it back, load
    // that motor — and the rocket the kernel builds must weigh and balance
    // exactly what the file said. That is the whole point of backing the motor
    // out of the cell: put it back and you get the author's numbers.
    const { OrkRocket, resetEngine } = await import('@online-openrocket/engine');
    const { engineTree } = await import('../tree/treeModel.js');
    const { findDbMotor } = await import('./motorDb.js');

    const single = {
      name: 'Weighed',
      tree: {
        name: 'Weighed',
        components: [{
          type: 'stage' as const, id: 's0', name: 'Sustainer',
          children: [
            { type: 'nosecone' as const, id: 'n', length: 0.3, aftRadius: 0.0508, thickness: 0.002, shape: 'ogive', shapeParameter: 1 },
            {
              type: 'bodytube' as const, id: 'b', length: 1.0, outerRadius: 0.0508, thickness: 0.001,
              children: [{
                type: 'trapezoidfinset' as const, id: 'f', finCount: 4, rootChord: 0.15, tipChord: 0.07,
                sweep: 0.05, height: 0.11, thickness: 0.004, position: { method: 'bottom' as const, offset: 0 },
              }],
            },
          ],
        }],
      },
      launchMassKg: 4.5,
      launchCgM: 0.85,
      motors: { b: { designation: 'J90W', manufacturer: 'AeroTech' } },
      engineExport: true,
    };
    const back = importCdx1(exportCdx1(single));
    const stage = back.tree.components[0]!;
    expect(stage['overrideMass']).toBeDefined();
    expect(stage['overrideCGX']).toBeDefined();

    const db = findDbMotor('J90W')!;
    // The MotorSpec fetchMotorSpec would build for this catalog entry: the
    // loaded mass is totalWeightG and the CG is the geometric middle.
    const spec = {
      designation: db.designation,
      diameter: db.diameter / 1000,
      length: db.length / 1000,
      times: [0, 1],
      thrusts: [90, 0],
      masses: [db.totalWeightG / 1000, (db.totalWeightG - db.propWeightG) / 1000],
      cgX: db.length / 2000,
      ejectionDelay: 0,
    };
    const mountId = Object.keys(back.motors)[0]!;
    resetEngine();
    const rocket = OrkRocket.buildTree(engineTree(back.tree));
    rocket.setMotorById(mountId, spec);
    const info = rocket.staticInfo();
    // 4 decimals is the .CDX1 cell's own precision (pounds and inches, fmt()).
    expect(info.mass).toBeCloseTo(4.5, 4);
    expect(info.cg).toBeCloseTo(0.85, 4);
    // …and the dry structure is the loaded rocket minus exactly that motor.
    expect(info.massEmpty).toBeCloseTo(4.5 - db.totalWeightG / 1000, 4);
  }, 120000);

  it('ACCEPTANCE: the kernel honours the stage overrides on a two-stage file', async () => {
    const { OrkRocket, resetEngine } = await import('@online-openrocket/engine');
    const { engineTree } = await import('../tree/treeModel.js');
    const r = importCdx1(fixture('Complex.Two-Stage.CDX1'));
    const sum = r.tree.components.reduce((a, st) => a + (st['overrideMass'] as number), 0);
    resetEngine();
    const info = OrkRocket.buildTree(engineTree(r.tree)).staticInfo();
    // Subcomponents-overriding stage masses: the whole airframe IS the sum,
    // with none of the 2 mm-wall mass surviving underneath.
    expect(info.massEmpty).toBeCloseTo(sum, 9);
    // For scale: 2.60 lb of airframe where the 2 mm walls made 1.12 lb.
    expect(info.massEmpty * LB).toBeCloseTo(2.5965, 3);
  }, 120000);
});
