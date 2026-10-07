import type { EngineWarning } from '@online-openrocket/engine';

/** Component IDs belong to one open design, never to stored warning evidence.
 * Keep names, removed-source markers, occurrence counts and extension fields.
 * Do not mutate live bridge payloads; retain references when already canonical
 * so identical/older imports remain no-ops. Malformed data keeps its fallback.
 */
export function storedWarnings(warnings: EngineWarning[] | undefined): EngineWarning[] | undefined {
  if (!Array.isArray(warnings)) return warnings;
  let changed = false;
  const normalized = warnings.map(warning => {
    if (!warning || !Array.isArray(warning.sources)) return warning;
    let sourceChanged = false;
    const sources = warning.sources.map(source => {
      if (!source || typeof source !== 'object' || Array.isArray(source) || !Object.hasOwn(source, 'id')) return source;
      const snapshot = { ...source };
      delete snapshot.id;
      sourceChanged = true;
      return snapshot;
    });
    if (!sourceChanged) return warning;
    changed = true;
    return { ...warning, sources };
  });
  return changed ? normalized : warnings;
}
