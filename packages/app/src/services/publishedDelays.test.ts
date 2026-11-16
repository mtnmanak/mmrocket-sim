import { describe, expect, it } from 'vitest';
import data from '../data/aerotechDelays.json';
import motorsJson from '../data/motors.json';
import delaySources from '../../scripts/aerotech-delay-sources.json';
import { formatDelayAverage, formatDelayBand, publishedDelayAverage, publishedDelayBand, PUBLISHED_DELAYS_URL } from './publishedDelays.js';

const F52C = '5f5e57811e865c0004c955d8';

describe('printed delay averages', () => {
  it('ships text averages with watched source documents and no measured-data overlap', () => {
    const entries = Object.entries(data.averages).filter(([, motor]) => motor.form === 'text-average');
    const watched = new Set(delaySources.documents.map(source => source.document));
    expect(entries.length).toBeGreaterThan(0);
    for (const [id, motor] of entries) {
      expect(Object.hasOwn(data.motors, id), `${motor.designation}: measured data wins`).toBe(false);
      expect(motor.documents.length).toBeGreaterThan(0);
      for (const document of motor.documents) expect(watched.has(document), document).toBe(true);
    }
  });

  it('rejects prototype keys, plugged settings and non-finite settings', () => {
    expect(publishedDelayAverage('toString', 5)).toBeNull();
    expect(publishedDelayAverage('toString', 'plugged')).toBeNull();
    expect(publishedDelayAverage('toString', Infinity)).toBeNull();
    expect(publishedDelayAverage('toString', NaN)).toBeNull();
  });

  it('looks up only a catalogue identity at its exact finite printed nominal', () => {
    for (const [id, motor] of Object.entries(data.averages)) {
      for (const delay of motor.delays) {
        expect(publishedDelayAverage(id, delay.nominalS)).toEqual({
          designation: motor.designation, nominalS: delay.nominalS, averageS: delay.averageS, url: motor.url,
        });
        for (const flown of [delay.nominalS + 0.1, 'plugged', Infinity, NaN] as const) {
          expect(publishedDelayAverage(id, flown)).toBeNull();
        }
        expect(publishedDelayAverage(`${motor.manufacturer}/${motor.designation}`, delay.nominalS)).toBeNull();
        expect(publishedDelayAverage('toString', delay.nominalS)).toBeNull();
      }
    }
  });

  it('labels a rounded average without suggesting spread or a sample count', () => {
    const text = formatDelayAverage({ averageS: 4.34 });
    expect(text).toBe('4.3 s (printed average only)');
    expect(formatDelayAverage({ averageS: 4.36 })).toBe('4.4 s (printed average only)');
    expect(text).not.toContain('–');
    expect(text).not.toContain('motor');
  });

  it('matches every average source folder hardware class to its catalogue type', () => {
    const catalogue = new Map(motorsJson.motors.map(m => [m.motorId, m]));
    for (const [id, motor] of Object.entries(data.averages)) {
      for (const document of motor.documents) {
        const folder = document.slice(0, document.lastIndexOf('/'));
        const hardware = /Single[- ]Use/i.test(folder) ? 'SU'
          : /RMS-|reload/i.test(folder) ? 'reload' : null;
        expect(hardware, document).not.toBeNull();
        expect(catalogue.get(id)?.type, `${motor.designation}: ${document}`).toBe(hardware);
      }
    }
  });

  it('ships averages separately, with catalogue joins, positive values and matching counts', () => {
    const catalogue = new Map(motorsJson.motors.map(m => [m.motorId, m]));
    const entries = Object.entries(data.averages);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.length).toBe(data.averageMotorCount);
    let pairs = 0;
    for (const [id, motor] of entries) {
      const row = catalogue.get(id)!;
      expect(row).toBeDefined();
      expect([motor.manufacturer, motor.designation]).toEqual([row.manufacturerAbbrev, row.designation]);
      expect(Object.hasOwn(data.motors, id)).toBe(false);
      // Both coordinate-read text and reviewed scans supply averages, never samples.
      expect(['scan-average', 'text-average']).toContain(motor.form);
      expect(motor.documents.length).toBeGreaterThan(0);
      expect(motor.delays.length).toBeGreaterThan(0);
      expect(new Set(motor.delays.map(d => d.nominalS)).size).toBe(motor.delays.length);
      for (const delay of motor.delays) {
        pairs++;
        expect(Object.hasOwn(delay, 'measuredS')).toBe(false);
        expect(Number.isInteger(delay.nominalS) && delay.nominalS > 0).toBe(true);
        expect(delay.averageS).toBeGreaterThan(0);
        expect(Math.abs(delay.averageS - delay.nominalS)).toBeLessThan(delay.nominalS / 2);
      }
    }
    expect(pairs).toBe(data.averagePairCount);
  });
});

describe('publishedDelayBand', () => {
  it('gives the F52C its letter\'s 5 s band: 4.507 to 5.158 s across three motors', () => {
    const b = publishedDelayBand(F52C, 5);
    expect(b).toMatchObject({ designation: 'F52C', nominalS: 5, minS: 4.507, maxS: 5.158, count: 3 });
    expect(b!.url).toMatch(/^https:\/\//);
  });

  it('gives nothing for a delay the tests did not fire, a plugged motor, or a motor it does not hold', () => {
    // The F52C is sold 5, 6, 8, 10, 12 and tested at 5, 8, 12: a drilled 6 s is not a 5 s or an 8 s.
    expect(publishedDelayBand(F52C, 6)).toBeNull();
    expect(publishedDelayBand(F52C, 5.4)).toBeNull();
    expect(publishedDelayBand(F52C, 'plugged')).toBeNull();
    expect(publishedDelayBand(F52C, Infinity)).toBeNull();
    // A motor identified by name only (no catalogue motorId) is not matched by name.
    expect(publishedDelayBand('AeroTech/F52C', 5)).toBeNull();
    expect(publishedDelayBand('toString', 5)).toBeNull();
  });

  it('names the manufacturer\'s certification page as the source', () => {
    expect(PUBLISHED_DELAYS_URL).toBe('https://www.rocketmotorparts.com/page/nar-tra-certification-docs');
  });
});

describe('formatDelayBand', () => {
  it('rounds outward to a tenth, so the band shown is never narrower than measured', () => {
    expect(formatDelayBand({ minS: 4.507, maxS: 5.158, count: 3 })).toBe('4.5–5.2 s (3 motors)');
    expect(formatDelayBand({ minS: 3.16, maxS: 3.727, count: 4 })).toBe('3.1–3.8 s (4 motors)');
    // Already on a tenth: left where it is, not pushed a tenth further.
    expect(formatDelayBand({ minS: 4.5, maxS: 5.1, count: 2 })).toBe('4.5–5.1 s (2 motors)');
    expect(formatDelayBand({ minS: 5.358, maxS: 5.358, count: 1 })).toBe('5.4 s (1 motor)');
  });
});

describe('aerotechDelays.json, as shipped', () => {
  const catalogue = new Map(motorsJson.motors.map((m) => [m.motorId, m]));
  const motors = Object.entries(data.motors);

  it('keys every motor by a catalogue motorId with the designation it was joined to', () => {
    expect(motors.length).toBe(data.motorCount);
    for (const [id, m] of motors) {
      const row = catalogue.get(id);
      expect(row, `${m.designation} (${id})`).toBeDefined();
      expect([row!.manufacturerAbbrev, row!.designation]).toEqual([m.manufacturer, m.designation]);
    }
  });

  it('holds whole-second nominals, each with at least one positive measured delay', () => {
    let pairs = 0;
    for (const [, m] of motors) {
      expect(m.delays.length).toBeGreaterThan(0);
      for (const d of m.delays) {
        pairs++;
        expect(Number.isInteger(d.nominalS) && d.nominalS > 0, `${m.designation} ${d.nominalS}`).toBe(true);
        expect(d.measuredS.length).toBeGreaterThan(0);
        // A measured delay within half the nominal either way: a cell read from
        // the wrong column (an impulse, a mass) cannot pass this.
        for (const v of d.measuredS) expect(Math.abs(v - d.nominalS), `${m.designation} ${d.nominalS} s: ${v}`).toBeLessThan(d.nominalS / 2);
      }
    }
    expect(pairs).toBe(data.pairCount);
  });
});
