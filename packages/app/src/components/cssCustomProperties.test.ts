import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * styles.css hygiene the type checker cannot see (audit 2026-09-22, Dead code
 * row 578).
 *
 * `--border-subtle` was READ and never defined, so its hard-coded fallback
 * drew one hairline outside the Daylight contrast policy every other token
 * obeys; `--series-2` / `--series-3` were defined in all three themes and read
 * by nothing. A custom property is a name, so neither mistake fails anything.
 *
 * "Defined" includes a name the app sets from TypeScript (an inline style
 * `'--hero-natural'`, NoticeBar's `setProperty('--notice-h')`), and "read"
 * includes one it reads back (chartTheme's `v('--chart-axis')`): any quoted
 * `'--name'` in src counts both ways. So does `var(--name)` in a TSX style.
 */
const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..');
const css = readFileSync(join(src, 'styles.css'), 'utf8');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(readFileSync(p, 'utf8'));
  }
  return out;
}
const code = sources(src).join('\n');

const names = (text: string, re: RegExp) => new Set([...text.matchAll(re)].map((m) => m[1]!));
const cssReads = names(css, /var\(\s*(--[\w-]+)/g);
const cssDefs = names(css, /(--[\w-]+)\s*:/g);
const codeReads = names(code, /var\(\s*(--[\w-]+)/g);
const codeNames = names(code, /['"`](--[a-z][\w-]*)['"`]/g);

describe('styles.css custom properties', () => {
  it('reads none it never defines', () => {
    const undefinedNames = [...new Set([...cssReads, ...codeReads])]
      .filter((n) => !cssDefs.has(n) && !codeNames.has(n));
    expect(undefinedNames).toEqual([]);
  });

  it('defines none that nothing reads', () => {
    const unread = [...cssDefs].filter((n) => !cssReads.has(n) && !codeReads.has(n) && !codeNames.has(n));
    expect(unread).toEqual([]);
  });
});

// The same row's other half — Daylight's modal scrim reaching the modals — is
// checked against the rendered Modal in modalScrim.test.tsx.
