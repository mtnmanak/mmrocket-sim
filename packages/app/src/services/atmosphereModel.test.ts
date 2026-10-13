import { describe, expect, it } from 'vitest';
import { densityAltitudeM, isaAltitudeForDensity, isaPressurePa, isaTemperatureK, padAir, R_AIR } from './atmosphere.js';
import { DEFAULT_CONDITIONS, kernelSimOptions } from './launchConditions.js';
import { siteAirDensity } from './recoverySizing.js';

const radius = 6356766;
const geometric = (h: number) => radius * h / (radius - h);
const classic = { aeroMode: 'classic' as const, effectiveKbf: false };
const models = [
  { aeroMode: 'classic' as const, effectiveKbf: true },
  { aeroMode: 'supersonic' as const, effectiveKbf: false },
  { aeroMode: 'hybrid' as const, effectiveKbf: false },
  { aeroMode: 'auto' as const, effectiveKbf: true },
];

describe('model-selected ISA (OR #2731)', () => {
  // US Standard Atmosphere 1976, NASA-TM-X-74335, lower-atmosphere layer
  // table: https://ntrs.nasa.gov/citations/19770009539. These are geopotential
  // heights; pressures evaluate its equations with OR's rounded R = 287.053
  // (20 km gives 5474.885 Pa). 0.005 Pa allows rounding these values.
  const layers = [[11000, 216.65, 22632.06], [20000, 216.65, 5474.885],
    [32000, 228.65, 868.02], [47000, 270.65, 110.91]];
  for (const model of models) {
    it(`reads published layers at geometric heights for ${JSON.stringify(model)}`, () => {
      for (const [h, t, p] of layers) {
        expect(isaTemperatureK(geometric(h!), model)).toBeCloseTo(t!, 6);
        expect(isaPressurePa(geometric(h!), model)).toBeCloseTo(p!, 2);
        expect(isaPressurePa(h!, model)).toBeGreaterThan(isaPressurePa(h!, classic));
      }
    });
  }

  it('keeps the entire Classic profile and inverse exactly as the legacy API', () => {
    for (const z of [0, 1190, 10000, 11000, 20000, 32000, 47000, 80000, 1e9, NaN]) {
      expect(isaTemperatureK(z, classic)).toBe(isaTemperatureK(z));
      expect(isaPressurePa(z, classic)).toBe(isaPressurePa(z));
    }
    for (const rho of [0.04, 0.2, 1, 1.5]) {
      expect(isaAltitudeForDensity(rho, classic)).toBe(isaAltitudeForDensity(rho));
    }
  });

  it('inverts to geometric metres across every layer, including negative density altitude', () => {
    for (const model of models) {
      for (const z of [0, 1190, 10000, 11000, 20000, 32000, 47000, 60000, 80000]) {
        const rho = isaPressurePa(z, model) / (R_AIR * isaTemperatureK(z, model));
        expect(isaAltitudeForDensity(rho, model)).toBeCloseTo(z, 6);
      }
      const rho = 1.5;
      const h = isaAltitudeForDensity(rho);
      expect(isaAltitudeForDensity(rho, model)).toBeCloseTo(geometric(h), 6);
    }
  });

  it('uses the selected site air for partial weather, sizing, and density altitude', () => {
    for (const model of [classic, ...models]) {
      for (const weather of [{ temperatureC: 35, pressureHPa: null },
        { temperatureC: null, pressureHPa: 730 }, { temperatureC: null, pressureHPa: null }]) {
        const launch = { ...DEFAULT_CONDITIONS, launchAltitudeM: 2682, ...weather };
        const air = padAir(launch, model);
        const options = kernelSimOptions(launch, model);
        expect(air.temperatureK).toBe(weather.temperatureC === null
          ? isaTemperatureK(2682, model) : 308.15);
        expect(air.pressurePa).toBe(weather.pressureHPa === null
          ? isaPressurePa(2682, model) : 73000);
        expect(options.temperature).toBe(air.standard ? undefined : air.temperatureK);
        expect(options.pressure).toBe(air.standard ? undefined : air.pressurePa);
        const rho = air.pressurePa / (R_AIR * air.temperatureK);
        expect(siteAirDensity(launch, model)).toBe(rho);
        expect(densityAltitudeM(launch, model)).toBe(isaAltitudeForDensity(rho, model));
        if (air.standard) expect(densityAltitudeM(launch, model)).toBeCloseTo(2682, 6);
      }
    }
  });
});
