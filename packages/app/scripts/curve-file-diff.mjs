// Shared plan-time identities and full-content comparison. Never reorder fetched data.
const canonical = (v) => Array.isArray(v) ? v.map(canonical)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
const json = (value) => JSON.stringify(canonical(value));

export const curveFileIdentity = (file) => typeof file?.simfileId === 'string' && file.simfileId !== ''
  ? JSON.stringify(['id', file.simfileId]) : JSON.stringify(['content', canonical(file)]);

// A sorted multiset retains every occurrence, even when identities or content repeat.
export const curveFileMultiset = (files) => files.map(file => JSON.stringify([curveFileIdentity(file), canonical(file)])).sort();

function grouped(files, key) {
  const groups = new Map();
  for (const file of files) {
    const identity = key(file);
    if (!groups.has(identity)) groups.set(identity, []);
    groups.get(identity).push(file);
  }
  return groups;
}

// Cancel equal occurrences before pairing revisions: an unchanged duplicate must
// never hide a revised sibling or make a permutation look like a revision.
function unmatched(before, after, key) {
  const remaining = grouped(before, key), added = [];
  for (const file of after) {
    const matches = remaining.get(key(file));
    if (matches?.length) matches.pop();
    else added.push(file);
  }
  return [[...remaining.values()].flat(), added];
}

export function diffCurveFiles(before = [], after = []) {
  const oldGroups = grouped(before, curveFileIdentity), newGroups = grouped(after, curveFileIdentity);
  const added = [], removed = [];
  let revised = 0, samplesChanged = false;
  for (const identity of new Set([...oldGroups.keys(), ...newGroups.keys()])) {
    const [oldFiles, newFiles] = unmatched(oldGroups.get(identity) ?? [], newGroups.get(identity) ?? [], json);
    const changes = Math.min(oldFiles.length, newFiles.length);
    revised += changes;
    // Within repeated identities, match equal samples before attributing a sample
    // revision. Metadata edits and added/removed duplicates do not revise samples.
    const [oldSamples, newSamples] = unmatched(oldFiles, newFiles, file => json(file?.samples));
    if (oldSamples.length && newSamples.length) samplesChanged = true;
    added.push(...newFiles.slice(changes));
    removed.push(...oldFiles.slice(changes));
  }
  return { added, removed, revised, samplesChanged };
}
