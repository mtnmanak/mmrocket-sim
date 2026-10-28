import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Live regions are ALWAYS MOUNTED (audit 2026-09-22): "a region inserted with
 * its text already in place is announced unreliably, so the containers exist
 * before their first message." The element carrying role="alert"/"status"/
 * "log" or aria-live is rendered on every render and the message is its
 * conditional child — never the other way round.
 *
 * This scan finds the other way round: a live element that is itself the
 * right-hand side of `&&` (pattern 1) or an arm of `? :` (pattern 2), with any
 * comments in between. They are the sweep patterns of the live-region lane,
 * run over every non-test .tsx under src. It sees only the element-level
 * form; a live element inside a container that mounts conditionally is not
 * visible to a regex, and the lane's inventory sweep covers that.
 */
const COMMENTS = String.raw`(?:\s*(?:\{/\*[\s\S]*?\*/\}|//[^\n]*))*`;
const LIVE_TAG = String.raw`\s*<[^>]*(?:role="(?:alert|status|log)"|aria-live=)`;
const PATTERNS = {
  and: new RegExp(String.raw`&&\s*\(?` + COMMENTS + LIVE_TAG, 'g'),
  ternary: new RegExp(String.raw`[?:]\s*\(?` + COMMENTS + LIVE_TAG, 'g'),
} as const;
type Pattern = keyof typeof PATTERNS;

/**
 * Matches that are correct as they stand. `snippet` is text the match must
 * contain, so an entry names one site without depending on line numbers.
 */
const ALLOWED: { file: string; pattern: Pattern; snippet: string; reason: string }[] = [
  {
    file: 'components/MotorPadMass.tsx', pattern: 'ternary',
    snippet: '{live ? line : <Note as="p" role="status"',
    reason: 'PadMassLine: both arms render a <p role="status"> in the same position, so React keeps the one node '
      + 'and only its text changes; the empty arm is the region waiting for its first message.',
  },
];

const src = dirname(fileURLToPath(import.meta.url));
const sources = (readdirSync(src, { recursive: true, encoding: 'utf8' }) as string[])
  .filter((f) => f.endsWith('.tsx') && !/\.test\.tsx$/.test(f))
  .map((f) => f.split('\\').join('/'))
  .sort();

/** A match, with `text` running from the start of its first line to its end. */
interface Hit { file: string; pattern: Pattern; text: string }

/** Every match of each pattern in `text`, as found in `file`. */
function liveRegionHits(file: string, text: string): Hit[] {
  const hits: Hit[] = [];
  for (const pattern of Object.keys(PATTERNS) as Pattern[]) {
    for (const m of text.matchAll(PATTERNS[pattern])) {
      const lineStart = text.lastIndexOf('\n', m.index) + 1;
      hits.push({ file, pattern, text: text.slice(lineStart, m.index + m[0].length) });
    }
  }
  return hits;
}

const allowedFor = (hit: Hit) => ALLOWED.find((a) => a.file === hit.file && a.pattern === hit.pattern && hit.text.includes(a.snippet));

describe('live regions mount before their message (source scan)', () => {
  const hits = sources.flatMap((f) => liveRegionHits(f, readFileSync(join(src, f), 'utf8')));

  it('scans the app sources', () => {
    expect(sources.length).toBeGreaterThan(50);
    expect(sources).toContain('App.tsx');
    expect(sources).toContain('components/MotorPadMass.tsx');
  });

  it('finds no live element mounted together with its message', () => {
    const unexpected = hits.filter((h) => !allowedFor(h))
      .map((h) => `${h.file} (${h.pattern}): ${h.text.replace(/\s+/g, ' ').slice(0, 160)}`);
    expect(unexpected).toEqual([]);
  });

  it('every allow-list entry still matches (a stale entry fails)', () => {
    const stale = ALLOWED.filter((a) => !hits.some((h) => allowedFor(h) === a)).map((a) => `${a.file}: ${a.snippet}`);
    expect(stale).toEqual([]);
  });

  it('the patterns see the forms the sweep found, comments included', () => {
    const forms = [
      '{error && <p role="alert">{error}</p>}',
      '{failed && (\n  // a comment\n  <Note tier="danger" className="x" role="alert">Failed</Note>\n)}',
      '{failed && (\n  {/* a comment */}\n  <div aria-live="polite">Failed</div>\n)}',
      '{busy ? <p role="status">Busy</p> : null}',
      '{ok ? null : <p role="log">Lost</p>}',
    ];
    expect(forms.map((f) => liveRegionHits('form.tsx', f).length)).toEqual([1, 1, 1, 1, 1]);
    // The fixed form, and an always-mounted region whose class toggles, do not match.
    expect(liveRegionHits('ok.tsx', '<div role="alert">{error && <p>{error}</p>}</div>')).toEqual([]);
    expect(liveRegionHits('ok.tsx', '<p role="status" className={notice ? undefined : \'sr-only\'}>{notice}</p>')).toEqual([]);
  });
});
