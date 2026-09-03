/**
 * Type surface of manufacturers.mjs for the app, which imports it so that a
 * file's <PartMfg>/<PartNo> or <preset> is matched to a catalogue row by the
 * SAME alias table and part-number key the preset pipeline dedupes on
 * (tsconfig has no allowJs, so the .mjs needs this beside it). Declarations
 * only — keep in step with the .mjs.
 */
export const normRaw: (s: unknown) => string;
export const ALIASES: Readonly<Record<string, string>>;
export const DISPLAY: Readonly<Record<string, string>>;
export const mfrKey: (s: unknown) => string;
export const mfrDisplay: (s: unknown) => string;
export const partKey: (partNo: unknown) => string;
export const presetKey: (p: { kind: string; manufacturer: unknown; partNo: unknown }) => string;
export function spellingConflicts(rows: ReadonlyArray<{ manufacturer?: unknown }>): unknown[];
