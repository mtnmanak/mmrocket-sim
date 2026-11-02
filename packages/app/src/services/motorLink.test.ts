import { describe, expect, it } from 'vitest';
import { motorLinkParams, withDelayHint } from './motorLink.js';
import { noteField } from './noteField.js';

const id = '5f4294d2000231000000001d';
const other = '5f4294d2000231000000001e';
const fragment = '#d=1.AAAA';

describe('motor-link suffix', () => {
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
