// Types for lazy-chunks.mjs, which vite.config.ts imports (tsc reads no .mjs).
import type { Rollup } from 'vite';

export const LAZY_ONLY: readonly string[];
export function lazyModulesInEntry(bundle: Rollup.OutputBundle, root: string): string[];
