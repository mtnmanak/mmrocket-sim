import { describe, expect, it } from 'vitest';
import { formatWarning, formatWarningText, warningKeysCell, WARNING_LABEL } from './simWarnings.js';
import { SAFETY } from './simReport.js';

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
    expect(f.label).toMatch(/^Recovery device opened faster than the simulator’s fixed 20 m\/s \(65\.6 ft\/s\)/);
    expect(f.detail).toBe('(71.1 m/s): "BoosterChute"');
    expect(f.high).toBe(true);
  });

  /**
   * THE KERNEL'S 20 m/s IS NOT THE APP'S VERDICT (audit 2026-09-22). The kernel
   * flags any opening above a fixed 20 m/s over the ground (65.6 ft/s, wind
   * included); the report's own opening check is airspeed against 70 ft/s. The
   * old label called every such opening a "risk of a zippered tube", so a
   * 20-21.3 m/s opening read "Safe deployment: yes" and that warning in one
   * report. The label now states the kernel's threshold and makes no verdict.
   */
  it('states the kernel’s own 20 m/s threshold and leaves the verdict to the report', () => {
    for (const key of ['HighSpeedDeployment', 'RECOVERY_HIGH_SPEED']) {
      const label = WARNING_LABEL[key]!;
      expect(label).toContain('20 m/s (65.6 ft/s)');
      expect(label).toContain('judged on airspeed');
      // The kernel's speed is appended as the detail, so the label ENDS on the
      // clause that speed belongs to: over the ground, wind included.
      expect(label).toMatch(/over the ground, wind included$/);
      expect(label).not.toMatch(/zipper|torn/);
    }
    expect(20 / 0.3048).toBeCloseTo(65.6, 1);
    // The gap the old wording fell into: the report's preferred limit sits above it.
    expect(SAFETY.maxDeploymentVelocity).toBeGreaterThan(20);
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

describe('formatWarningText (static warnings from staticInfo)', () => {
  it('turns the DebugTranslator token into the app\'s own label', () => {
    expect(formatWarningText('[Warning.DISCONTINUITY]:  "Nose cone", "Body tube"'))
      .toBe(`${WARNING_LABEL['DISCONTINUITY']} — : "Nose cone", "Body tube"`);
  });

  it('uses the label alone when the message carries nothing else', () => {
    expect(formatWarningText('[Warning.DISCONTINUITY]')).toBe(WARNING_LABEL['DISCONTINUITY']!);
  });

  it('falls back to the stripped text for a key it does not know', () => {
    expect(formatWarningText('[Warning.SOMETHING_NEW] the kernel said this'))
      .toBe('the kernel said this');
  });

  it('leaves an already-plain string alone', () => {
    expect(formatWarningText('Just a sentence.')).toBe('Just a sentence.');
  });

  /**
   * The app raises geometric warnings of its own — the rail check, and since
   * C5 the shroud-wake check (tree/mountAngle.ts). They arrive here as finished
   * English sentences with no DebugTranslator token, and must reach the Design
   * strip and the launch report byte for byte.
   *
   * The trap this pins is `stripBrackets`: it removes a LEADING bracketed token,
   * which is the whole point for a kernel message, but a user is free to name a
   * part "[cam]". A sentence that opened with a bare part name would lose it.
   * The wake sentence QUOTES the name for exactly this reason.
   */
  it('passes an app-side geometric sentence through untouched', () => {
    const wake = '"Camera shroud" at 0° sits 220 mm ahead of a fin of "Fins" — 11 times its '
      + 'own height upstream, 0° off that fin\'s line. The wake it sheds is not modelled. '
      + 'Clocking it between the fins removes the question.';
    expect(formatWarningText(wake)).toBe(wake);
    const bracketName = '"[cam]" at 0° sits 220 mm ahead of a fin of "Fins".';
    expect(formatWarningText(bracketName)).toBe(bracketName);
    // …and the hazard is real: the same name unquoted at the front IS eaten.
    expect(formatWarningText('[cam] at 0° sits 220 mm ahead of a fin.'))
      .toBe('at 0° sits 220 mm ahead of a fin.');
  });
});
