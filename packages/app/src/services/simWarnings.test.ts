import { describe, expect, it } from 'vitest';
import { formatWarning, warningKeysCell, WARNING_LABEL } from './simWarnings.js';

describe('formatWarning', () => {
  it('maps a known key to its plain-language label (no detail when the message is bare)', () => {
    const f = formatWarning({
      key: 'NO_RECOVERY_DEVICE',
      message: '[Warning.NO_RECOVERY_DEVICE]',
      priority: 'HIGH',
    });
    expect(f.label).toBe('No recovery device — the rocket comes down ballistic');
    expect(f.detail).toBeNull();
    expect(f.high).toBe(true);
  });

  it('carries the message suffix (value + sources) as detail, tidied', () => {
    // Verbatim engine shape: DebugTranslator bracket, value, double-spaced
    // source list (Message.addSourcesToMessageText joins with ":  ").
    const f = formatWarning({
      key: 'HighSpeedDeployment',
      message: '[Warning.RECOVERY_HIGH_SPEED] (71.1 m/s):  "BoosterChute"',
      priority: 'HIGH',
    });
    expect(f.label).toBe('Recovery device opened at high speed — risk of a zippered tube or torn chute');
    expect(f.detail).toBe('(71.1 m/s): "BoosterChute"');
    expect(f.high).toBe(true);
  });

  it('non-HIGH priorities (and absent priority) are not styled as failures', () => {
    expect(formatWarning({ key: 'SUPERSONIC', message: '[Warning.SUPERSONIC]', priority: 'NORMAL' }).high).toBe(false);
    expect(formatWarning({ key: 'THICK_FIN', message: '[Warning.THICK_FIN]', priority: 'LOW' }).high).toBe(false);
    expect(formatWarning({ key: 'THICK_FIN', message: '[Warning.THICK_FIN]' }).high).toBe(false);
  });

  it('unknown key falls back to the raw message with the bracketed key stripped', () => {
    const f = formatWarning({
      key: 'SOME_FUTURE_WARNING',
      message: '[Warning.SOME_FUTURE_WARNING] the fins fell off:  "Fin set"',
      priority: 'NORMAL',
    });
    expect(f.label).toBe('the fins fell off: "Fin set"');
    expect(f.detail).toBeNull();
  });

  it('unknown key with nothing beyond the bracket shows the key itself (never blank)', () => {
    const f = formatWarning({ key: 'Other', message: '[Warning.MYSTERY]' });
    expect(f.label).toBe('Other');
  });

  it('unbracketed message on an unknown key passes through untouched', () => {
    const f = formatWarning({ key: 'Other', message: 'Plain kernel text' });
    expect(f.label).toBe('Plain kernel text');
  });

  it('labels every key the kernel can raise during a flight', () => {
    // The emission sites: OrkEngine.warningKey's typed subclasses +
    // BasicEventSimulationEngine/RK4SimulationStepper addWarning calls +
    // the Barrowman calculators the stepper folds in. Keys are l10n keys
    // (DIAMETER_DISCONTINUITY emits "DISCONTINUITY").
    const kernelKeys = [
      'LargeAOA', 'HighSpeedDeployment', 'EventAfterLanding', 'MissingMotor',
      'NO_RECOVERY_DEVICE', 'RECOVERY_LAUNCH_ROD', 'RECOVERY_HIGH_SPEED',
      'SEPARATION_ORDER', 'EARLY_SEPARATION', 'TUMBLE_UNDER_THRUST',
      'EMPTY_BRANCH', 'SUPERSONIC', 'DISCONTINUITY', 'OPEN_AIRFRAME_FORWARD',
      'AIRFRAME_GAP', 'AIRFRAME_OVERLAP', 'PODSET_FORWARD', 'PODSET_OVERLAP',
      'THICK_FIN', 'JAGGED_EDGED_FIN', 'ZERO_AREA_FIN', 'PARALLEL_FINS',
      'ZERO_VOLUME_BODY', 'TUBE_ISOLATED', 'TUBE_SEPARATION', 'TUBE_OVERLAP',
      'LISTENERS_AFFECTED', 'FILE_INVALID_PARAMETER', 'OBJ_ZERO_THICKNESS',
    ];
    for (const key of kernelKeys) {
      expect(WARNING_LABEL[key], `missing label for ${key}`).toBeTruthy();
    }
  });
});

describe('warningKeysCell', () => {
  it('joins keys for the run-table CSV; tolerates absent field (old stored runs)', () => {
    expect(warningKeysCell([
      { key: 'NO_RECOVERY_DEVICE', message: '[Warning.NO_RECOVERY_DEVICE]', priority: 'HIGH' },
      { key: 'LargeAOA', message: '[Warning.LargeAOA.str1]', priority: 'NORMAL' },
    ])).toBe('NO_RECOVERY_DEVICE; LargeAOA');
    expect(warningKeysCell(undefined)).toBe('');
    expect(warningKeysCell([])).toBe('');
  });
});
