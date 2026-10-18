import type { EngineWarning } from '@online-openrocket/engine';
import { MAX_DESIGN_PARTS } from '../tree/sanitize.js';

// Room for multiple joint/source warnings per part in an importable design.
export const MAX_STORED_WARNINGS = Math.max(4096, MAX_DESIGN_PARTS * 2);
export const MAX_WARNING_EVIDENCE_DEPTH = 16;
export const MAX_WARNING_EVIDENCE_VALUES = MAX_STORED_WARNINGS * 4;
export const MAX_WARNING_FIELDS = 32;
export const storedWarningLimitNote = `The saved summary has more than ${MAX_STORED_WARNINGS.toLocaleString('en-US')} warnings, more than ${MAX_WARNING_FIELDS} fields in one warning, or warning details nested too deeply or too large to read safely.`;

export function wideStoredWarning(warnings: unknown[]): boolean {
  return warnings.some(warning => warning !== null && typeof warning === 'object'
    && Reflect.ownKeys(warning).length > MAX_WARNING_FIELDS);
}

/** Payloads are immutable during one synchronous import. Cache nested walks,
 * including normalization of source snapshots, across duplicate summaries. */
export interface StoredWarningCache {
  sizes: WeakMap<object, number>;
  normalized: WeakMap<EngineWarning, EngineWarning>;
}

export function createStoredWarningCache(): StoredWarningCache {
  return { sizes: new WeakMap(), normalized: new WeakMap() };
}

/** Bound work before normalization, equality or canonical JSON walks evidence.
 * Iteration also refuses cycles from malformed in-memory/session payloads.
 */
export function boundedWarningEvidence(warnings: unknown[], cache?: StoredWarningCache): boolean {
  if (warnings.length > MAX_STORED_WARNINGS) return false;
  let total = 0;
  for (const warning of warnings) {
    const object = warning !== null && typeof warning === 'object' ? warning : undefined;
    let count = object ? cache?.sizes.get(object) : undefined;
    if (count === undefined) {
      count = 0;
      const pending = [{ value: warning, depth: 0 }];
      while (pending.length) {
        const { value, depth } = pending.pop()!;
        if (++count > MAX_WARNING_EVIDENCE_VALUES || depth > MAX_WARNING_EVIDENCE_DEPTH) { count = Infinity; break; }
        if (value === null || typeof value !== 'object') continue;
        const keys = Reflect.ownKeys(value);
        if (depth === 0 && keys.length > MAX_WARNING_FIELDS) { count = Infinity; break; }
        const children = Array.isArray(value) ? Object.values(value) : keys.map(key => Reflect.get(value, key));
        if (count + pending.length + children.length > MAX_WARNING_EVIDENCE_VALUES) { count = Infinity; break; }
        for (const child of children) pending.push({ value: child, depth: depth + 1 });
      }
      if (object) cache?.sizes.set(object, count);
    }
    total += count;
    if (total > MAX_WARNING_EVIDENCE_VALUES) return false;
  }
  return true;
}

function readableWarning(warning: unknown): warning is EngineWarning {
  if (!warning || typeof warning !== 'object' || Array.isArray(warning)) return false;
  const row = warning as Record<string, unknown>;
  return typeof row['key'] === 'string' && (row['message'] === undefined || typeof row['message'] === 'string');
}

/** The file reader refuses a damaged summary's entire warning array. */
export function validStoredWarnings(warnings: unknown): warnings is EngineWarning[] {
  return Array.isArray(warnings) && boundedWarningEvidence(warnings) && warnings.every(readableWarning);
}

/** Storage is untrusted. Keep stop/danger signals even when other evidence
 * exceeds the read budget; copy only their readable scalar fields, never the
 * oversized details. Live results use storedWarnings directly; saved copies
 * use this bounded representation on both write and read.
 */
export function restoredWarnings(warnings: EngineWarning[] | undefined, cache?: StoredWarningCache): EngineWarning[] | undefined {
  if (!Array.isArray(warnings) || boundedWarningEvidence(warnings, cache)) return storedWarnings(warnings, cache);
  const critical: EngineWarning[] = [];
  // Stop signals take precedence if even the critical list exceeds the cap.
  for (const aborts of [true, false]) {
    for (const warning of warnings) {
      if (critical.length >= MAX_STORED_WARNINGS - 1) break;
      if (!readableWarning(warning) || (aborts ? warning.key !== 'SIM_ABORT'
        : warning.key === 'SIM_ABORT' || warning.priority !== 'HIGH')) continue;
      critical.push({ key: warning.key, message: warning.message ?? '',
        ...(['LOW', 'NORMAL', 'HIGH'].includes(warning.priority ?? '') ? { priority: warning.priority } : {}),
      });
    }
  }
  return [...critical, { key: 'StoredWarningsUnavailable',
    message: `Some saved simulation warnings could not be read; this does not mean the flight had none. ${storedWarningLimitNote}` }];
}

/** Component IDs belong to one open design, never to stored warning evidence.
 * Keep names, removed-source markers, occurrence counts and extension fields.
 * Do not mutate live bridge payloads; retain references when already canonical
 * so identical/older imports remain no-ops. Malformed data keeps its fallback.
 */
export function storedWarnings(warnings: EngineWarning[] | undefined, cache?: StoredWarningCache): EngineWarning[] | undefined {
  if (!Array.isArray(warnings)) return warnings;
  let changed = false;
  // Stored evidence can be malformed; string operations in the report must
  // only receive readable warnings (audit 2026-10-11, S7a-4).
  const valid = warnings.filter(readableWarning);
  changed = valid.length !== warnings.length;
  const normalized = valid.map(warning => {
    const cached = cache?.normalized.get(warning);
    if (cached) { changed ||= cached !== warning; return cached; }
    if (!Array.isArray(warning.sources)) { cache?.normalized.set(warning, warning); return warning; }
    let sourceChanged = false;
    const sources = warning.sources.map(source => {
      if (!source || typeof source !== 'object' || Array.isArray(source) || !Object.hasOwn(source, 'id')) return source;
      const snapshot = { ...source };
      delete snapshot.id;
      sourceChanged = true;
      return snapshot;
    });
    const result = sourceChanged ? { ...warning, sources } : warning;
    changed ||= sourceChanged;
    cache?.normalized.set(warning, result);
    cache?.normalized.set(result, result);
    return result;
  });
  return changed ? normalized : warnings;
}
