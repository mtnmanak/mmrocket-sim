import { afterEach, expect, it, vi } from 'vitest';
import { getCatalogue, isHighPower, motorLabel } from './motorDb.js';
import * as thrustcurve from './thrustcurve.js';
import { INITIAL_UNITS } from '../prefs/units.js';
import { loadMotorForMount } from './motorLoad.js';

afterEach(() => vi.restoreAllMocks());
it('loads through the Motors tab curve path with its complete metadata and cancellation', async () => {
  const motor = getCatalogue().find(m => thrustcurve.delayOptions(m).some(Number.isFinite))!;
  const delay = thrustcurve.defaultDelay(motor)!;
  const spec = { designation: motor.designation } as Awaited<ReturnType<typeof thrustcurve.fetchMotorSpec>>;
  const fetch = vi.spyOn(thrustcurve, 'fetchMotorSpec').mockResolvedValue(spec);
  const ctrl = new AbortController();
  const out = await loadMotorForMount(motor, delay, { units: INITIAL_UNITS, signal: ctrl.signal });
  expect(fetch).toHaveBeenCalledWith(motor, delay, ctrl.signal, { units: INITIAL_UNITS });
  expect(out).toEqual({ label: motorLabel(motor, delay), spec, meta: {
    label: motorLabel(motor, delay), manufacturer: motor.manufacturerAbbrev, motorId: motor.motorId,
    availableDelays: thrustcurve.delayOptions(motor), autoDelay: false, type: motor.type,
    propellant: motor.propInfo, motorCase: motor.caseInfo, highPower: isHighPower(motor),
  } });
  expect((await loadMotorForMount({ ...motor, motorId: 'ex:test' }, delay, { units: INITIAL_UNITS })).meta)
    .toMatchObject({ exMotorId: 'ex:test' });
  const auto = await loadMotorForMount(motor, delay, { units: INITIAL_UNITS, autoDelay: true });
  expect(auto.label).toBe(motorLabel(motor, delay, { autoDelay: true }));
  expect(auto.meta.autoDelay).toBe(true);
});
