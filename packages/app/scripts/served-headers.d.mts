// Types for the build-time checks imported by vite.config.ts.
export function parseHeaders(text: string): Record<string, [string, string][]>;
export function cspDirectives(value: string): Map<string, string[]>;
export function inlineScriptHashes(html: string): string[];
export function checkServedHeaders(html: string | string[], headersText: string): string[];
export function checkDistHtml(distDir: string, headersText: string): string[];
