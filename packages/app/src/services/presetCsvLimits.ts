/** Preset CSV import limits, kept apart from presets.ts so the debug log can allowlist the refusals without loading it. */
export const MAX_PRESET_CSV_BYTES = 16 * 1024 * 1024;
export const MAX_PRESET_CSV_ROWS = 100_000;
export const PRESET_CSV_SIZE_CAUTION = 'This CSV is too large to import (limit 16 MiB). Nothing imported. Split it into smaller files and try again.';
export const PRESET_CSV_ROWS_CAUTION = 'This CSV has too many rows to import (limit 100,000). Nothing imported. Split it into smaller files and try again.';
