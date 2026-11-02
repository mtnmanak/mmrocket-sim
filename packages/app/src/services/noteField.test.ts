import { expect, it } from 'vitest';
import { noteField } from './noteField.js';

it('cleans the same unsafe set as API notes before file spans acquire note separators', () => {
  const unsafe = [...Array.from({ length: 32 }, (_, i) => i), ...Array.from({ length: 33 }, (_, i) => i + 0x7f),
    0x061c, 0x200e, 0x200f, 0x2028, 0x2029, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0xd800, 0xdfff];
  for (const code of unsafe) {
    const ch = String.fromCodePoint(code);
    const expected = /\p{Cf}/u.test(ch) ? `a[U+${code.toString(16).toUpperCase().padStart(4, '0')}]b` : code === 9 ? 'a b' : 'ab';
    expect(noteField('a' + ch + 'b'), code.toString(16)).toBe(expected);
  }
});
it('keeps ordinary Unicode and long spans verbatim without changing matching or file identities', () => {
  const text = 'Motor C6 \u00e9 \ud83d\ude80 ' + 'x'.repeat(5000);
  expect(noteField(text)).toBe(text);
});

it('marks invisible format characters and quotes so names cannot forge delimiters', () => {
  expect(noteField('C\u200b6\u00ad\u2060\ufeff')).toBe('C[U+200B]6[U+00AD][U+2060][U+FEFF]');
  expect(noteField('F32” (3 mounts)X“"\'')).toBe('F32[U+201D] (3 mounts)X[U+201C]"\'');
});

it('preserves ordinary punctuation and linguistic joiners, marking ASCII camouflage', () => {
  const names = 'Eric\'s Rocket, BT-80 2.6", Goblin’s Nose «‹‘’›», 👨‍🚀, می‌روم';
  expect(noteField(names)).toBe(names);
  expect(noteField('C\u200c6 C\u200d6')).toBe('C[U+200C]6 C[U+200D]6');
  expect(noteField('\u200dC C\u200d')).toBe('\u200dC C\u200d');
});

it('cuts before escaping so markers are always complete', () => {
  expect(noteField('x\u202eafter', 2)).toBe('x[U+202E]');
  expect(noteField('x”after', 2)).toBe('x[U+201D]');
});

it('marks entire ASCII joiner runs and preserves subdivision flag tags', () => {
  expect(noteField('C\u200d\u200d6 C\u200c\u200d6')).toBe('C[U+200D][U+200D]6 C[U+200C][U+200D]6');
  const flag = '\u{1f3f4}\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}';
  expect(noteField(flag)).toBe(flag);
});

it('bounds a note field by code points, including a supplementary character at the edge', () => {
  expect(noteField('x'.repeat(159) + '🚀after', 160)).toBe('x'.repeat(159) + '🚀');
});

it('marks tags outside complete black-flag sequences', () => {
  expect(noteField('C\u{e0036}6')).toBe('C[U+E0036]6');
  expect(noteField('\u{e007f}')).toBe('[U+E007F]');
  expect(noteField('\u{1f3f4}\u{e0067}')).toBe('\u{1f3f4}[U+E0067]');
  const flag = '\u{1f3f4}\u{e0067}\u{e0062}\u{e007f}';
  expect(noteField('A' + flag + '\u{e0036}6')).toBe('A' + flag + '[U+E0036]6');
  expect(noteField(flag, 3)).toBe('\u{1f3f4}[U+E0067][U+E0062]');
});
