// Types for lazy-chunks.mjs, which vite.config.ts imports (tsc reads no .mjs).
import type { HtmlTagDescriptor, Rollup } from 'vite';

export const LAZY_ONLY: readonly string[];
export function lazyModulesInEntry(bundle: Rollup.OutputBundle, root: string): string[];
export function startupPreloadLinks(bundle: Rollup.OutputBundle, root: string): HtmlTagDescriptor[];
