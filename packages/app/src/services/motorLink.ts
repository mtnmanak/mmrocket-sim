import { noteField } from './noteField.js';

const LINK_PARAM = { motor: 'motor', delay: 'delay' } as const;
export const DELAY_HINT_GRAMMAR = /^(?:P|\d{1,3}(?:\.\d{1,2})?)$/;
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
    const name = pair === LINK_PARAM.motor || pair.startsWith(`${LINK_PARAM.motor}=`) ? LINK_PARAM.motor
      : pair === LINK_PARAM.delay || pair.startsWith(`${LINK_PARAM.delay}=`) ? LINK_PARAM.delay : null;
    if (name === null) continue;
    const value = pair.slice(name.length + 1);
    if (name === LINK_PARAM.motor) {
      if (/^[0-9a-f]{24}$/.test(value)) result.motorId ??= value;
      else result.problems.push(`The link's motor value “${noteField(value.slice(0, 160), 80)}” was ignored.`);
    } else if (name === LINK_PARAM.delay) {
      if (value === 'P') result.delayHint ??= 'plugged';
      else if (DELAY_HINT_GRAMMAR.test(value)) result.delayHint ??= Number(value);
      else result.problems.push(`The link's delay value “${noteField(value.slice(0, 160), 80)}” was ignored.`);
    }
  }
  if (pairs.length > 32) result.problems.push('The link has extra parameters; only the first 32 were read.');
  result.problems = [...new Set(result.problems)];
  return result;
}

export function withDelayHint(fragment: string, hint: DelayHint | null): string {
  if (hint === null) return fragment;
  let value: string;
  if (hint === 'plugged' || hint === Infinity) value = 'P';
  else {
    const rounded = Math.round(hint * 100) / 100;
    if (!Number.isFinite(hint) || hint < 0 || hint > 999.99 || Math.abs(hint - rounded) > 1e-6) return fragment;
    value = String(rounded);
  }
  return DELAY_HINT_GRAMMAR.test(value) ? `${fragment}&${LINK_PARAM.delay}=${value}` : fragment;
}
