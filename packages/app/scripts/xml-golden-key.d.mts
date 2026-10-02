// Types for xml-golden-key.mjs, which xmlParse.golden.test.ts imports (tsc reads no .mjs).
export const KEY_ROOT: string;
export const KEY_EXCLUDED: readonly string[];
export function importerKeyFiles(app: string): string[];
export function importerKey(app: string, overrides?: Readonly<Record<string, string>>): string;
export function importVerdict(v: { key: string; goldenKey: string | undefined; got: string; want: string | undefined }):
  'unchecked' | 'same' | 'different';
