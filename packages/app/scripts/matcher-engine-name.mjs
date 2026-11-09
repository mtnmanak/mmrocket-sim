/** Split the trailing maker suffix without splitting spaces inside the code. */
export function matcherEngineName(name) {
  const value = name.trim();
  const separators = [...value.matchAll(/\s{2,}/g)];
  const makerStart = value.endsWith(')') ? value.lastIndexOf('(') : value.length;
  const last = separators.filter(m => m.index < makerStart).at(-1);
  if (!last) return null;
  const code = value.slice(0, last.index);
  const maker = value.slice(last.index + last[0].length);
  if (!code || !maker || (/[()]/.test(maker) ? !/^\([^()]*\)$/.test(maker) : /[()]/.test(code.replace(/^\S+/, '')))) return null;
  return [code, maker.replace(/^\(|\)$/g, '')];
}
