import { describe, expect, it } from 'vitest';
import type { RocketTree } from '@online-openrocket/engine';
import { designFingerprint, isDirty, type DesignSnapshot } from './dirtyState.js';

const tree = (name = 'My Rocket'): RocketTree => ({
  name,
  components: [{
    type: 'stage', id: 's', children: [
      { type: 'nosecone', id: 'nc', length: 0.1, aftRadius: 0.012, shape: 'ogive' },
      { type: 'bodytube', id: 'bt', length: 0.3, outerRadius: 0.012, thickness: 0.0005 },
    ],
  }],
} as unknown as RocketTree);

const base = (): DesignSnapshot => ({
  tree: tree(),
  mountMotors: {},
  launch: { windAvg: 3, timeStepS: 0.01 } as unknown as DesignSnapshot['launch'],
  maxMotorLengthByStage: {},
  savedConfigs: [],
  activeConfigId: null,
  measured: { massKg: null, cgM: null },
});

describe('designFingerprint', () => {
  it('is the same for an identical snapshot', () => {
    expect(designFingerprint(base())).toBe(designFingerprint(base()));
  });

  it('changes when ONLY the rocket name changes', () => {
    const b = base();
    const renamed = { ...b, tree: tree('Big Rocket') };
    expect(designFingerprint(renamed)).not.toBe(designFingerprint(b));
  });

  it('changes when ONLY a launch condition changes', () => {
    const b = base();
    const windy = { ...b, launch: { ...b.launch, windAvg: 9 } };
    expect(designFingerprint(windy)).not.toBe(designFingerprint(b));
  });

  it('changes when ONLY a motor changes', () => {
    const b = base();
    const motored = {
      ...b,
      mountMotors: { bt: { label: 'C6-5' } as unknown as DesignSnapshot['mountMotors'][string] },
    };
    expect(designFingerprint(motored)).not.toBe(designFingerprint(b));
  });

  it('changes when ONLY the measured mass changes', () => {
    const b = base();
    const weighed = { ...b, measured: { massKg: 0.051, cgM: null } };
    expect(designFingerprint(weighed)).not.toBe(designFingerprint(b));
  });

  it('changes when ONLY a per-stage motor length limit changes', () => {
    const b = base();
    const limited = { ...b, maxMotorLengthByStage: { s: 0.3 } };
    expect(designFingerprint(limited)).not.toBe(designFingerprint(b));
  });

  it('does NOT change when Record keys arrive in a different order', () => {
    // This is the test that pins the sort in `stable()`. An import builds
    // mountMotors in file order and editing builds it in click order; without
    // the sort the same design fingerprints two ways and the prompt fires on a
    // file the user has only just saved. Delete the sort and this is the ONLY
    // assertion in the file that fails — every other one still passes.
    const m1 = { a: { label: 'C6-5' }, b: { label: 'D12-3' } };
    const m2: typeof m1 = {} as typeof m1;
    (m2 as Record<string, unknown>)['b'] = { label: 'D12-3' };
    (m2 as Record<string, unknown>)['a'] = { label: 'C6-5' };
    expect(Object.keys(m1).join()).not.toBe(Object.keys(m2).join()); // the premise
    const s1 = { ...base(), mountMotors: m1 as unknown as DesignSnapshot['mountMotors'] };
    const s2 = { ...base(), mountMotors: m2 as unknown as DesignSnapshot['mountMotors'] };
    expect(designFingerprint(s1)).toBe(designFingerprint(s2));
  });

  it('tells a plugged motor from an absent delay', () => {
    // A plugged motor carries ejectionDelay = Infinity, which plain JSON turns
    // into null — the same text an absent delay produces. Without the Infinity
    // mapping, plugging a motor would not register as a change at all.
    const plugged = {
      ...base(),
      mountMotors: { bt: { ejectionDelay: Infinity } as unknown as DesignSnapshot['mountMotors'][string] },
    };
    const absent = {
      ...base(),
      mountMotors: { bt: { ejectionDelay: null } as unknown as DesignSnapshot['mountMotors'][string] },
    };
    expect(designFingerprint(plugged)).not.toBe(designFingerprint(absent));
  });
});

describe('isDirty', () => {
  it('is clean when the mark matches and nothing has flown', () => {
    expect(isDirty('abc', 'abc', false)).toBe(false);
  });

  it('is dirty when the design has moved on from the mark', () => {
    expect(isDirty('abc', 'xyz', false)).toBe(true);
  });

  it('is dirty after a flight even though the design is unchanged', () => {
    // The owner asked for this explicitly: "detect if the user made any changes
    // (including flying a sim)". A flight does not touch the tree, so the
    // fingerprint alone can never see it.
    expect(isDirty('abc', 'abc', true)).toBe(true);
  });

  it('treats an unknown mark as dirty rather than as saved', () => {
    // A session written by a build before this field existed cannot prove it
    // was saved. "I do not know" must ask, not discard.
    expect(isDirty('abc', null, false)).toBe(true);
    expect(isDirty('abc', undefined, false)).toBe(true);
    expect(isDirty('abc', '', false)).toBe(true);
  });
});
