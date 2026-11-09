/**
 * Split a RASAero engine string into [code, maker], as rasaeroFile.ts parseEngine does.
 * A parenthesized maker (the app's writer) lets the code hold repeated spaces; an
 * unparenthesized maker splits exactly as v0.197 and desktop OR do: two parts on a run of spaces.
 */
export function matcherEngineName(name) {
  const value = name.trim();
  let code, maker;
  if (value.endsWith(')')) {
    const open = value.lastIndexOf('(');
    const last = [...value.slice(0, open).matchAll(/\s{2,}/g)].at(-1);
    if (!last || last.index + last[0].length !== open) return null;
    code = value.slice(0, last.index);
    maker = value.slice(open);
    if (!/^\([^()]*\)$/.test(maker)) return null;
  } else {
    const parts = value.split(/\s{2,}/);
    if (parts.length !== 2) return null;
    [code, maker] = parts;
  }
  if (!code || !maker) return null;
  return [code, maker.replace(/^\(|\)$/g, '')];
}
