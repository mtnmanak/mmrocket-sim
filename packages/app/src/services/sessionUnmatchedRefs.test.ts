// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import type { RocketTree } from '@online-openrocket/engine';
import { DEFAULT_CONDITIONS } from '../components/LaunchPanel.js';
import { restoreUnmatchedRefs } from './configSync.js';
import type { OrkMotorRef } from './orkFile.js';
import { flushSession, loadSession, saveSessionDebounced } from './session.js';

/**
 * A CONFIGURATION-LESS IMPORT'S UNRESOLVED MOTORS SURVIVE A RELOAD (audit
 * 2026-09-22). A .rkt naming a motor the catalogue lacks opens with that
 * mount's reference held in App state alone — no flight configuration exists
 * to keep a copy — so any reload, the service worker's post-deploy one
 * included, lost it, and Save .ork then wrote the mount with no motor. The
 * session payload carries the working references now; this is the round trip
 * App makes: autosave, reload, restore.
 */

const tree: RocketTree = { name: 'Imported RockSim rocket', components: [] };
const plugged: OrkMotorRef = {
  designation: 'K1100T', manufacturer: 'AeroTech', diameter: 0.054, length: 0.4, delay: Infinity, digest: 'abc',
};

beforeEach(() => { localStorage.clear(); });

describe('the working unmatched references in the session', () => {
  it('come back after a reload, plugged delay and all, with no configuration to restore them from', () => {
    saveSessionDebounced({ tree, launch: DEFAULT_CONDITIONS, mountMotors: {}, savedConfigs: [], activeConfigId: null,
      unmatchedRefs: { mmt: plugged } });
    flushSession();
    const s = loadSession()!;
    const restored = restoreUnmatchedRefs(s.savedConfigs, s.activeConfigId, s.mountMotors ?? {}, s.unmatchedRefs);
    expect(restored).toEqual({ mmt: plugged });
    // JSON has no Infinity; the reader has to put it back, or the writers'
    // Number.isFinite test would see a string.
    expect(restored['mmt']!.delay).toBe(Infinity);
  });

  it('a session written before the field restores none from it', () => {
    saveSessionDebounced({ tree, launch: DEFAULT_CONDITIONS, mountMotors: {}, savedConfigs: [], activeConfigId: null });
    flushSession();
    const s = loadSession()!;
    expect(s.unmatchedRefs).toBeUndefined();
    expect(restoreUnmatchedRefs(s.savedConfigs, s.activeConfigId, s.mountMotors ?? {}, s.unmatchedRefs)).toEqual({});
  });
});
