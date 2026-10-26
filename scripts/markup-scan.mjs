/** Index of a tag's closing >, ignoring quoted attribute values. */
export function markupTagEnd(text, start) {
  let quote = '';
  let valueStart = false;
  for (let at = start + 1; at < text.length; at++) {
    const ch = text[at];
    if (quote) {
      if (ch === quote) quote = '';
    } else if (valueStart && (ch === '"' || ch === "'")) { quote = ch; valueStart = false; }
    else if (ch === '>') return at;
    else if (ch === '=') valueStart = true;
    else if (!/\s/.test(ch)) valueStart = false;
  }
  return -1;
}

/** Consume each attribute once; HTML permits boolean and unquoted values. */
export function* markupAttributes(text, html = false) {
  const token = /([^\s"'/>=]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/y;
  for (let at = 0; at < text.length;) {
    if (/\s/.test(text[at])) { at++; continue; }
    token.lastIndex = at;
    const match = token.exec(text);
    if (!match) throw new Error('invalid markup attribute');
    at = token.lastIndex;
    const value = match[2] ?? match[3];
    if (!html && value === undefined) throw new Error('XML attribute needs a quoted value');
    if (value !== undefined || match[4] !== undefined) yield [match[1], value ?? match[4]];
  }
}
