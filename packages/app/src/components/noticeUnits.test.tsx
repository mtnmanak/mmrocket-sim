// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import { INITIAL_UNITS, IMPERIAL_UNITS } from '../prefs/units.js';
import { FinAlignmentJigMenu } from './FinAlignmentJigMenu.js';
import { MotorBrowser } from './MotorBrowser.js';
import { parseEng } from '../services/exMotors.js';
import { MeasuredMassBox } from './MeasuredMassBox.js';
import { MotorPadMass } from './MotorPadMass.js';
import { NozzleField } from './NozzleField.js';
import { MotorLengthField } from './MotorLengthField.js';
import { PreflightAudit } from './PreflightAudit.js';
import { StaticWarning } from './WarningCode.js';
import { LaunchPanel, DEFAULT_CONDITIONS } from './LaunchPanel.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => localStorage.clear());

it.each([INITIAL_UNITS, IMPERIAL_UNITS, { ...IMPERIAL_UNITS, length: 'ft' }])('pairs the jig ruler and orders stored EX refusals by preference (%j)', units => {
  localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ units }));
  const motor = parseEng('LEGACY 24 100 P 0.05 0.1 Home\n0 0\n0.5 40\n1 0')[0]!;
  localStorage.setItem('online-openrocket.ex-motors.v1', JSON.stringify([{ ...motor, totalWeightG: 100, propWeightG: 200 }]));
  const tube = { type: 'bodytube' as const, outerRadius: 0.025, length: 0.3 };
  const fin = { type: 'freeformfinset' as const, thickness: 0.002, finCount: 3, crossSection: 'airfoil', points: [[0, 0], [0.02, 0.02], [0.04, 0]] };
  const host = document.createElement('div'), root = createRoot(host);
  try {
    act(() => root.render(<PrefsProvider><FinAlignmentJigMenu tree={{ components: [tube] }} tube={tube} fin={fin} />
      <MotorBrowser mountDiameterMm={24} maxMotorLengthM={null} onSelect={() => {}} onClose={() => {}} /></PrefsProvider>));
    expect(host.textContent).toContain(units.length === 'mm' ? 'ruler: 50 mm (1.969 in)' : 'ruler: 2 in (50.8 mm)');
    expect(host.querySelector('.motor-import-notes')?.textContent).toContain(units.mass === 'g'
      ? 'more propellant (200 g [7.05 oz]) than loaded mass (100 g [3.53 oz])'
      : 'more propellant (7.05 oz [200 g]) than loaded mass (3.53 oz [100 g])');
  } finally { act(() => root.unmount()); host.remove(); }
});

it.each([
  [INITIAL_UNITS, '100 g (3.53 oz)', '25.4 mm (1 in)', '20 m/s (65.6 ft/s)', '10 m/s (32.808 ft/s)'],
  [IMPERIAL_UNITS, '3.53 oz (100 g)', '1 in (25.4 mm)', '65.6 ft/s (20 m/s)', '22.369 mph (10 m/s)'],
] as const)('U: physical notices on screen use both systems (%j)', async (units, mass, length, opening, wind) => {
  localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ units }));
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<PrefsProvider>
      <section data-test="measured"><MeasuredMassBox bareMassKg={0.1} bareCgM={0.1} rocketLengthM={1}
        hasAllowance={false} measured={{ massKg: 0.2, cgM: 0.15 }} onChange={() => {}} onApply={() => {}} onRemove={() => {}} /></section>
      <section data-test="pad"><MotorPadMass mountId="m" motorLabel="Test" mountName="Mount" multiMotor={false}
        valueKg={null} legacyPending={false} onChange={() => {}} computedPadMassKg={0.1} hardware={undefined}
        nameOfMount={id => id} describeIdentity={id => id} /></section>
      <section data-test="nozzle"><NozzleField stageName="Stage" exitDiameterM={null} motors={[]} motorLabel={null}
        clearedFor={{ previousLabel: 'Previous motor', previousM: 0.0254 }} onCommit={() => {}} onAutoFill={() => {}} /></section>
      <section data-test="room"><MotorLengthField mountName="Mount" value={null} onCommit={() => {}}
        room={{ lengthM: 0.0254, limitedBy: 'Bulkhead' }} /></section>
      <section data-test="audit"><PreflightAudit result={{ findings: [{ id: 'mass', kind: 'mass-ratio', tier: 'caution',
        part: { id: 'p', name: 'Part' }, reason: 'Check mass', mass: { overrideKg: 0.1, computedKg: 0.001 } }],
        uncheckedMassParts: [], unknownMaterialCount: 0 }} onSelectPart={() => {}} /></section>
      <section data-test="static"><StaticWarning text="[Warning.RECOVERY_HIGH_SPEED]" /></section>
      <section data-test="launch"><LaunchPanel value={{ ...DEFAULT_CONDITIONS, windAverage: 10 }} onChange={() => {}}
        onLaunch={() => {}} simulating={false} canLaunch /></section>
    </PrefsProvider>));
    for (const id of ['measured', 'pad', 'audit']) expect.soft(host.querySelector(`[data-test="${id}"]`)!.textContent).toContain(mass);
    for (const id of ['nozzle', 'room']) expect.soft(host.querySelector(`[data-test="${id}"]`)!.textContent).toContain(length);
    expect.soft(host.querySelector('[data-test="static"]')!.textContent).toContain(opening);
    expect.soft(host.querySelector('[data-test="launch"]')!.textContent).toContain(wind);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
