import { spawnSync } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { aerotechDocumentLinks, rowsByPart, materialDensityIn, checkHead, checkThrustCurve, checkMotorCorrections, main, checkOpenMeteoTerms } from '../../../scripts/check-upstream.mjs';
import { parseOrc } from './fetch-component-presets.mjs';

// check-upstream sends thrustcurve.org requests through the paced client, one
// per 5 s. These tests stub globalThis.fetch and judge what the script does
// with each answer, not the pace, so the client is a pass-through here that
// records what reached it (the pace itself: thrustcurve-client.test.mjs).
const paced = vi.hoisted(() => []);
vi.mock('./thrustcurve-client.mjs', async (importOriginal) => ({
  ...(await importOriginal()),
  thrustcurveFetch: (url, init) => { paced.push(String(url)); return globalThis.fetch(url, init); },
}));

afterEach(() => vi.restoreAllMocks());

it('sends thrustcurve.org requests, and only those, through the paced client', async () => {
  // Through main(), as the other checks here run, so its per-run state (failedHosts and the
  // rest) is reset rather than left behind, and on fake timers so its 250 ms pause never waits.
  vi.useFakeTimers();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const fetcher = vi.fn(async () => ({ ok: false, status: 404 }));
  vi.stubGlobal('fetch', fetcher);
  paced.length = 0;
  try {
    const run = main([() => checkThrustCurve(), () => checkHead()], () => {});
    await vi.runAllTimersAsync();
    await run;
    const tc = fetcher.mock.calls.map(([url]) => String(url)).filter((url) => new URL(url).hostname === 'www.thrustcurve.org');
    expect(tc.length).toBeGreaterThan(0);
    expect(paced).toEqual(tc);
    expect(fetcher.mock.calls.some(([url]) => new URL(String(url)).hostname === 'api.github.com')).toBe(true);
  } finally { vi.useRealTimers(); vi.unstubAllGlobals(); }
});

it.each(['@click', 'x-on:click.prevent', 'data-foo.bar', 'data.foo'])('accepts valid HTML attribute %s and apostrophes in unquoted values', name => {
  expect(aerotechDocumentLinks(`<a ${name}="x" href="/real.pdf">real</a>`, 'https://example.test/'))
    .toEqual(['https://example.test/real.pdf']);
});

it('accepts an apostrophe in an unquoted HTML attribute value', () => {
  expect(aerotechDocumentLinks('<a title=it\'s href="/real.pdf">real</a>', 'https://example.test/'))
    .toEqual(['https://example.test/real.pdf']);
});

it('accepts dotted XML attributes in preset records', () => {
  expect(() => parseOrc('<Components><BodyTube extra.note="x"/></Components>', 'valid.orc', new Map())).not.toThrow();
});

it.each(['page', 'catalogue population'])('stops after thrustcurve.org signals a rate limit with 403 at %s', async source => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const later = vi.fn();
  const fetcher = vi.fn(async () => ({ ok: false, status: 403 }));
  vi.stubGlobal('fetch', fetcher);
  try {
    const check = source === 'page' ? () => checkMotorCorrections() : () => checkThrustCurve();
    expect(await main([check, later], () => {})).toBe(2);
    expect(later).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledOnce();
  } finally { vi.unstubAllGlobals(); }
});

it.each(['pauses', 'caches'])('%s failed host requests and failed ORC files for the run', async check => {
  vi.useFakeTimers();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const requests = [];
  vi.stubGlobal('fetch', async url => {
    requests.push({ url, at: Date.now() });
    return { ok: false, status: 503 };
  });
  try {
    const run = main(undefined, () => {});
    await vi.runAllTimersAsync();
    expect(await run).toBe(2);
    const hosts = new Map();
    for (const request of requests) {
      const host = new URL(request.url).host;
      if (check === 'pauses' && hosts.has(host)) expect(request.at - hosts.get(host)).toBeGreaterThanOrEqual(250);
      hosts.set(host, request.at);
    }
    const orc = requests.filter(r => /\.orc$/i.test(r.url)).map(r => r.url);
    expect(orc.length).toBeGreaterThan(0);
    if (check === 'caches') expect(new Set(orc).size).toBe(orc.length);
  } finally { vi.useRealTimers(); vi.unstubAllGlobals(); }
});

it('reads live ORC rows, ignoring comments, PI and CDATA markup', () => {
  const tube = n => `<BodyTube><PartNumber>BT-50</PartNumber><OutsideDiameter>${n}</OutsideDiameter></BodyTube>`;
  const xml = `<Components>${tube('0.976')}<!--${tube('9.9')}--><![CDATA[${tube('8.8')}]]><?example ${tube('7.7')}?></Components>`;
  expect(rowsByPart(xml, 'BodyTube').get('BT-50')('OutsideDiameter')).toBe('0.976');
});

it('reads live ORC material density rather than a commented example', () => {
  const material = n => `<Material><Name>Kraft</Name><Density>${n}</Density></Material>`;
  expect(materialDensityIn(`<!--${material('0.5')}--><Materials>${material('0.95')}</Materials>`, 'Kraft')).toBe('0.95');
});

it('keeps the original first-field semantics when an ORC record repeats a field', () => {
  const xml = '<BodyTube><PartNumber>T</PartNumber><OutsideDiameter>1</OutsideDiameter><OutsideDiameter>2</OutsideDiameter></BodyTube>';
  expect(rowsByPart(xml, 'BodyTube').get('T')('OutsideDiameter')).toBe('1');
  expect(materialDensityIn('<Material><Name>Kraft</Name><Density>0.95</Density><Density>0.5</Density></Material>', 'Kraft')).toBe('0.95');
});

it.each(['BodyTube', 'Material'])('refuses unclosed ORC %s records in one forward scan', tag => {
  const xml = `<${tag}>`.repeat(20_000);
  expect(() => tag === 'Material' ? materialDensityIn(xml, 'Kraft') : rowsByPart(xml, tag)).toThrow(/unclosed/i);
});

it.each([null, {}, { results: null }, { results: [null] }])('reports changed motor search shape without claiming corrections were withdrawn: %j', async body => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await main([() => checkMotorCorrections(async () => body)], () => {})).toBe(2);
  expect(error.mock.calls.flat().join('\n')).toMatch(/search.*shape/i);
  expect(log.mock.calls.flat().join('\n')).not.toMatch(/withdrawn|retire or re-key/i);
});

it.each([
  [null, []], [[], []], [[{ sha: 1 }], []],
  [[{ sha: 'abcdef', commit: { author: { date: 'today' }, message: 'subject' } }], {}],
  [[{ sha: 'abcdef', commit: { author: { date: 'today' }, message: 'subject' } }], [null]],
])('gives a GitHub shape diagnostic rather than a TypeError', async (commits, issues) => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const get = vi.fn().mockResolvedValueOnce(commits).mockResolvedValueOnce(issues);
  await expect(checkHead(get)).rejects.toThrow(/GitHub.*shape/i);
});

it.each([{}, { manufacturers: [null] }])('flags metadata shape changes and completes later checks', async meta => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const later = vi.fn();
  const status = await main([() => checkThrustCurve(async url => url.includes('metadata') ? meta : { matches: 1 }), later], () => {});
  expect(status).toBe(1);
  expect(later).toHaveBeenCalledOnce();
  expect(log.mock.calls.flat().join('\n')).toMatch(/metadata.*shape/i);
});

it('continues independent checks after a page cannot be parsed, preserving exit 2', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const later = vi.fn();
  expect(await main([() => checkOpenMeteoTerms(async () => '<!--'), later], () => {})).toBe(2);
  expect(later).toHaveBeenCalledOnce();
});

it.each(['page', 'catalogue population'])('stops requests after an HTTP 429 from %s', async source => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const later = vi.fn();
  const fetcher = vi.fn(async () => ({ ok: false, status: 429 }));
  vi.stubGlobal('fetch', fetcher);
  try {
    expect(await main([source === 'page' ? () => checkOpenMeteoTerms() : () => checkThrustCurve(), later], () => {})).toBe(2);
    expect(later).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledOnce();
  } finally { vi.unstubAllGlobals(); }
});

it('extracts links after a long HTML boolean attribute within a bounded subprocess', () => {
  const module = new URL('../../../scripts/check-upstream.mjs', import.meta.url).href;
  const probe = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { aerotechDocumentLinks } from ${JSON.stringify(module)}; const links = aerotechDocumentLinks('<a ' + 'x'.repeat(250000) + ' href="/real.pdf">real</a>', 'https://example.test/'); if (links[0] !== 'https://example.test/real.pdf') process.exit(1);`], { timeout: 3000 });
  expect(probe.error).toBeUndefined();
  expect(probe.status).toBe(0);
});

it.each(['Components', 'BodyTube', 'Manufacturer'])('refuses bare XML attributes on %s', tag => {
  const bad = `<${tag} ${'x'.repeat(8000)}>${tag === 'Components' ? '<BodyTube/>' : 'Home'}</${tag}>`;
  const xml = tag === 'Components' ? bad : `<Components>${tag === 'BodyTube' ? bad : `<BodyTube>${bad}</BodyTube>`}</Components>`;
  expect(() => parseOrc(xml, 'bad.orc', new Map())).toThrow(/attribute/i);
});
