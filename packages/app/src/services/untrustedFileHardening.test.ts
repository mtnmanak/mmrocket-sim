// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import type { ComponentNode } from '@online-openrocket/engine';
import { exportOrk } from './orkFile.js';
import { importCdx1 } from './rasaeroFile.js';
import { importRkt } from './rocksimFile.js';
import {
  MAX_FIN_POINTS, MAX_NESTING, TOO_DEEP_NESTING, TOO_MANY_FIN_POINTS, lookupTable, unreadableFinPoints,
} from './xmlUtil.js';

/**
 * The three untrusted-input findings from the 2026-09-08 audit that were not
 * already guarded. These files arrive from other people — forum posts, club
 * mates, a tester's own archive — and every one of these was reachable from a
 * one-word edit to a design file.
 */

/** `design` carries <Surface>; the nose cone carries <Shape>. */
const cdx1 = (design = '', nose = ''): string =>
  `<?xml version="1.0"?><RASAeroDocument><FileVersion>2</FileVersion><RocketDesign>
    ${design}
    <NoseCone><PartType>NoseCone</PartType><Length>4.5</Length><Diameter>0.736</Diameter>
      ${nose}</NoseCone>
    <BodyTube><PartType>BodyTube</PartType><Length>18.25</Length><Diameter>0.736</Diameter></BodyTube>
  </RocketDesign></RASAeroDocument>`;

describe('lookupTable — a prototype key cannot masquerade as a value', () => {
  it('is why `MAP[fileText] ?? DEFAULT` can be trusted', () => {
    const plain: Record<string, string> = { ogive: 'ogive' };
    const safe = lookupTable<string>({ ogive: 'ogive' });
    // The trap, stated: on a plain object this is a FUNCTION, and truthy.
    expect(plain['constructor']).toBeTruthy();
    expect(typeof plain['constructor']).toBe('function');
    // And on the guarded one it is simply absent, so the fallback fires.
    expect(safe['constructor']).toBeUndefined();
    expect(safe['__proto__']).toBeUndefined();
    expect(safe['toString']).toBeUndefined();
    expect(safe['ogive']).toBe('ogive');
  });
});

describe('RASAero import — a prototype key in a file is not a value', () => {
  it('falls back to regular paint AND warns on <Surface>constructor</Surface>', () => {
    const { tree, notes } = importCdx1(cdx1('<Surface>constructor</Surface>'));
    // Before the fix the surface lookup returned Object itself, so a FUNCTION
    // was written onto a model node: it reached a re-export as
    // "function Object() { [native code] }" and JSON.stringify dropped it from
    // the session autosave entirely. Asserted over the whole tree rather than
    // at one key, because "no node carries a function" is the real invariant.
    const walk = (ns: readonly { children?: readonly unknown[] }[]): unknown[] =>
      ns.flatMap((n) => [n, ...walk((n.children ?? []) as { children?: readonly unknown[] }[])]);
    for (const node of walk(tree.components as never)) {
      for (const v of Object.values(node as Record<string, unknown>)) {
        expect(typeof v).not.toBe('function');
      }
    }
    // The "unknown surface finish" note is the other half — it is a
    // `=== undefined` test, so it silently did not fire either.
    expect(notes.some((n) => /Unknown RASAero surface finish/.test(n))).toBe(true);
  });

  it('gives a nose cone a shape on <Shape>constructor</Shape>', () => {
    const { tree } = importCdx1(cdx1('', '<Shape>constructor</Shape>'));
    const nose = tree.components[0]!.children![0]!;
    // Previously `undefined` — the nose imported with no shape at all, the
    // `?? { shape: 'ogive' }` guard having been bypassed.
    expect(typeof nose['shape']).toBe('string');
    expect(nose['shape']).toBeTruthy();
  });

  it('leaves a known value working', () => {
    const { tree } = importCdx1(cdx1('', '<Shape>Tangent Ogive</Shape>'));
    expect(tree.components[0]!.children![0]!['shape']).toBe('ogive');
  });
});

describe('the .rkt CDATA pre-pass is linear, not quadratic', () => {
  const rkt = (inner: string): string =>
    `<RockSimDocument><DesignInformation><RocketDesign><Name>t</Name><StageCount>1</StageCount>
      <Stage3Parts><BodyTube><Name>b</Name><OD>24</OD><ID>23</ID><Len>300</Len>
        ${inner}
      </BodyTube></Stage3Parts></RocketDesign></DesignInformation></RockSimDocument>`;

  it('completes in time linear in the number of UNTERMINATED openers', () => {
    // The pattern this replaces re-scanned to end-of-file once per opener:
    // 0.1 MB 5 ms, 0.5 MB 33 ms, 2.0 MB 514 ms. `zipMember` allows a 64 MiB
    // inflated member, which a ~200 KB zip reaches — about 8 minutes of frozen
    // main thread, defeating the zip-bomb cap one layer above.
    //
    // Timed rather than asserted structurally because the QUADRATIC is the bug;
    // the ratio is what has to stay bounded, so the test compares two sizes
    // rather than pinning a wall-clock number.
    // Unterminated openers inside a text node the importer does read.
    const opener = '<![CDATA[ padding padding padding ';
    const small = rkt(`<Comments>${opener.repeat(2000)}</Comments>`);
    const large = rkt(`<Comments>${opener.repeat(8000)}</Comments>`);

    // Both REFUSE — an unterminated section leaves malformed XML, and DOMParser
    // rejects it. That is the right answer; what is being timed is the pre-pass
    // that runs BEFORE the parser is reached, which is where the quadratic was.
    const time = (xml: string): number => {
      const t = performance.now();
      try { importRkt(xml); } catch { /* expected: malformed */ }
      return performance.now() - t;
    };
    const tSmall = time(small);
    const tLarge = time(large);

    // 4x the input. Linear would be ~4x the time; the old quadratic pass was
    // ~16x. A generous ceiling keeps this from flaking on a loaded machine
    // while still failing outright if the quadratic scan comes back.
    const ratio = tLarge / Math.max(tSmall, 0.5);
    expect(ratio, `4x input took ${ratio.toFixed(1)}x the time`).toBeLessThan(10);
  });

  it('still inlines a well-formed CDATA section', () => {
    // The section's own text is escaped and inlined, so DOMParser sees ordinary
    // character data and the name survives with its real characters.
    const xml = `<RockSimDocument><DesignInformation><RocketDesign>
      <Name><![CDATA[Tube & <thing>]]></Name><StageCount>1</StageCount>
      <Stage3Parts><BodyTube><Name>b</Name><OD>24</OD><ID>23</ID><Len>300</Len></BodyTube></Stage3Parts>
    </RocketDesign></DesignInformation></RockSimDocument>`;
    expect(importRkt(xml).tree.name).toBe('Tube & <thing>');
  });

  it('an unterminated opener is refused FAST, not scanned to the end of the file', () => {
    // Left as literal text, `<![CDATA[` makes the document malformed, and
    // DOMParser refuses it — which is the right answer: an unclosed section is
    // not a rocket design. What matters is that the refusal is immediate
    // instead of the parser being reached after a quadratic pre-pass.
    const xml = rkt('<Comments><![CDATA[ never closed</Comments>');
    const t0 = performance.now();
    expect(() => importRkt(xml)).toThrow(/RockSim/);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});

/** A one-fin-set .rkt whose CustomFinSet carries `pointList` verbatim. */
const rktFin = (pointList: string): string =>
  `<RockSimDocument><DesignInformation><RocketDesign><Name>t</Name>
      <Stage3Parts><BodyTube><Name>b</Name><Len>300</Len><OD>24</OD>
        <AttachedParts><CustomFinSet><Name>f</Name><FinCount>3</FinCount>
          <PointList>${pointList}</PointList></CustomFinSet></AttachedParts>
      </BodyTube></Stage3Parts></RocketDesign></DesignInformation></RockSimDocument>`;

/** The fin set of a `rktFin` import, and its outline if one was taken. */
const finOf = (out: ReturnType<typeof importRkt>): [number, number][] | undefined =>
  out.tree.components[0]!.children![0]!.children![0]!['points'] as [number, number][] | undefined;

describe('a freeform fin outline is capped', () => {
  it('refuses an absurd point count instead of validating it in O(n^2)', () => {
    // A monotone staircase: NOT self-intersecting, so finOutlineIntersection's
    // double loop runs to completion — the expensive case.
    const pts = Array.from({ length: MAX_FIN_POINTS + 500 }, (_, i) => `${i * 0.001},${i * 0.0005}`);
    const t0 = performance.now();
    const out = importRkt(rktFin(pts.join('|')));
    const ms = performance.now() - t0;
    expect(out.tree.components.length).toBeGreaterThan(0);
    // Generous, but far below the ~27 s an uncapped 90,000-point list cost.
    expect(ms, `import took ${ms.toFixed(0)} ms`).toBeLessThan(4000);
    // REFUSED, not truncated (audit 2026-09-22): the first 5,000 of these
    // points are a different fin, and they used to fly with no note.
    expect(finOf(out)).toBeUndefined();
    expect(out.notes).toContain(`Fin set "f": its outline was not used — ${TOO_MANY_FIN_POINTS} `
      + 'The set keeps a default outline; redraw it in the fin editor.');
  });

  it('counts duplicate 0,0 pairs against the cap, so they cannot spin the loop', () => {
    // Audit 2026-09-22: the cap was tested only before a push, and a duplicate
    // origin is never pushed — each one scanned every kept point instead, so
    // 4,998 real points and then `0,0` pairs ran ~20 µs a pair, unbounded:
    // 3.5 s for 0.85 MB, minutes for a 64 MiB zipped .rkt. RockSim's own
    // order, trailing root first, puts the origin LAST among the kept points,
    // so each scan walked all of them before finding it.
    const n = MAX_FIN_POINTS - 2;
    const real = Array.from({ length: n }, (_, i) => `${(n - i) * 0.01},${i === 0 ? 0 : 5 + (i % 2)}`);
    const list = `${real.join('|')}|0,0|${'0,0|'.repeat(150_000)}`;
    const t0 = performance.now();
    const out = importRkt(rktFin(list));
    const ms = performance.now() - t0;
    expect(ms, `import took ${ms.toFixed(0)} ms`).toBeLessThan(1500);
    expect(finOf(out)).toBeUndefined();
    expect(out.notes.some((n) => n.includes(TOO_MANY_FIN_POINTS))).toBe(true);
  });

  it("says the list is too long in RockSim's reversed order too, not that the root is backwards", () => {
    // Truncated trailing-first, the kept half never reached 0,0, was never
    // reversed, and was refused as "The last point must be aft of the first" —
    // a true statement about a list the file never wrote.
    const n = MAX_FIN_POINTS + 10;
    const pts = Array.from({ length: n }, (_, i) => {
      const x = (n - 1 - i) * 0.02;
      return `${x},${i === 0 || i === n - 1 ? 0 : 10}`;
    });
    const out = importRkt(rktFin(pts.join('|')));
    expect(finOf(out)).toBeUndefined();
    const note = out.notes.find((m) => m.startsWith('Fin set "f"')) ?? '';
    expect(note).toContain(TOO_MANY_FIN_POINTS);
    expect(note).not.toMatch(/aft of the first/);
  });

  it('still reads an ordinary reversed list with its duplicate closing origin', () => {
    // RockSim's own shape: trailing root first, the origin twice at the end.
    const out = importRkt(rktFin('60,0|50,30|10,30|0,0|0,0|'));
    expect(finOf(out)).toEqual([[0, 0], [0.01, 0.03], [0.05, 0.03], [0.06, 0]]);
  });

  it('reads no hex coordinate as a number', () => {
    // parseDecimal, as xmlNum: `Number('0x10')` put a vertex at 16 mm. The
    // pair is left out like any other unreadable one — and said so.
    const out = importRkt(rktFin('0,0|0x10,30|50,30|60,0'));
    expect(finOf(out)).toEqual([[0, 0], [0.05, 0.03], [0.06, 0]]);
    expect(out.notes).toContain(`Fin set "f": ${unreadableFinPoints(1)}`);
  });

  it('drops a malformed pair rather than inserting an origin vertex, and says so', () => {
    // `Number('')` is 0, so "1,1|,,|2,2" used to yield a real [0,0] point in the
    // middle of the outline — which usually made it self-intersect, and the
    // note then blamed the outline rather than the field. It was then skipped
    // with NO note (audit 2026-09-22); the desktop warns and skips, and so does
    // this now — the same fin, and the user told a vertex is missing.
    const out = importRkt(rktFin('0,0|10,30|,,|50,30|7|60,0'));
    expect(finOf(out)).toEqual([[0, 0], [0.01, 0.03], [0.05, 0.03], [0.06, 0]]);
    expect(out.notes).toContain(`Fin set "f": ${unreadableFinPoints(2)}`);
  });

  it('says nothing about an ordinary list, blank pairs and duplicate origins included', () => {
    const out = importRkt(rktFin('60,0|50,30|10,30|0,0||0,0|'));
    expect(finOf(out)).toEqual([[0, 0], [0.01, 0.03], [0.05, 0.03], [0.06, 0]]);
    expect(out.notes.some((m) => m.startsWith('Fin set'))).toBe(false);
  });
});

describe('.rkt component nesting is capped as .ork nesting is', () => {
  // Review of audit 2026-09-22 row 236: only the .ork importer was capped, so
  // a .rkt nested 500 deep imported whole (1.2 s), saved as an 8.9 MB .ork,
  // and at 1,500 levels the import overflowed the stack.
  /** A body tube carrying `n` inner tubes, each attached inside the last. */
  const nested = (n: number): string => {
    let parts = '';
    for (let i = n; i > 0; i--) {
      parts = `<BodyTube><Name>t${i}</Name><Len>10</Len><OD>20</OD><ID>19</ID>`
        + `<AttachedParts>${parts}</AttachedParts></BodyTube>`;
    }
    return `<RockSimDocument><DesignInformation><RocketDesign><Name>t</Name>
      <Stage3Parts><BodyTube><Name>b</Name><Len>300</Len><OD>24</OD>
        <AttachedParts>${parts}</AttachedParts></BodyTube></Stage3Parts>
      </RocketDesign></DesignInformation></RockSimDocument>`;
  };
  const depth = (ns: ComponentNode[], k = 0): number =>
    ns.reduce((m, n) => Math.max(m, depth(n.children ?? [], k + 1)), k);

  it('keeps a design exactly MAX_NESTING levels deep whole, with no note', () => {
    const r = importRkt(nested(MAX_NESTING - 1)); // the body tube is level 1
    expect(depth(r.tree.components)).toBe(MAX_NESTING + 1); // the stage, then 64 levels
    expect(r.notes).not.toContain(TOO_DEEP_NESTING);
  });

  it('leaves out what is deeper, says so, and can save what it kept', () => {
    const r = importRkt(nested(500));
    expect(depth(r.tree.components)).toBe(MAX_NESTING + 1);
    expect(r.notes).toContain(TOO_DEEP_NESTING);
    // No stopwatch here: at 500 levels the old import took ~1.2 s and the new
    // one ~0.24 s on a fast desktop, too close for a budget a slower CI runner
    // must also meet. The export size is the machine-independent guard: the
    // per-level indentation made it quadratic in depth (8.9 MB at 500 levels
    // before the cap).
    expect(exportOrk({ name: 'Deep', tree: r.tree }).length).toBeLessThan(500_000);
  });

  it('counts a pod as a level too', () => {
    // A pod's chain is converted without AttachedParts, so a counter kept only
    // there would let pod-in-tube-in-pod nest twice as deep as the cap.
    let parts = '';
    for (let i = 0; i < 100; i++) {
      parts = `<ExternalPod><Name>p${i}</Name><BodyTube><Name>b${i}</Name><Len>10</Len><OD>20</OD>`
        + `<AttachedParts>${parts}</AttachedParts></BodyTube></ExternalPod>`;
    }
    const r = importRkt(`<RockSimDocument><DesignInformation><RocketDesign><Name>t</Name>
      <Stage3Parts><BodyTube><Name>b</Name><Len>300</Len><OD>24</OD>
        <AttachedParts>${parts}</AttachedParts></BodyTube></Stage3Parts>
      </RocketDesign></DesignInformation></RockSimDocument>`);
    expect(depth(r.tree.components)).toBe(MAX_NESTING + 1);
    expect(r.notes).toContain(TOO_DEEP_NESTING);
  });
});

/** A string as single bytes — the file a windows-1252 or ISO-8859-1 writer saves. */
const singleBytes = (s: string): ArrayBuffer => new Uint8Array([...s].map((c) => c.charCodeAt(0))).buffer;

describe('the importers read the encoding a file declares', () => {
  // Audit 2026-09-22 (carried from 8 September): the bytes were always read as
  // UTF-8 and `encoding=` discarded, so a windows-1252 name came in with
  // replacement characters and no word about it.
  it('reads a windows-1252 .rkt as windows-1252', () => {
    const xml = '<?xml version="1.0" encoding="windows-1252"?>'
      + rktFin('0,0|50,30|60,0').replace('<Name>t</Name>', '<Name>Fin 30° cant</Name>');
    const out = importRkt(singleBytes(xml));
    expect(out.name).toBe('Fin 30° cant');
    expect(out.notes.some((n) => /could not be read and/.test(n))).toBe(false);
  });

  it('says so when a .rkt is not UTF-8 and names no encoding', () => {
    const out = importRkt(singleBytes(rktFin('0,0|50,30|60,0').replace('<Name>t</Name>', '<Name>Fin 30° cant</Name>')));
    expect(out.name).toBe('Fin 30\u{FFFD} cant');
    expect(out.notes[0]).toMatch(/^1 character in this file could not be read and was replaced/);
  });

  it('reads a UTF-16 .CDX1, which used to be a parse error', () => {
    const doc = cdx1().replace('<?xml version="1.0"?>', '<?xml version="1.0" encoding="utf-16"?>');
    const le = new Uint8Array(2 + doc.length * 2);
    le.set([0xff, 0xfe]);
    for (let i = 0; i < doc.length; i++) {
      le[2 + 2 * i] = doc.charCodeAt(i) & 255;
      le[3 + 2 * i] = doc.charCodeAt(i) >> 8;
    }
    const out = importCdx1(le.buffer);
    expect(out.tree.components[0]!.children!.length).toBeGreaterThan(0);
  });
});
