import { describe, expect, it, vi } from 'vitest';
import * as noteFields from './noteField.js';
import { motorLinkParams, withDelayHint } from './motorLink.js';
import { noteField } from './noteField.js';

const id = '5f4294d2000231000000001d';
const other = '5f4294d2000231000000001e';
const fragment = '#d=1.AAAA';

describe('motor-link suffix', () => {
  it.each([`&motor2=${id}`, '&motorX=1', '&delayX=5', '&delayX5', '&=', '&=5'])(
    'silently ignores unknown or empty names %s', suffix => {
      expect(motorLinkParams(fragment + suffix)).toEqual({ motorId: null, delayHint: null, problems: [] });
    });
  it('enforces the writer rounding tolerance boundary', () => {
    expect(withDelayHint(fragment, 5.000005)).toBe(fragment);
    expect(withDelayHint(fragment, 5.0000001)).toBe(fragment + '&delay=5');
  });
  it('writes only round-trippable delays, allowing two-decimal float noise', () => {
    for (const value of [5.125, 1000, 3.333333, NaN, -1, -Infinity]) {
      expect(withDelayHint(fragment, value)).toBe(fragment);
    }
    for (const value of [0, 1e-7, 5, 1.23 + 1e-7, 999.99, Infinity, 'plugged'] as const) {
      const result = motorLinkParams(withDelayHint(fragment, value));
      expect(result).toEqual({ motorId: null, delayHint: value === Infinity || value === 'plugged' ? 'plugged' : Math.round(value * 100) / 100, problems: [] });
    }
    for (let n = 0; n <= 99999; n += 97) {
      const value = n / 100;
      expect(motorLinkParams(withDelayHint(fragment, value))).toEqual({ motorId: null, delayHint: value, problems: [] });
    }
  });
  it('bounds split allocation and never scans a whole unknown pair for equals', () => {
    const split = vi.spyOn(String.prototype, 'split');
    const index = vi.spyOn(String.prototype, 'indexOf');
    motorLinkParams(fragment + '&unknown' + 'x'.repeat(10000));
    const calls = split.mock.calls.slice();
    const scans = index.mock.calls.slice();
    split.mockRestore(); index.mockRestore();
    expect(calls).toContainEqual(['&', 34]);
    expect(scans).not.toContainEqual(['=']);
  });
  it.each(['motor', 'delay'])('bounds and sanitizes invalid %s before formatting', name => {
    const value = '“bad”\n\u202e' + '😀'.repeat(10000);
    const format = vi.spyOn(noteFields, 'noteField');
    const result = motorLinkParams(`${fragment}&${name}=${value}`);
    const calls = format.mock.calls.slice();
    format.mockRestore();
    expect(calls[0]![0].length).toBeLessThanOrEqual(160);
    expect(result.problems).toEqual([`The link's ${name} value “${noteField(value.slice(0, 160), 80)}” was ignored.`]);
    expect(result.problems[0]).not.toMatch(/[\n\u202e]/);
  });
  it('sanitizes delay note quotes and controls', () => {
    const value = '“bad”\n\u202e';
    expect(motorLinkParams(fragment + '&delay=' + value).problems).toEqual([
      `The link's delay value “${noteField(value, 80)}” was ignored.`,
    ]);
  });
  it.each(['motor', 'delay', 'x'])('handles bare %s', name => {
    expect(motorLinkParams(fragment + '&' + name).problems).toHaveLength(name === 'x' ? 0 : 1);
  });
  it('keeps zero ahead of a duplicate delay', () => {
    expect(motorLinkParams(fragment + '&delay=0&delay=5').delayHint).toBe(0);
  });
  it('notes only parameters beyond the exact 32/33 boundary', () => {
    expect(motorLinkParams(fragment + '&x='.repeat(31) + '&delay=5').problems).toEqual([]);
    expect(motorLinkParams(fragment + '&x='.repeat(32) + '&delay=5')).toEqual({ motorId: null, delayHint: null,
      problems: ['The link has extra parameters; only the first 32 were read.'] });
  });
  it.each(['', '&x=1'])('ignores absent and unknown parameters: %s', (suffix) => {
    expect(motorLinkParams(fragment + suffix)).toEqual({ motorId: null, delayHint: null, problems: [] });
  });
  it.each([`&motor=${id}&delay=5`, `&delay=5&motor=${id}`])('reads either order: %s', (suffix) => {
    expect(motorLinkParams(fragment + suffix)).toEqual({ motorId: id, delayHint: 5, problems: [] });
  });
  it.each([['P', 'plugged'], ['0', 0], ['999.99', 999.99], ['1.25', 1.25]] as const)(
    'reads delay %s', (value, expected) => {
      expect(motorLinkParams(`${fragment}&delay=${value}`).delayHint).toBe(expected);
    });
  it.each(['ABC', id.toUpperCase(), '<script>', `${id}#`, `${id}%26`, '', '“bad”\n\u202e'])(
    'ignores malformed motor %j with one safe note', (value) => {
      const result = motorLinkParams(`${fragment}&motor=${value}`);
      expect(result.motorId).toBeNull();
      expect(result.problems).toHaveLength(1);
      expect(result.problems[0]).toContain(`“${noteField(value, 80)}”`);
    });
  it.each(['', '-1', '1000', '1.234', 'Infinity', 'p', '5%26motor=bad', '5#', '+5', '5e1'])(
    'ignores malformed delay %j with one note', (value) => {
      expect(motorLinkParams(`${fragment}&delay=${value}`)).toMatchObject({ delayHint: null, problems: [expect.any(String)] });
    });
  it('keeps the first valid motor and delay, even after an invalid value', () => {
    const result = motorLinkParams(`${fragment}&motor=bad&motor=${id}&motor=${other}&delay=bad&delay=5&delay=P`);
    expect(result).toMatchObject({ motorId: id, delayHint: 5 });
    expect(result.problems).toHaveLength(2);
    expect(motorLinkParams(`${fragment}&motor=${id}&motor=${other}`).problems).toEqual([]);
  });
  it('caps parsing at 32 suffix pairs and reports truncation once', () => {
    expect(motorLinkParams(fragment + '&x='.repeat(31) + `&motor=${id}`).motorId).toBe(id);
    const result = motorLinkParams(fragment + '&x='.repeat(3414) + `&motor=${id}`);
    expect(result.motorId).toBeNull();
    expect(result.problems).toHaveLength(1);
  });
  it('does not percent-decode values or names into accepted parameters', () => {
    expect(motorLinkParams(`${fragment}&%6dotor=${id}&motor=%35${id.slice(1)}`).motorId).toBeNull();
  });
  it('appends a delay hint, preserving null as identity', () => {
    expect(withDelayHint(fragment, null)).toBe(fragment);
    expect(withDelayHint(fragment, 5)).toBe(fragment + '&delay=5');
    expect(withDelayHint(fragment, 'plugged')).toBe(fragment + '&delay=P');
  });
});
