/** Validate manufacturer metadata before creating queries or reporting coverage. */
export function manufacturerAbbreviations(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new Error('metadata: invalid response shape');
  if (!Array.isArray(meta.manufacturers) || !meta.manufacturers.every(m => m && typeof m === 'object'
    && typeof m.abbrev === 'string' && m.abbrev.trim().length > 0)) throw new Error('metadata: invalid manufacturers');
  return meta.manufacturers.map(m => m.abbrev);
}
