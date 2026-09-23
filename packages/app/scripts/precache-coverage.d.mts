// Types for precache-coverage.mjs, which vite.config.ts imports (tsc reads no .mjs).
export const DELIBERATELY_UNCACHED: readonly RegExp[];
export function precachedUrls(swSource: string): Set<string>;
export function uncachedFiles(files: readonly string[], swSource: string): string[];
export function checkDist(distDir: string): string[];
