const marker = (ch: string): string => `[U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}]`;

/** Also used at the API boundary, after producers have added their delimiters. */
export function noteText(text: string): string {
  return text.replace(/\t/g, ' ').replace(/[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u2028\u2029\ud800-\udfff]/gu, '')
    .replace(/\u{1f3f4}[\u{e0020}-\u{e007e}]+\u{e007f}|[\p{Cf}\p{Default_Ignorable_Code_Point}]+/gu, (ch, at: number, source: string) => {
      if (ch.startsWith('\u{1f3f4}')) return ch;
      // Joiners and selectors belong in scripts and emoji. Treat a mixed run
      // as one span so invisible neighbours cannot hide ASCII camouflage.
      const left = source[at - 1], right = source[at + ch.length];
      const asciiChar = (c: string | undefined) => c !== undefined && /[\x00-\x7f]/.test(c);
      const edge = (c: string | undefined) => c === undefined || /[\u201c\u201d]/.test(c);
      const ascii = (asciiChar(left) && (asciiChar(right) || edge(right)))
        || (edge(left) && asciiChar(right));
      const flanked = asciiChar(left) && asciiChar(right);
      return Array.from(ch, c => (/[\u200c\u200d]/u.test(c) ? flanked : ascii || /\p{Cf}/u.test(c)) ? marker(c) : c).join('');
    });
}

/** File spans must be single-line and cannot close the producer's quote pair. */
export function noteField(text: string, max = Infinity): string {
  const cut = Number.isFinite(max) ? Array.from(text).slice(0, max).join('') : text;
  return noteText(cut).replace(/[\u201c\u201d]/gu, marker);
}
