import { noteField } from './noteField.js';

export const LINK_PARAM = { motor: 'motor', delay: 'delay' } as const;
export type DelayHint = number | 'plugged';
export interface MotorLinkParams {
  motorId: string | null;
  delayHint: DelayHint | null;
  problems: string[];
}

export function motorLinkParams(hash: string): MotorLinkParams {
  const result: MotorLinkParams = { motorId: null, delayHint: null, problems: [] };
  // No percent-decoding: both values have fixed ASCII alphabets. Encoded
  // delimiters must not turn into parameters or valid IDs on a second read.
  // The split limit also bounds allocations for a suffix with many pairs.
  const pairs = hash.split('&', 34).slice(1);
  for (const pair of pairs.slice(0, 32)) {
    const equals = pair.indexOf('=');
    const name = equals === -1 ? pair : pair.slice(0, equals);
    const value = equals === -1 ? '' : pair.slice(equals + 1);
    if (name === LINK_PARAM.motor) {
      if (/^[0-9a-f]{24}$/.test(value)) result.motorId ??= value;
      else result.problems.push(`The link's motor value “${noteField(value, 80)}” was ignored.`);
    } else if (name === LINK_PARAM.delay) {
      if (value === 'P') result.delayHint ??= 'plugged';
      else if (/^\d{1,3}(\.\d{1,2})?$/.test(value)) result.delayHint ??= Number(value);
      else result.problems.push(`The link's delay value “${noteField(value, 80)}” was ignored.`);
    }
  }
  if (pairs.length > 32) result.problems.push('The link has extra parameters; only the first 32 were read.');
  return result;
}

export function withDelayHint(fragment: string, hint: DelayHint | null): string {
  return hint === null ? fragment : `${fragment}&${LINK_PARAM.delay}=${hint === 'plugged' ? 'P' : hint}`;
}
