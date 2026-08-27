import { describe, expect, it } from 'vitest';
import { aeroChoiceOf, effectiveAero, type AeroChoice, type Preferences } from './PrefsContext.js';
import { aeroModelLabel, currentModelLabel, runMatchesModel } from '../services/simReport.js';

/**
 * The aerodynamics model is now settable from two places — the vitals strip
 * (session only) and Preferences (durable). The owner's instruction was
 * explicit: "make sure you test all conditions for possible collisions where
 * the drop down says one thing and preferences says another."
 *
 * The load-bearing property is the FIRST describe block: with no override, the
 * derivation must be byte-for-byte what it was before the strip control
 * existed. Everything else is a new feature; that one is a promise to every
 * store already out there.
 */

const P = (over: Partial<Preferences> = {}): Preferences => ({
  units: {} as Preferences['units'],
  radiusMode: 'diameter',
  theme: 'dark',
  ...over,
});

describe('effectiveAero — with NO override, nothing changes', () => {
  it('an empty store is Rogers Kbf on the classic model, as it always was', () => {
    expect(effectiveAero(P(), null)).toEqual({ aeroMode: 'classic', effectiveKbf: true });
  });

  it('an explicit Kbf opt-out is preserved, not defaulted back on', () => {
    expect(effectiveAero(P({ rogersKbf: false }), null))
      .toEqual({ aeroMode: 'classic', effectiveKbf: false });
  });

  it('the pre-v0.026 boolean still means supersonic', () => {
    expect(effectiveAero(P({ supersonicAero: true }), null).aeroMode).toBe('supersonic');
    expect(aeroChoiceOf(P({ supersonicAero: true }))).toBe('supersonic');
  });

  it('the awkward migrated combination survives — supersonic WITH kbf off', () => {
    // PrefsContext.load() can leave exactly this behind. Collapsing the model
    // to one four-way choice and expanding it again would silently turn the
    // Kbf flag back on, changing what an existing user flies.
    const prefs = P({ aeroModel: 'supersonic', rogersKbf: false });
    expect(effectiveAero(prefs, null)).toEqual({ aeroMode: 'supersonic', effectiveKbf: false });
  });
});

describe('effectiveAero — with an override, the strip wins for the session', () => {
  const cases: [AeroChoice, { aeroMode: string; effectiveKbf: boolean }][] = [
    ['eb', { aeroMode: 'classic', effectiveKbf: false }],
    ['kbf', { aeroMode: 'classic', effectiveKbf: true }],
    ['auto', { aeroMode: 'auto', effectiveKbf: true }],
    ['supersonic', { aeroMode: 'supersonic', effectiveKbf: true }],
  ];
  for (const [choice, want] of cases) {
    it(`"${choice}" flies ${want.aeroMode}${want.effectiveKbf ? ' + Kbf' : ''}`, () => {
      // Over a preference set to the OPPOSITE of each half, so a term leaking
      // through from prefs would show up.
      expect(effectiveAero(P({ aeroModel: 'supersonic', rogersKbf: false }), choice))
        .toEqual(want);
    });
  }

  it('the override round-trips through aeroChoiceOf for every choice', () => {
    for (const [choice] of cases) {
      const eff = effectiveAero(P(), choice);
      const asPrefs = P({ aeroModel: eff.aeroMode, rogersKbf: eff.effectiveKbf });
      expect(aeroChoiceOf(asPrefs)).toBe(choice);
    }
  });
});

describe('aeroChoiceOf — what both selects display', () => {
  it('tells the two classic variants apart, which aeroMode alone cannot', () => {
    expect(aeroChoiceOf(P({ aeroModel: 'classic', rogersKbf: true }))).toBe('kbf');
    expect(aeroChoiceOf(P({ aeroModel: 'classic', rogersKbf: false }))).toBe('eb');
  });

  it('defaults to Kbf when the flag has never been written', () => {
    expect(aeroChoiceOf(P({ aeroModel: 'classic' }))).toBe('kbf');
  });
});

describe('runMatchesModel — marking a flight that was flown on another model', () => {
  const cur = (over: Partial<{ aeroMode: 'classic' | 'supersonic' | 'auto'; effectiveKbf: boolean; autoSupersonic: boolean }> = {}) =>
    ({ aeroMode: 'classic' as const, effectiveKbf: true, autoSupersonic: false, ...over });

  it('matches a classic + Kbf run against classic + Kbf', () => {
    expect(runMatchesModel({ aeroModel: 'classic', rogersKbf: true }, cur())).toBe(true);
  });

  it('catches the Kbf half, which aeroMode alone cannot see', () => {
    expect(runMatchesModel({ aeroModel: 'classic', rogersKbf: false }, cur())).toBe(false);
    expect(runMatchesModel({ aeroModel: 'classic', rogersKbf: true }, cur({ effectiveKbf: false })))
      .toBe(false);
  });

  it('catches a whole-model change in both directions', () => {
    expect(runMatchesModel({ aeroModel: 'supersonic' }, cur())).toBe(false);
    expect(runMatchesModel({ aeroModel: 'classic', rogersKbf: true },
      cur({ aeroMode: 'supersonic' }))).toBe(false);
  });

  it('auto has two faces, and which is in force depends on this session', () => {
    const auto = cur({ aeroMode: 'auto' });
    // Not yet upgraded: auto is flying classic, so a classic run matches.
    expect(runMatchesModel({ aeroModel: 'classic', rogersKbf: true }, auto)).toBe(true);
    expect(runMatchesModel({ aeroModel: 'auto-supersonic' }, auto)).toBe(false);
    // Upgraded on this design: now only an auto-supersonic run matches.
    const upgraded = cur({ aeroMode: 'auto', autoSupersonic: true });
    expect(runMatchesModel({ aeroModel: 'auto-supersonic' }, upgraded)).toBe(true);
    expect(runMatchesModel({ aeroModel: 'classic', rogersKbf: true }, upgraded)).toBe(false);
  });

  it('“supersonic” and “auto-supersonic” are the SAME physics, not a mismatch', () => {
    // The second only records that Auto chose the model rather than the user.
    // Calling them different put a "flown on a different model" banner on a
    // flight whose numbers are identical to a fresh one.
    expect(runMatchesModel({ aeroModel: 'auto-supersonic' }, cur({ aeroMode: 'supersonic' })))
      .toBe(true);
    expect(runMatchesModel({ aeroModel: 'supersonic' },
      cur({ aeroMode: 'auto', autoSupersonic: true }))).toBe(true);
  });

  it('UNKNOWN is not a mismatch — an old run must not be accused', () => {
    // aeroModel absent before v0.025; rogersKbf absent before v0.033. Flagging
    // those would put a warning on every historic run in the table.
    expect(runMatchesModel({}, cur())).toBeNull();
    expect(runMatchesModel({ aeroModel: 'classic' }, cur())).toBeNull();
    expect(runMatchesModel({ aeroModel: 'classic' }, cur({ aeroMode: 'auto' }))).toBeNull();
    // But a definite whole-model difference is still definite.
    expect(runMatchesModel({ aeroModel: 'classic' }, cur({ aeroMode: 'supersonic' }))).toBe(false);
  });
});

describe('the model labels the report and the banner share', () => {
  it('spells each stored model the same way everywhere', () => {
    expect(aeroModelLabel('supersonic')).toBe('Supersonic (our extended model)');
    expect(aeroModelLabel('auto-supersonic')).toBe('Supersonic (auto — flight exceeded Mach 0.9)');
    expect(aeroModelLabel('classic', true)).toBe('Classic (Extended Barrowman + Rogers Kbf)');
    expect(aeroModelLabel('classic', false)).toBe('Classic (Extended Barrowman)');
    expect(aeroModelLabel(undefined)).toBe('—');
  });

  it('names the CURRENT model, including auto’s two states', () => {
    expect(currentModelLabel({ aeroMode: 'classic', effectiveKbf: true, autoSupersonic: false }))
      .toBe('Classic (Extended Barrowman + Rogers Kbf)');
    expect(currentModelLabel({ aeroMode: 'auto', effectiveKbf: true, autoSupersonic: false }))
      .toBe('Auto (classic + Rogers Kbf until Mach 0.9)');
    expect(currentModelLabel({ aeroMode: 'auto', effectiveKbf: true, autoSupersonic: true }))
      .toBe('Supersonic (auto — flight exceeded Mach 0.9)');
  });
});
