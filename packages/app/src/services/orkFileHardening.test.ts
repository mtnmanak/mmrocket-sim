// @vitest-environment happy-dom
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import type { ComponentNode } from '@online-openrocket/engine';
import { DEFAULT_CONDITIONS } from '../components/LaunchPanel.js';
import { exportOrk, importOrk, type OrkExportConfig, type OrkExportMotor } from './orkFile.js';
import { MAX_FIN_POINTS, TOO_MANY_FIN_POINTS, unreadableFinPoints } from './xmlUtil.js';
import { MAX_ZIP_MEMBER_BYTES } from './zipMember.js';

/**
 * Hardening tests for the .ork importer/exporter: the untrusted-input paths
 * (zip member selection and its size cap), the file-sourced strings that reach
 * the exporter's XML, and the two round-trip losses beside them. The behaviour
 * tests for ordinary designs live in orkFile.test.ts.
 */

/** A minimal but real .ork document; `body` goes inside the sustainer stage. */
const orkXml = (body: string, extra = ''): string =>
  `<?xml version='1.0' encoding='utf-8'?>
<openrocket version="1.10" creator="OpenRocket 24.12">
  <rocket>
    <name>Test</name>
    <subcomponents>
      <stage>
        <name>Sustainer</name>
        <subcomponents>${body}</subcomponents>
      </stage>
    </subcomponents>
  </rocket>
  ${extra}
</openrocket>`;

const BODY_TUBE = '<bodytube><name>Tube</name><length>0.3</length>'
  + '<radius>0.025</radius><thickness>0.001</thickness></bodytube>';

const buf = (u: Uint8Array): ArrayBuffer =>
  u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

/**
 * Rewrite fields of ONE entry's central-directory record. That record is where
 * zipMember.ts reads the compression method and the uncompressed size from
 * (mirroring fflate's `zh()`: method at +10, uncompressed size at +24, name
 * length at +28, name at +46), so patching it is how a crafted archive is
 * simulated without shipping one: a bomb PROMISES a gigabyte in a few hundred
 * bytes, and `method` 14 is a probe that throws the moment the reader is asked
 * to inflate that entry — which is exactly what must never happen to an entry
 * the importer does not want.
 * (rocksimFileHardening.test.ts carries the same helper for the .rkt path.)
 */
function patchZipEntry(zip: Uint8Array, name: string,
    patch: { method?: number; originalSize?: number }): void {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  for (let b = 0; b + 46 <= zip.length; b++) {
    if (dv.getUint32(b, true) !== 0x02014b50) continue; // central-directory header
    const nameLen = dv.getUint16(b + 28, true);
    const entryName = new TextDecoder().decode(zip.subarray(b + 46, b + 46 + nameLen));
    if (entryName !== name) continue;
    if (patch.method !== undefined) dv.setUint16(b + 10, patch.method, true);
    if (patch.originalSize !== undefined) dv.setUint32(b + 24, patch.originalSize, true);
    return;
  }
  throw new Error(`no central-directory record for ${name}`);
}

function flatten(nodes: ComponentNode[]): ComponentNode[] {
  const out: ComponentNode[] = [];
  const walk = (ns: ComponentNode[]) => {
    for (const n of ns) { out.push(n); walk(n.children ?? []); }
  };
  walk(nodes);
  return out;
}

describe('.ork zip reading is bounded', () => {
  it('opens an ordinary zipped .ork', () => {
    const zip = zipSync({ 'rocket.ork': strToU8(orkXml(BODY_TUBE)) });
    expect(importOrk(buf(zip)).name).toBe('Test');
  });

  it('never inflates an entry it will not read', () => {
    // The decoy is marked compression 14 (LZMA), which the reader refuses to
    // inflate — so the import can only succeed if the decoy is skipped before
    // any inflate. The old `unzipSync(bytes)` inflated EVERY entry to build the
    // map it then searched, which is the decompression-bomb vector: real files
    // carry megabytes of decals beside a 30 KB rocket.ork.
    const zip = zipSync({
      'decals/black_gloss.png': strToU8('x'.repeat(4096)),
      'rocket.ork': strToU8(orkXml(BODY_TUBE)),
    });
    patchZipEntry(zip, 'decals/black_gloss.png', { method: 14 });
    expect(importOrk(buf(zip)).name).toBe('Test');
  });

  it('refuses an entry that declares more than the cap', () => {
    const zip = zipSync({ 'rocket.ork': strToU8(orkXml(BODY_TUBE)) });
    patchZipEntry(zip, 'rocket.ork', { originalSize: MAX_ZIP_MEMBER_BYTES + 1 });
    // Rejected on the DECLARED size, before the allocation the reader sizes
    // from that same field — a caught Error the user can read, not an
    // out-of-memory tab that takes their open design with it.
    expect(() => importOrk(buf(zip))).toThrow(/expands to .* MB/);
    expect(() => importOrk(buf(zip))).toThrow(/not a rocket design/);
  });

  it('accepts a member right up to the cap', () => {
    const zip = zipSync({ 'rocket.ork': strToU8(orkXml(BODY_TUBE)) });
    // 15.16 MB is the largest real member measured across this repo's corpus
    // (Wildman Mach 2 this one.ork); the cap has to clear it by a wide margin.
    patchZipEntry(zip, 'rocket.ork', { originalSize: MAX_ZIP_MEMBER_BYTES });
    expect(MAX_ZIP_MEMBER_BYTES).toBeGreaterThan(16 * 1024 * 1024);
    expect(importOrk(buf(zip)).name).toBe('Test');
  });

  it('skips a macOS AppleDouble sidecar that sorts first', () => {
    // `__MACOSX/._rocket.ork` also ends in ".ork", so the old name match
    // preferred the resource fork over the design and reported the user's own
    // file as an XML parse error.
    const zip = zipSync({
      '__MACOSX/._rocket.ork': new Uint8Array([0, 5, 22, 7, 0, 2]),
      'rocket.ork': strToU8(orkXml(BODY_TUBE)),
    });
    expect(importOrk(buf(zip)).name).toBe('Test');
  });

  it('names an empty archive instead of crashing on it', () => {
    expect(() => importOrk(buf(zipSync({})))).toThrow(/Empty \.ork archive/);
  });

  it('reads a UTF-16 .ork, which used to be a parse error', () => {
    // Audit 2026-09-22: the bytes were always read as UTF-8, so a UTF-16 file
    // (byte-order mark and all) failed with "Not a valid .ork file".
    const doc = orkXml(BODY_TUBE).replace("encoding='utf-8'", "encoding='utf-16'");
    const le = new Uint8Array(2 + doc.length * 2);
    le.set([0xff, 0xfe]);
    for (let i = 0; i < doc.length; i++) {
      le[2 + 2 * i] = doc.charCodeAt(i) & 255;
      le[3 + 2 * i] = doc.charCodeAt(i) >> 8;
    }
    expect(importOrk(buf(le)).name).toBe('Test');
    // Zipped, the member goes through the same decoder.
    expect(importOrk(buf(zipSync({ 'rocket.ork': le }))).name).toBe('Test');
  });

  it('refuses a 98-byte archive that declares 2^32 entries, as an Error', () => {
    // Audit 2026-09-22: a zip64 end record's entry count was trusted, and the
    // enumeration read zeros past the end of the buffer until the tab ran out
    // of memory — a crash from the ordinary Open button that no catch can see.
    // Now importOrk throws, and App.tsx shows the message after "Could not open
    // that .ork file: ". zipMember.test.ts builds the same file byte by byte.
    const bomb = new Uint8Array(98);
    const dv = new DataView(bomb.buffer);
    dv.setUint32(0, 0x06064b50, true); // zip64 end record ("PK" — the importer's zip test)
    dv.setUint32(32, 0xffffffff, true); // its entry count
    dv.setUint32(56, 0x07064b50, true); // zip64 locator -> offset 0
    dv.setUint32(76, 0x06054b50, true); // classic end record
    dv.setUint16(84, 1, true);
    expect(() => importOrk(buf(bomb))).toThrow(/lists 4,294,967,295 entries/);
  });
});

describe('.ork numbers are decimal, as the desktop reads them', () => {
  it('falls back on a hex length instead of reading 0x10 as sixteen metres', () => {
    // `Number('0x10')` is 16. The desktop's Double.parseDouble refuses it, so
    // the field is unreadable there and must fall back here (audit 2026-09-22).
    const tube = (length: string, radius: string): ComponentNode => {
      const { tree } = importOrk(orkXml('<bodytube><name>Tube</name>'
        + `<length>${length}</length><radius>${radius}</radius>`
        + '<thickness>0.001</thickness></bodytube>'));
      return flatten(tree.components).find((c) => c.type === 'bodytube')!;
    };
    expect(tube('0x10', '0.025')['length']).toBe(0.3); // the reader's default
    expect(tube('0b11', '0.025')['length']).toBe(0.3);
    expect(tube('0.5', '0.025')['length']).toBe(0.5);
    // `auto 0x1` is a bare `auto` with no readable last value: resolved like
    // one (no neighbour here, so the desktop's 25 mm DEFAULT_RADIUS), never 1 m.
    expect(tube('0.5', 'auto 0x1')['outerRadius']).toBe(0.025);
  });

  it('reads no hex density, offset or weighed mass either', () => {
    // The raw attribute and element reads beside num(), same defect: a
    // `density="0x10"` was 16 kg/m³ on the part's mass.
    const { tree, measured } = importOrk(orkXml('<bodytube><name>Tube</name>'
      + '<material type="bulk" density="0x10">Custom</material>'
      + '<length>0.3</length><radius>0.025</radius><thickness>0.001</thickness>'
      + '<subcomponents><innertube><name>MMT</name><axialoffset method="top">0x1</axialoffset>'
      + '<length>0.1</length><outerradius>0.01</outerradius><thickness>0.001</thickness>'
      + '</innertube></subcomponents></bodytube>',
    ).replace('<name>Test</name>', '<name>Test</name><measuredmass>0x2</measuredmass>'));
    const nodes = flatten(tree.components);
    expect(nodes.find((c) => c.type === 'bodytube')!.density).toBeUndefined();
    expect(nodes.find((c) => c.type === 'innertube')!.position).toEqual({ method: 'top', offset: 0 });
    expect(measured).toBeUndefined();
  });
});

describe('.ork freeform fin points are read as the file wrote them', () => {
  /** A freeform fin set on a body tube, its <point>s written verbatim. */
  const finOrk = (points: string): string => orkXml('<bodytube><name>Tube</name><length>0.3</length>'
    + '<radius>0.025</radius><thickness>0.001</thickness><subcomponents>'
    + `<freeformfinset><name>Fins</name><fincount>3</fincount><finpoints>${points}</finpoints>`
    + '</freeformfinset></subcomponents></bodytube>');
  const fins = (points: string) => {
    const r = importOrk(finOrk(points));
    const set = flatten(r.tree.components).find((c) => c.type === 'freeformfinset')!;
    return { points: set['points'] as [number, number][] | undefined, notes: r.notes };
  };
  const refusal = (why: string) => `Fin set "Fins": its outline was not used — ${why} `
    + 'The set keeps a default outline; redraw it in the fin editor.';

  it('reads an ordinary outline', () => {
    const r = fins('<point x="0.0" y="0.0"/><point x="0.01" y="0.03"/>'
      + '<point x="0.04" y="0.03"/><point x="0.06" y="0.0"/>');
    expect(r.points).toEqual([[0, 0], [0.01, 0.03], [0.04, 0.03], [0.06, 0]]);
    expect(r.notes.some((n) => n.startsWith('Fin set'))).toBe(false);
  });

  it('counts every <point> against the cap, the malformed ones included', () => {
    // Audit 2026-09-22: the cap was counted AFTER the filter, so 5,501 points
    // with one malformed were kept as 5,000 — the front of a longer outline,
    // flown with no note, where the 8 September fix promised "refused rather
    // than truncated".
    const n = MAX_FIN_POINTS + 501;
    const pts = Array.from({ length: n }, (_, i) => {
      const x = (i * 0.2 / (n - 1)).toFixed(6);
      const y = i === 0 || i === n - 1 ? '0' : (0.05 * Math.sin(Math.PI * i / (n - 1))).toFixed(6);
      return i === 100 ? `<point x="abc" y="${y}"/>` : `<point x="${x}" y="${y}"/>`;
    });
    const r = fins(pts.join(''));
    expect(r.points).toBeUndefined();
    expect(r.notes).toContain(refusal(TOO_MANY_FIN_POINTS));
  });

  const skipped = (n: number) => `Fin set "Fins": ${unreadableFinPoints(n)}`;

  it('leaves out a blank coordinate, and says so, instead of reading it as zero', () => {
    // `Number('')` is 0: this outline imported with its second vertex on
    // x = 0, a valid-looking and different fin, with no note at all. The
    // desktop skips the point with a warning; so does this, now.
    const r = fins('<point x="0.0" y="0.0"/><point x="" y="0.03"/>'
      + '<point x="0.04" y="0.03"/><point x="0.06" y="0.0"/>');
    expect(r.points).toEqual([[0, 0], [0.04, 0.03], [0.06, 0]]);
    expect(r.notes).toContain(skipped(1));
  });

  it('leaves out a point with a missing or unreadable coordinate, and says so', () => {
    // Dropped as the desktop drops it (FinSetPointHandler), so both fly the
    // same fin — but no longer silently: the vertex used to vanish with no note.
    for (const bad of ['<point y="0.03"/>', '<point x="0x1" y="0.03"/>', '<point x=" " y="0.03"/>',
      '<point x="0.02" y="1e999"/>']) {
      const r = fins(`<point x="0.0" y="0.0"/><point x="0.01" y="0.03"/>${bad}`
        + '<point x="0.04" y="0.03"/><point x="0.06" y="0.0"/>');
      expect(r.points, bad).toEqual([[0, 0], [0.01, 0.03], [0.04, 0.03], [0.06, 0]]);
      expect(r.notes, bad).toContain(skipped(1));
    }
  });

  it('refuses the outline when what is left cannot be one, with both notes', () => {
    const r = fins('<point x="0.0" y="0.0"/><point x="a" y="0.03"/><point x="0.04" y="b"/>'
      + '<point x="0.06" y="0.0"/>');
    expect(r.points).toBeUndefined();
    expect(r.notes).toContain(skipped(2));
    expect(r.notes.some((m) => m.startsWith('Fin set "Fins": its outline was not used'))).toBe(true);
  });
});

describe('a long chain of automatic radii resolves in linear time', () => {
  // Audit 2026-09-22: the resolver walked the chain afresh from every tube,
  // recursively — measured at the old code, 4,000 bare-`auto` tubes took
  // 7.7 s with the stated radius ahead of them and 15.6 s with it behind,
  // and 8,000 overflowed the stack ("Maximum call stack size exceeded").
  // The bounds are generous — about 1-2 s here now, 21.8 s for the 6,000
  // below at the old code.
  const tube = (r: string) =>
    `<bodytube><name>t</name><length>0.01</length><radius>${r}</radius><thickness>0.001</thickness></bodytube>`;
  const radii = (xml: string): Set<unknown> => new Set(flatten(importOrk(xml).tree.components)
    .filter((c) => c.type === 'bodytube').map((c) => c['outerRadius']));

  // Timed as a RATIO, not a stopwatch: 4x the chain costs ~4x at the linear
  // resolver and ~16x at the old one, on any machine. An absolute budget of a
  // few seconds sat at a third of vitest's own 5 s test timeout on a fast
  // desktop, and a CI runner is several times slower (review of the merge,
  // 2026-09-22).
  const ahead = (n: number) => '<nosecone><name>n</name><length>0.1</length><aftradius>0.03</aftradius>'
    + `</nosecone>${tube('auto').repeat(n)}`;
  const behind = (n: number) => '<nosecone><name>n</name><length>0.1</length><aftradius>auto</aftradius>'
    + `</nosecone>${tube('auto').repeat(n)}${tube('0.03')}`;
  const timeRatio = (xml: (n: number) => string): number => {
    const time = (n: number) => { const t = performance.now(); radii(orkXml(xml(n))); return performance.now() - t; };
    time(250); // warm the parser and the JIT so the small run is not charged for it
    return time(2000) / Math.max(time(500), 0.5);
  };

  it('chains every tube to a stated radius AHEAD of it, in linear time', () => {
    expect([...radii(orkXml(ahead(2000)))]).toEqual([0.03]);
    const ratio = timeRatio(ahead);
    expect(ratio, `4x the chain took ${ratio.toFixed(1)}x the time`).toBeLessThan(10);
  });

  it('chains every tube to a stated radius BEHIND it, in linear time', () => {
    expect([...radii(orkXml(behind(2000)))]).toEqual([0.03]);
    const ratio = timeRatio(behind);
    expect(ratio, `4x the chain took ${ratio.toFixed(1)}x the time`).toBeLessThan(10);
  });

  it('resolves 8,000 tubes behind without recursing the length of the chain', () => {
    // The old resolver recursed once per tube and overflowed the stack here
    // ("Maximum call stack size exceeded"); the answer itself is the guard.
    expect([...radii(orkXml(behind(8000)))]).toEqual([0.03]);
  }, 60_000);
});

describe('method attributes are written from their closed sets', () => {
  it('writes the default, never raw text, for a method outside the set', () => {
    // Audit 2026-09-22: `<axialoffset method>`, `<position type>` and
    // `<tabposition relativeto>` interpolated the node's value unescaped.
    // Unreachable through today's importers, which whitelist all three — this
    // is the tree a future path that kept a file's value would hand over.
    const EVIL = 'top"><evil x="';
    const tree = {
      name: 'M',
      components: [{
        type: 'stage', id: 's', name: 'S',
        children: [{
          type: 'bodytube', id: 'b', name: 'Tube', length: 0.3, outerRadius: 0.025, thickness: 0.001,
          position: { method: EVIL, offset: 0.01 },
          children: [{
            type: 'trapezoidfinset', id: 'f', name: 'Fins', finCount: 3, rootChord: 0.05, tipChord: 0.03,
            height: 0.04, sweepLength: 0.02, thickness: 0.003,
            tabHeight: 0.01, tabLength: 0.02, tabOffset: 0, tabOffsetMethod: EVIL,
          }],
        }],
      }] as unknown as ComponentNode[],
    };
    const xml = exportOrk({ name: 'M', tree });
    expect(xml).not.toContain('<evil');
    for (const [, v] of xml.matchAll(/<(?:axialoffset method|position type)="([^"]*)"/g)) {
      expect(['top', 'middle', 'bottom', 'absolute']).toContain(v);
    }
    expect(xml).toContain('<tabposition relativeto="center">0</tabposition>');
    expect(xml).toContain('<tabposition relativeto="middle">0</tabposition>');
  });
});

describe('component nesting is capped at import', () => {
  // Audit 2026-09-22: import took any depth and the exporter could not give
  // it back — it recurses and indents per level, so depth 1,500 saved as
  // 50 MB (measured at the old code) and threw RangeError in a browser's
  // stack. The cap is 64 levels below the stage; real designs nest 5.
  const nested = (n: number): string => {
    let open = '';
    for (let i = 0; i < n; i++) {
      open += `<bodytube><name>t${i}</name><length>0.1</length><radius>0.02</radius>`
        + '<thickness>0.001</thickness><subcomponents>';
    }
    return orkXml(open + '</subcomponents></bodytube>'.repeat(n));
  };
  const depth = (ns: ComponentNode[], k = 0): number =>
    ns.reduce((m, n) => Math.max(m, depth(n.children ?? [], k + 1)), k);

  it('keeps a design exactly 64 levels deep whole, with no note', () => {
    const r = importOrk(nested(64));
    expect(depth(r.tree.components)).toBe(65); // the stage, then 64 levels
    expect(r.notes.some((n) => /nested more than/.test(n))).toBe(false);
  });

  it('leaves out what is deeper, says so, and can save what it kept', () => {
    const r = importOrk(nested(500));
    expect(depth(r.tree.components)).toBe(65);
    expect(r.notes).toContain('Components nested more than 64 levels deep were left out — no real '
      + 'design nests that far, so the file is probably damaged or crafted.');
    const saved = exportOrk({ name: 'Deep', tree: r.tree });
    expect(saved.length).toBeLessThan(500_000); // 5.7 MB at the old code
  });
});

describe('flight-configuration ids survive the exporter as XML', () => {
  // A configid is file-sourced free text kept verbatim as the stable key.
  // This one is legal in a .ork (`configid="Main &amp; backup"` and friends)
  // and breaks every unescaped interpolation: the bare & is not an entity, and
  // the quote closes the attribute.
  const WEIRD = 'Main & backup "<>';
  const MOTOR: OrkExportMotor = {
    designation: 'H128W', manufacturer: 'AeroTech', diameter: 0.029, length: 0.194, delay: 6,
  };
  const tree = {
    name: 'Cfg',
    components: [
      {
        type: 'stage', id: 'st1', name: 'Sustainer',
        children: [
          { type: 'bodytube', id: 'mount', motorMount: true, length: 0.3, outerRadius: 0.025, thickness: 0.001 },
          { type: 'parachute', id: 'chute', diameter: 0.6, deployEvent: 'apogee' },
        ],
      },
      {
        type: 'stage', id: 'st2', name: 'Booster',
        children: [{ type: 'bodytube', id: 'bt2', length: 0.2, outerRadius: 0.025, thickness: 0.001 }],
      },
    ] as unknown as ComponentNode[],
  };
  const configs: OrkExportConfig[] = [
    { id: WEIRD, name: 'A & B', isDefault: true, motors: { mount: MOTOR }, deployments: {}, separations: {} },
    {
      id: 'plain-2', name: null, isDefault: false, motors: { mount: MOTOR },
      deployments: { chute: { deployEvent: 'altitude', deployAltitude: 300 } },
      separations: { st2: { separationEvent: 'burnout' } },
    },
  ];
  const xml = exportOrk({
    name: 'Cfg', tree, motors: { mount: MOTOR }, configs, activeConfigId: WEIRD,
    launch: DEFAULT_CONDITIONS,
  });

  it('escapes the id at every one of the six emit sites', () => {
    expect(xml).not.toContain(WEIRD);
    // <motorconfiguration>, <deploymentconfiguration>, <separationconfiguration>,
    // <motor>, <ignitionconfiguration> attributes + the <configid> element.
    const escaped = 'Main &amp; backup &quot;&lt;&gt;';
    expect(xml.split(escaped).length - 1).toBe(6);
  });

  it('re-opens the file it just wrote, with the id intact', () => {
    // Declaration stripped exactly as importOrk strips it — this exporter
    // writes OpenRocket's single-quoted `<?xml version='1.0'?>`, which several
    // parsers (happy-dom's included) reject on sight.
    const doc = new DOMParser().parseFromString(xml.replace(/^<\?xml[^?]*\?>/, ''), 'text/xml');
    expect(doc.querySelector('parsererror')).toBeNull();
    expect(doc.querySelector('openrocket > rocket > motorconfiguration')
      ?.getAttribute('configid')).toBe(WEIRD);
    const back = importOrk(xml);
    expect(back.configs.map((c) => c.id)).toEqual([WEIRD, 'plain-2']);
    expect(back.chosenConfigId).toBe(WEIRD);
    expect(back.configs[0]!.name).toBe('A & B');
  });

  it('writes an id with a TAB, LF or CR so every attribute and the element read back alike', () => {
    // Raw, attribute-value normalisation reads TAB/LF/CR back as spaces, and
    // end-of-line handling reads a CR in the <configid> ELEMENT back as LF —
    // so the simulation named an id no configuration carried any more (audit
    // 2026-09-22). happy-dom applies neither step, so this reads the text the
    // way XML 1.0 says a parser must: end-of-line handling over the document
    // (§2.11), then for an attribute the whitespace normalisation of §3.3.3,
    // and only THEN the character references — which is why a reference
    // survives both.
    const eol = (s: string) => s.replace(/\r\n?/g, '\n');
    const refs = (s: string) => s.replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)))
      .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const readAttr = (raw: string) => refs(eol(raw).replace(/[\t\n]/g, ' '));
    const readText = (raw: string) => refs(eol(raw));
    const ID = 'Main\tbackup\nline\r2';
    // The reader is not a no-op: the raw id reads back as a different one.
    expect(readAttr(ID)).toBe('Main backup line 2');
    expect(readText(ID)).toBe('Main\tbackup\nline\n2');
    const out = exportOrk({
      name: 'Cfg', tree, motors: { mount: MOTOR }, activeConfigId: ID, launch: DEFAULT_CONDITIONS,
      configs: [{ ...configs[1]!, id: ID, isDefault: true }],
    });
    const attrs = [...out.matchAll(/configid="([^"]*)"/g)].map((m) => readAttr(m[1]!));
    // <motorconfiguration>, <motor>, <ignitionconfiguration> and
    // <separationconfiguration> (this deployment matches the default, so it
    // writes no <deploymentconfiguration>).
    expect(attrs).toEqual([ID, ID, ID, ID]);
    const els = [...out.matchAll(/<configid>([^<]*)<\/configid>/g)].map((m) => readText(m[1]!));
    expect(els).toEqual([ID]);
  });
});

describe("a transition's shoulder caps round-trip", () => {
  const TRANSITION = '<transition><name>Boat tail</name><length>0.05</length>'
    + '<foreradius>0.038</foreradius><aftradius>0.028</aftradius><thickness>0.0012192</thickness>'
    + '<shape>conical</shape>'
    + '<foreshoulderradius>0.027</foreshoulderradius><foreshoulderlength>0.02</foreshoulderlength>'
    + '<foreshouldercapped>false</foreshouldercapped>'
    + '<aftshoulderradius>0.0381</aftshoulderradius><aftshoulderlength>0.025</aftshoulderlength>'
    + '<aftshoulderthickness>0.0012192</aftshoulderthickness>'
    + '<aftshouldercapped>true</aftshouldercapped></transition>';

  it('reads a capped aft shoulder and leaves an uncapped fore one alone', () => {
    const t = flatten(importOrk(orkXml(TRANSITION)).tree.components)
      .find((n) => n.type === 'transition')!;
    expect(t['aftShoulderCapped']).toBe(true);
    expect(t['foreShoulderCapped']).toBeUndefined();
  });

  it('writes the cap the design has, not a hard-coded false', () => {
    // The literal `false` deleted the cap — a disc of 38.1 mm radius and
    // 1.22 mm wall, several grams — from the builder's own file on every save.
    const out = exportOrk({ name: 'T', tree: importOrk(orkXml(TRANSITION)).tree });
    expect(out).toContain('<aftshouldercapped>true</aftshouldercapped>');
    expect(out).toContain('<foreshouldercapped>false</foreshouldercapped>');
    // ...and it still says true after a second trip through both halves.
    const twice = flatten(importOrk(out).tree.components).find((n) => n.type === 'transition')!;
    expect(twice['aftShoulderCapped']).toBe(true);
  });
});

describe('an imported atmosphere is checked before it reaches the engine', () => {
  const withAtmosphere = (inner: string): string => orkXml(BODY_TUBE,
    `<simulations><simulation status="notsimulated"><name>Sim</name>
      <conditions><atmosphere model="extendedisa">${inner}</atmosphere></conditions>
    </simulation></simulations>`);
  const atmosphereNotes = (notes: string[]) =>
    notes.filter((n) => /launch site states/.test(n));

  it('takes a real launch site verbatim', () => {
    const r = importOrk(withAtmosphere(
      '<basetemperature>293.15</basetemperature><basepressure>101325.0</basepressure>'));
    expect(r.launch?.temperatureC).toBeCloseTo(20, 9);
    expect(r.launch?.pressureHPa).toBeCloseTo(1013.25, 9);
    expect(atmosphereNotes(r.notes)).toHaveLength(0);
  });

  it('takes the edges of the envelope the panel enforces', () => {
    const r = importOrk(withAtmosphere(
      '<basetemperature>213.15</basetemperature><basepressure>30000</basepressure>'));
    expect(r.launch?.temperatureC).toBeCloseTo(-60, 9);
    expect(r.launch?.pressureHPa).toBeCloseTo(300, 9);
    expect(atmosphereNotes(r.notes)).toHaveLength(0);
  });

  it('refuses hPa written into the pascal-valued element, and says so', () => {
    // 1013.25 Pa is 1 % of sea-level density: drag collapses and apogee is
    // overstated several times over.
    const r = importOrk(withAtmosphere(
      '<basetemperature>293.15</basetemperature><basepressure>1013.25</basepressure>'));
    expect(r.launch?.pressureHPa).toBeNull();
    expect(r.launch?.temperatureC).toBeCloseTo(20, 9);
    expect(atmosphereNotes(r.notes)).toHaveLength(1);
    expect(atmosphereNotes(r.notes)[0]).toMatch(/1013\.25 Pa/);
    expect(atmosphereNotes(r.notes)[0]).toMatch(/standard atmosphere/);
  });

  it('refuses Celsius written into the kelvin-valued element, and says so', () => {
    // 20 K puts the speed of sound near 90 m/s, so a subsonic flight would be
    // computed on supersonic drag.
    const r = importOrk(withAtmosphere(
      '<basetemperature>20</basetemperature><basepressure>101325.0</basepressure>'));
    expect(r.launch?.temperatureC).toBeNull();
    expect(r.launch?.pressureHPa).toBeCloseTo(1013.25, 9);
    expect(atmosphereNotes(r.notes)).toHaveLength(1);
    expect(atmosphereNotes(r.notes)[0]).toMatch(/20 K/);
  });

  it('still reads the ISA marker as "blank = standard"', () => {
    const r = importOrk(orkXml(BODY_TUBE,
      `<simulations><simulation status="notsimulated"><name>Sim</name>
        <conditions><atmosphere model="isa"/></conditions>
      </simulation></simulations>`));
    expect(r.launch?.temperatureC).toBeNull();
    expect(r.launch?.pressureHPa).toBeNull();
    expect(atmosphereNotes(r.notes)).toHaveLength(0);
  });
});

/**
 * THE REST OF THE LAUNCH ENVELOPE (audit 2026-09-22). The atmosphere above had
 * the panel's bounds since v0.105; rod angle and length, wind, altitude and
 * latitude were imported raw, and nothing downstream re-checks them — so a file
 * flew an 80° rail (the panel stops at 30°, desktop at 60°) or a negative rod
 * length. Each is now clamped into the panel's own range, with a note.
 */
describe('an imported launch site is held to the panel’s own bounds', () => {
  const withConditions = (inner: string): string => orkXml(BODY_TUBE,
    `<simulations><simulation status="notsimulated"><name>Sim</name>
      <conditions>${inner}</conditions>
    </simulation></simulations>`);
  const boundNotes = (notes: string[]) => notes.filter((n) => /field under Launch conditions accepts/.test(n));

  it('takes an ordinary launch site verbatim, with nothing to say', () => {
    const r = importOrk(withConditions('<launchrodlength>1.8</launchrodlength>'
      + '<launchrodangle>5</launchrodangle><launchaltitude>1190</launchaltitude>'
      + '<launchlatitude>32.9</launchlatitude><wind model="average"><speed>3</speed>'
      + '<standarddeviation>0.3</standarddeviation></wind>'));
    expect(r.launch).toMatchObject({
      launchRodLengthM: 1.8, launchRodAngleDeg: 5, launchAltitudeM: 1190, latitudeDeg: 32.9,
      windAverage: 3, windStdDev: 0.3,
    });
    expect(boundNotes(r.notes)).toHaveLength(0);
  });

  it('clamps a rail past the panel’s 30° and says what the file said', () => {
    const r = importOrk(withConditions('<launchrodangle>80</launchrodangle>'));
    expect(r.launch?.launchRodAngleDeg).toBe(30);
    expect(boundNotes(r.notes)).toEqual([
      "The file's launch rod angle is 80°, and the Rod angle field under Launch conditions accepts "
      + '-30° to 30° — imported as 30°. Change it there if you meant something else.',
    ]);
    expect(importOrk(withConditions('<launchrodangle>-45</launchrodangle>')).launch?.launchRodAngleDeg).toBe(-30);
  });

  it('refuses a negative rod length, altitude or gust spread, and a latitude off the globe', () => {
    const r = importOrk(withConditions('<launchrodlength>-2</launchrodlength>'
      + '<launchaltitude>-40</launchaltitude><launchlatitude>123</launchlatitude>'
      + '<wind model="average"><speed>2</speed><standarddeviation>-1</standarddeviation></wind>'));
    expect(r.launch).toMatchObject({
      launchRodLengthM: 0, launchAltitudeM: 0, latitudeDeg: 90, windStdDev: 0, windAverage: 2,
    });
    expect(boundNotes(r.notes)).toHaveLength(4);
    expect(boundNotes(r.notes).join('\n')).toMatch(/launch rod length is -2 m, .*accepts nothing below 0 m/);
    // Above the Site altitude field's top, too.
    expect(importOrk(withConditions('<launchaltitude>45720</launchaltitude>')).launch?.launchAltitudeM)
      .toBe(10000);
  });

  it('reads a negative wind as that speed the other way — desktop’s reading — not as calm', () => {
    // PinkNoiseWindModel.setAverage flips the direction and keeps the speed;
    // the speed is what moves the flight, so the magnitude is imported. The
    // legacy turbulence product is formed from the magnitude too, as desktop's.
    const r = importOrk(withConditions('<windaverage>-4</windaverage><windturbulence>0.1</windturbulence>'));
    expect(r.launch?.windAverage).toBe(4);
    expect(r.launch?.windStdDev).toBeCloseTo(0.4, 12);
    expect(r.notes.some((n) => /average wind is -4 m\/s.*imported as 4 m\/s/.test(n))).toBe(true);
  });

  // Review of 2026-09-23: desktop reads the file IN ORDER, and its saver
  // writes each direction AFTER its speed — so the flip setAverage makes is
  // undone by the direction that follows, and a desktop-saved negative wind
  // flies |speed| from the stated direction. The note said the drift pointed
  // the opposite way to the file's; it no longer claims a direction at all.
  it('says only what a negative wind flies as, not which way its drift points', () => {
    const r = importOrk(withConditions('<windaverage>-4</windaverage><winddirection>1.5707963267948966</winddirection>'
      + '<wind model="average"><speed>-4</speed><direction>1.5707963267948966</direction></wind>'));
    const note = r.notes.find((n) => /average wind is -4 m\/s/.test(n));
    expect(note).toBe('The file\'s average wind is -4 m/s, which desktop OpenRocket flies as 4 m/s; it was imported as 4 m/s.');
  });

  // The Rod aim is measured from the wind DESKTOP flies, replaying its reads
  // in file order: a negative speed with no direction after it has turned the
  // wind round (from π/2 to 3π/2, a west wind), and a rod leaning east (90°)
  // then leans DOWNWIND — aim 180, not 0.
  it('measures a manual rod direction from the wind desktop flies after a negative speed', () => {
    const aim = (inner: string) => importOrk(withConditions('<launchintowind>false</launchintowind>'
      + `<launchrodangle>5</launchrodangle><launchroddirection>90.0</launchroddirection>${inner}`)).launch?.launchRodAimDeg;
    expect(aim('<windaverage>-4</windaverage>')).toBe(180);
    // Two flips (the legacy element and the block) are no flip at all.
    expect(aim('<windaverage>-4</windaverage><wind model="average"><speed>-4</speed></wind>')).toBe(0);
    // A direction after the speed sets it, as desktop's saver always writes it.
    expect(aim('<windaverage>-4</windaverage><winddirection>1.5707963267948966</winddirection>')).toBe(0);
    // Last in file order wins, whichever element it is.
    expect(aim(`<wind model="average"><direction>${Math.PI}</direction></wind><winddirection>0</winddirection>`)).toBe(90);
  });
});
