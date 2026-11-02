const marker = (ch: string): string => `[U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}]`;

/** Also used at the API boundary, after producers have added their delimiters. */
export function noteText(text: string): string {
  return text.replace(/\t/g, ' ').replace(/[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u2028\u2029\ud800-\udfff]/gu, '')
    .replace(/\u{1f3f4}[\u{e0020}-\u{e007e}]+\u{e007f}|[\u200c\u200d]+|\p{Cf}/gu, (ch, at: number, source: string) => {
      if (ch.startsWith('\u{1f3f4}')) return ch;
      // Joiners belong in emoji and many scripts; only ASCII camouflage is marked.
      if (/^[\u200c\u200d]+$/.test(ch)
        && !(/[\x00-\x7f]/.test(source[at - 1] ?? '') && /[\x00-\x7f]/.test(source[at + ch.length] ?? ''))) return ch;
      return Array.from(ch, marker).join('');
    });
}

/** File spans must be single-line and cannot close the producer's quote pair. */
export function noteField(text: string, max = Infinity): string {
  const cut = Number.isFinite(max) ? Array.from(text).slice(0, max).join('') : text;
  return noteText(cut).replace(/[\u201c\u201d]/gu, marker);
}
