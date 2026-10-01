// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentNode, MotorSpec, RocketTree } from '@online-openrocket/engine';
import type { MountMotor } from '../model/design.js';
import { addChild, defaultTree, motorMounts } from '../tree/treeModel.js';
import { DEFAULT_CONDITIONS } from '../components/LaunchPanel.js';
import { autosavedDesignFile } from './autosaveBackup.js';
import { importOrk } from './orkFile.js';
import { discardSession, saveSessionDebounced } from './session.js';

/**
 * The crash-recovery download (audit 2026-09-22): the autosaved design as a
 * file the user can open again — built from the stored session alone, because
 * the App that would normally save it is what failed.
 */

const KEY = 'online-openrocket.session.v1';

const c6 = (): MountMotor => ({
  label: 'C6-5',
  spec: {
    designation: 'C6', diameter: 0.018, length: 0.07, ejectionDelay: 5,
    thrust: [[0, 0], [0.2, 14], [1.8, 4], [1.9, 0]], masses: [0.024, 0.013], cgX: 0.035,
  } as unknown as MotorSpec,
  meta: { label: 'C6-5', manufacturer: 'Estes', type: 'SU' },
  ignition: { event: 'automatic', delay: 0 },
});

function storeDesign(tree: RocketTree, mountMotors: Record<string, MountMotor>) {
  saveSessionDebounced({ tree, mountMotors, launch: DEFAULT_CONDITIONS, measured: { massKg: 0.031, cgM: 0.2 } });
}

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
});
afterEach(() => {
  discardSession();
  vi.useRealTimers();
  localStorage.clear();
});

describe('autosavedDesignFile', () => {
  it('writes the autosave as an .ork that opens with its parts, motor, launch and measured figures', () => {
    const tree = { ...defaultTree(), name: 'Crashy Rocket' };
    const mount = motorMounts(tree)[0]!.id!;
    storeDesign(tree, { [mount]: c6() });
    vi.runAllTimers();

    const file = autosavedDesignFile()!;
    expect(file.ork).toBe(true);
    expect(file.name).toBe('Crashy_Rocket-autosave.ork');
    const back = importOrk(file.data);
    expect(back.name).toBe('Crashy Rocket');
    expect(JSON.stringify(back.tree.components.map((s) => s.children?.map((c) => c.type))))
      .toBe(JSON.stringify(tree.components.map((s) => s.children?.map((c) => c.type))));
    // The reader mints its own node ids; the motor is on the imported tree's mount.
    const backMount = motorMounts(back.tree)[0]!.id!;
    expect(back.motors[backMount]?.designation).toBe('C6');
    expect(back.motors[backMount]?.delay).toBe(5);
    expect(back.measured).toEqual({ massKg: 0.031, cgM: 0.2 });
    expect(back.launch?.latitudeDeg).toBe(DEFAULT_CONDITIONS.latitudeDeg);
  });

  it('includes the last edit still waiting in the debounce', () => {
    const tree = { ...defaultTree(), name: 'Before' };
    storeDesign(tree, {});
    vi.runAllTimers();
    storeDesign({ ...tree, name: 'After the last keystroke' }, {}); // not yet written
    expect(importOrk(autosavedDesignFile()!.data).name).toBe('After the last keystroke');
  });

  it('while another tab holds the slot, hands over THIS tab\'s held design, not the slot\'s', () => {
    storeDesign({ ...defaultTree(), name: 'Mine' }, {});
    vi.runAllTimers();
    // Another tab writes its own design into the slot…
    const other = JSON.parse(localStorage.getItem(KEY)!) as Record<string, unknown>;
    localStorage.setItem(KEY, JSON.stringify({ ...other, stamp: 'othertab', tree: { ...defaultTree(), name: 'Theirs' } }));
    // …so this tab's next write is held back (services/session.ts).
    storeDesign({ ...defaultTree(), name: 'Mine, edited' }, {});
    vi.runAllTimers();
    expect(importOrk(autosavedDesignFile()!.data).name).toBe('Mine, edited');
  });

  it('hands over the stored bytes as JSON when they cannot be read as a design', () => {
    localStorage.setItem(KEY, '{"tree": not json at all');
    const file = autosavedDesignFile()!;
    expect(file.ork).toBe(false);
    expect(file.name).toBe('rocket-autosave.json');
    expect(file.data).toBe('{"tree": not json at all');
  });

  it('is null when there is no autosave', () => {
    expect(autosavedDesignFile()).toBeNull();
  });

  /**
   * The references a file could not match are the SESSION's own working set
   * (SessionState.unmatchedRefs), which a design with no configurations —
   * a hand-rolled .ork keying <motor configid> with none declared — keeps
   * nowhere else. This read them off the active configuration alone, so such a
   * design's recovery file lost its motor (seam review of audit 2026-09-22).
   */
  it('carries the session’s own unmatched references on a design with no configurations', () => {
    const tree = { ...defaultTree(), name: 'Configless' };
    const mount = motorMounts(tree)[0]!.id!;
    saveSessionDebounced({
      tree, mountMotors: {}, launch: DEFAULT_CONDITIONS,
      unmatchedRefs: { [mount]: { designation: 'K1100T', manufacturer: 'AeroTech', diameter: 0.054, length: 0.4, delay: Infinity, mountId: mount } },
    });
    vi.runAllTimers();
    const back = importOrk(autosavedDesignFile()!.data);
    const backMount = motorMounts(back.tree)[0]!.id!;
    expect(back.motors[backMount]?.designation).toBe('K1100T');
    expect(back.motors[backMount]?.delay).toBe(Infinity);
  });

  /**
   * TWO MOUNTS IN THE SAME STAGE AND RANK (verifier's review of audit
   * 2026-09-30, item 23), one with a motor no catalogue has: which of them keeps
   * the weighed pad mass goes by the order a set comes in, and this file writes
   * each set in the order a Save does. The working set's loaded motor first, so
   * the value under its card is the one kept; a stored configuration's
   * references first, so the value the file put on the motor it could not load
   * is kept.
   */
  it('keeps each configuration’s pad mass where a Save keeps it, on two mounts of one stage', () => {
    const base = defaultTree();
    const body = base.components[0]!.children!.find((n) => n.type === 'bodytube')!;
    const tree = addChild(base, body.id!, {
      type: 'innertube', id: 'mmt-b', name: 'Second MMT', motorMount: true,
      length: 0.07, outerRadius: 0.0095, thickness: 0.0003,
    } as ComponentNode);
    const starter = motorMounts(tree).find((m) => m.id !== 'mmt-b')!.id!;
    const zq = { designation: 'ZQ9999X', manufacturer: 'AeroTech', diameter: 0.018, length: 0.07, delay: 6 };
    const working = { 'mmt-b': { ...c6(), padMassKg: 0.42 } };
    saveSessionDebounced({
      tree, mountMotors: working, launch: DEFAULT_CONDITIONS, activeConfigId: 'W', unmatchedRefs: { [starter]: zq },
      savedConfigs: [
        { id: 'W', name: null, isDefault: true, motors: working, unmatchedRefs: { [starter]: zq } },
        {
          id: 'X', name: 'Other', isDefault: false, motors: { 'mmt-b': c6() },
          unmatchedRefs: { [starter]: { ...zq, padMassKg: 0.5 } },
        },
      ],
    });
    vi.runAllTimers();
    const back = importOrk(autosavedDesignFile()!.data);
    expect(Object.fromEntries(back.configs.map((c) => [c.id, c.padMassKg]))).toEqual({ W: 0.42, X: 0.5 });
  });

  /**
   * AN AUTO MOUNT AT THE DELAY IT FLEW (audit 2026-09-30, item 23). A Save
   * writes an Auto mount at the rounded optimum its newest qualifying flight
   * flew; this file wrote the provisional delay, so the design reopened flying
   * a delay Auto never flew. The runs that say are judged against the build
   * and the model, which a crash leaves nothing of, so App keeps what a Save
   * would write beside the design (SessionState.flownAutoDelays).
   */
  describe('an Auto mount', () => {
    const auto = (): MountMotor => ({ ...c6(), label: 'C6 (auto delay)', meta: { ...c6().meta, autoDelay: true } });

    it('is written at the delay it flew, as a Save would write it', () => {
      const tree = { ...defaultTree(), name: 'Auto' };
      const mount = motorMounts(tree)[0]!.id!;
      saveSessionDebounced({
        tree, mountMotors: { [mount]: auto() }, launch: DEFAULT_CONDITIONS, flownAutoDelays: { '': { [mount]: 7 } },
      });
      vi.runAllTimers();
      const back = importOrk(autosavedDesignFile()!.data);
      expect(back.motors[motorMounts(back.tree)[0]!.id!]?.delay).toBe(7);
    });

    it('in each stored configuration, at the delay that configuration flew', () => {
      const tree = { ...defaultTree(), name: 'Two configurations' };
      const mount = motorMounts(tree)[0]!.id!;
      saveSessionDebounced({
        tree, mountMotors: { [mount]: auto() }, launch: DEFAULT_CONDITIONS, activeConfigId: 'A',
        savedConfigs: [
          { id: 'A', name: null, isDefault: true, motors: { [mount]: auto() } },
          { id: 'B', name: 'Windy', isDefault: false, motors: { [mount]: auto() } },
        ],
        flownAutoDelays: { A: { [mount]: 7 }, B: { [mount]: 8 } },
      });
      vi.runAllTimers();
      const back = importOrk(autosavedDesignFile()!.data);
      const backMount = motorMounts(back.tree)[0]!.id!;
      const delayIn = (id: string) => back.configs.find((c) => c.id === id)?.motors[backMount]?.delay;
      expect([delayIn('A'), delayIn('B')]).toEqual([7, 8]);
    });

    it('keeps its provisional delay, and the file is still an .ork, when what is stored is not a table of delays', () => {
      const tree = { ...defaultTree(), name: 'Garbled' };
      const mount = motorMounts(tree)[0]!.id!;
      storeDesign(tree, { [mount]: auto() });
      vi.runAllTimers();
      const stored = JSON.parse(localStorage.getItem(KEY)!) as Record<string, unknown>;
      for (const garbled of [
        null, 7, { '': null }, { '': [7] }, { '': { [mount]: '7' } }, { '': { [mount]: -1 } },
        // One run flew all of a configuration's mounts: a table with a bad
        // entry is not that run's, so none of it is taken.
        { '': { [mount]: 7, another: 'x' } },
      ]) {
        localStorage.setItem(KEY, JSON.stringify({ ...stored, flownAutoDelays: garbled }));
        const file = autosavedDesignFile()!;
        expect(file.ork, JSON.stringify(garbled)).toBe(true);
        const back = importOrk(file.data);
        expect(back.motors[motorMounts(back.tree)[0]!.id!]?.delay, JSON.stringify(garbled)).toBe(5);
      }
    });
  });
});
