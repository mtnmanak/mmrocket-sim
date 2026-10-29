import { expect, it } from 'vitest';
import { noteField } from './noteField.js';

it('cleans the same unsafe set as API notes before file spans acquire note separators', () => {
  const unsafe = [...Array.from({ length: 32 }, (_, i) => i), ...Array.from({ length: 33 }, (_, i) => i + 0x7f),
    0x061c, 0x200e, 0x200f, 0x2028, 0x2029, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0xd800, 0xdfff];
  for (const code of unsafe) expect(noteField('a' + String.fromCodePoint(code) + 'b'), code.toString(16)).toBe(code === 9 ? 'a b' : 'ab');
});
it('keeps ordinary Unicode and long spans verbatim without changing matching or file identities', () => {
  const text = 'Motor \u201cC6\u201d \u00e9 \ud83d\ude80 ' + 'x'.repeat(5000);
  expect(noteField(text)).toBe(text);
});
