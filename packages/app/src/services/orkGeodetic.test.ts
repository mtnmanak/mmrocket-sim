// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import type { RocketTree } from '@online-openrocket/engine';
import { exportOrk, importOrk, ORK_CREATOR } from './orkFile.js';
import { importedLaunch } from './importApply.js';
import { decodeShareFragment, encodeShareFragment } from './shareLink.js';
import { DEFAULT_CONDITIONS, kernelSimOptions, type LaunchConditions } from './launchConditions.js';

/**
 * THE GEODETIC MODEL IN A .ork (board Tier 1 row 2, GS1; format audit
 * 2026-09-03, conditions/geodeticmethod). The reader read the element only to
 * say it was ignored, the writer wrote a constant 'spherical', and the kernel
 * was forced to a spherical Earth — so a desktop file flying FLAT gained a
 * Coriolis term here, and one flying WGS84 lost its ellipsoid. Now the file's
 * own model is flown and saved.
 *
 * Two "absent"s, kept apart. In a DESKTOP file's <conditions>, absent is FLAT:
 * desktop's loader pre-sets it (SimulationConditionsHandler, "default loading
 * settings (which may differ from the new defaults)"), and this reader writes
 * that rule. In anything THIS APP wrote — a session, a save, a share link —
 * absent is SPHERICAL, the only Earth any earlier build flew: the session's rule
 * is `flownGeodeticMethod`'s (session.test.ts), and a file of ours reaches it
 * through its creator stamp, because every export since v0.046 states a method.
 */

const TREE: RocketTree = {
  name: 'Geo',
  components: [{
    type: 'stage', name: 'Sustainer',
    children: [
      { type: 'nosecone', length: 0.07, aftRadius: 0.012, thickness: 0.002 },
      { type: 'bodytube', length: 0.3, outerRadius: 0.012, thickness: 0.0005 },
    ],
  }],
};

/** One simulation, as desktop 24.12 saves it, with `method` as its <geodeticmethod> — or none when undefined. */
const file = (method: string | undefined, creator = 'OpenRocket 24.12') => `<openrocket version="1.10" creator="${creator}"><rocket>
  <name>Geo</name><subcomponents><stage><name>S</name><subcomponents>
    <nosecone><name>N</name><length>0.07</length><thickness>0.002</thickness><shape>ogive</shape><aftradius>0.012</aftradius></nosecone>
  </subcomponents></stage></subcomponents></rocket>
  <simulations><simulation status="notsimulated"><name>Simulation 1</name>
    <simulator>RK4Simulator</simulator><calculator>BarrowmanCalculator</calculator>
    <conditions>
      <launchrodlength>1.0</launchrodlength>
      <launchlatitude>28.61</launchlatitude>
      ${method === undefined ? '' : `<geodeticmethod>${method}</geodeticmethod>`}
      <timestep>0.05</timestep>
    </conditions>
  </simulation></simulations></openrocket>`;

const geodeticNotes = (notes: string[]) => notes.filter((n) => n.includes('geodetic'));
const opened = (xml: string) => importedLaunch(DEFAULT_CONDITIONS, importOrk(xml).launch);

describe('.ork geodetic model — reading', () => {
  it('flies each of desktop’s three as the file states it, with nothing to say', () => {
    for (const m of ['flat', 'spherical', 'wgs84'] as const) {
      const r = importOrk(file(m));
      expect(r.launch?.geodeticMethod, m).toBe(m);
      expect(geodeticNotes(r.notes), m).toEqual([]);
    }
    expect(kernelSimOptions(opened(file('flat'))).geodeticMethod).toBe('flat');
    expect(kernelSimOptions(opened(file('wgs84'))).geodeticMethod).toBe('wgs84');
    expect(kernelSimOptions(opened(file('spherical')))).not.toHaveProperty('geodeticMethod');
  });

  it('reads a stated model trimmed and in any case — "Spherical" in a file means spherical', () => {
    expect(importOrk(file(' Spherical ')).launch?.geodeticMethod).toBe('spherical');
    expect(importOrk(file('WGS84')).launch?.geodeticMethod).toBe('wgs84');
    expect(importOrk(file('FLAT')).launch?.geodeticMethod).toBe('flat');
  });

  it('opens a desktop file that names no model on Flat Earth, as desktop does, and says so', () => {
    const r = importOrk(file(undefined));
    expect(r.launch?.geodeticMethod).toBe('flat');
    expect(kernelSimOptions(importedLaunch(DEFAULT_CONDITIONS, r.launch)).geodeticMethod).toBe('flat');
    const notes = geodeticNotes(r.notes);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('names no geodetic model, so it opens on Flat Earth');
    expect(notes[0]).toContain('desktop OpenRocket');
    expect(notes[0]).toContain('Coriolis');
    expect(notes[0]).toContain('choose Spherical Earth under Geodetic calculations in the Launch panel');
  });

  it('opens a file this app wrote that has lost its model on Spherical Earth, silently', () => {
    // Every export since v0.046 states one, so this is a hand-edited save or
    // share link — and the only Earth any build of ours flew before is the sphere.
    const r = importOrk(file(undefined, ORK_CREATOR));
    expect(r.launch?.geodeticMethod).toBe('spherical');
    expect(geodeticNotes(r.notes)).toEqual([]);
  });

  it('names a model it cannot read, and opens it the way a missing one opens', () => {
    const desktop = importOrk(file('ellipsoid'));
    expect(desktop.launch?.geodeticMethod).toBe('flat');
    expect(geodeticNotes(desktop.notes)).toHaveLength(1);
    expect(geodeticNotes(desktop.notes)[0]).toContain('names the geodetic model “ellipsoid”');
    expect(geodeticNotes(desktop.notes)[0]).toContain('opens on Flat Earth, as desktop OpenRocket opens it');
    const ours = importOrk(file('ellipsoid', ORK_CREATOR));
    expect(ours.launch?.geodeticMethod).toBe('spherical');
    expect(geodeticNotes(ours.notes)[0]).toContain('opens on Spherical Earth;');
  });

  it('never lets a file inherit the previous design’s model', () => {
    const prev: LaunchConditions = { ...DEFAULT_CONDITIONS, geodeticMethod: 'wgs84' };
    // A .ork with conditions always states one (above)…
    expect(importedLaunch(prev, importOrk(file(undefined)).launch).geodeticMethod).toBe('flat');
    expect(importedLaunch(prev, importOrk(file('spherical')).launch).geodeticMethod).toBe('spherical');
    // …and a file with none — a .ork with no simulation, a .rkt, a .CDX1 —
    // opens on the default Spherical Earth, as the time step goes back to its own.
    const noSim = exportOrk({ name: 'Geo', tree: TREE });
    expect(importOrk(noSim).launch).toBeUndefined();
    expect(importedLaunch(prev, importOrk(noSim).launch)).not.toHaveProperty('geodeticMethod');
    expect(importedLaunch(prev, { launchRodLengthM: 2 })).not.toHaveProperty('geodeticMethod');
    expect(kernelSimOptions(importedLaunch(prev, undefined))).not.toHaveProperty('geodeticMethod');
  });
});

describe('.ork geodetic model — writing', () => {
  const save = (launch: LaunchConditions) => exportOrk({ name: 'Geo', tree: TREE, launch });
  const line = (xml: string) => xml.match(/<geodeticmethod>[^<]*<\/geodeticmethod>/g);

  it('writes the model the flight flies, in desktop’s spelling', () => {
    expect(line(save({ ...DEFAULT_CONDITIONS, geodeticMethod: 'flat' }))).toEqual(['<geodeticmethod>flat</geodeticmethod>']);
    expect(line(save({ ...DEFAULT_CONDITIONS, geodeticMethod: 'wgs84' }))).toEqual(['<geodeticmethod>wgs84</geodeticmethod>']);
    // A design left on Spherical Earth — named, absent, or a stored value that
    // is not a method — writes the line every export carried before the setting.
    for (const m of ['spherical', undefined, 'Flat']) {
      const geodeticMethod = m as LaunchConditions['geodeticMethod'];
      expect(line(save({ ...DEFAULT_CONDITIONS, geodeticMethod })), String(m))
        .toEqual(['<geodeticmethod>spherical</geodeticmethod>']);
    }
  });

  it('round-trips each model through a save and a share link', async () => {
    for (const m of ['flat', 'spherical', 'wgs84'] as const) {
      const xml = save({ ...DEFAULT_CONDITIONS, geodeticMethod: m });
      expect(importOrk(xml).launch?.geodeticMethod, `save ${m}`).toBe(m);
      const link = await decodeShareFragment(await encodeShareFragment(xml));
      expect(importOrk(link).launch?.geodeticMethod, `link ${m}`).toBe(m);
      expect(geodeticNotes(importOrk(link).notes), m).toEqual([]);
    }
  });

  it('opens a share link made before the setting on the Spherical Earth it flew', async () => {
    // Before the setting the design had no key, and the writer stated spherical.
    const old = await encodeShareFragment(save(DEFAULT_CONDITIONS));
    const launch = importedLaunch(DEFAULT_CONDITIONS, importOrk(await decodeShareFragment(old)).launch);
    expect(launch.geodeticMethod).toBe('spherical');
    expect(kernelSimOptions(launch)).not.toHaveProperty('geodeticMethod');
  });
});
