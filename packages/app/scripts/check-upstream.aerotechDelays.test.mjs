import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { aerotechDocumentLinks, checkAerotechDelays, main } from '../../../scripts/check-upstream.mjs';

// Reduced source-page fixture: the E35W/F41W anchors read on 2026-10-13.
const page = readFileSync(new URL('./fixtures/aerotech-delays/certification-index.html', import.meta.url), 'utf8');
const urls = [
  'https://d3l66gvjdr7rqw.cloudfront.net/Templates/170652/myimages/e35w%20cert%20letter_1656515459910.pdf',
  'https://d3l66gvjdr7rqw.cloudfront.net/Templates/170652/myimages/f41w%20tra%20cert_1695852343563.pdf',
];
const bytes = Buffer.from('%PDF-1.3\nfixture certification bytes');
const snapshot = {
  publishedOn: 'https://www.rocketmotorparts.com/page/nar-tra-certification-docs',
  indexPdfUrls: urls,
  documents: [{ document: 'TRA/Test/E35W.pdf', url: urls[0], sha256: createHash('sha256').update(bytes).digest('hex') }],
};
const shipped = JSON.parse(readFileSync(new URL('./aerotech-delay-sources.json', import.meta.url), 'utf8'));
const delays = JSON.parse(readFileSync(new URL('../src/data/aerotechDelays.json', import.meta.url), 'utf8'));
const review = JSON.parse(readFileSync(new URL('./aerotech-delay-transcriptions.json', import.meta.url), 'utf8'));

async function watch(html = page, body = bytes, baseline = snapshot) {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const getText = vi.fn(async () => html);
  const getBytes = vi.fn(async () => body);
  try {
    const status = await main([() => checkAerotechDelays(getText, getBytes, baseline)], () => {});
    return { status, output: log.mock.calls.flat().join('\n'), getText, getBytes };
  } finally { log.mockRestore(); }
}

describe('AeroTech published delay source watch (offline)', () => {
  it('reads only PDF hrefs, normalizes spaces/entities, and ignores labels and unrelated navigation', () => {
    expect(aerotechDocumentLinks(page, snapshot.publishedOn)).toEqual(urls);
    expect(aerotechDocumentLinks('<a href="/new motor.pdf?a=1&amp;b=2">motor</a>', snapshot.publishedOn))
      .toEqual(['https://www.rocketmotorparts.com/new%20motor.pdf?a=1&b=2']);
    expect(() => aerotechDocumentLinks('<html>bot challenge</html>', snapshot.publishedOn)).toThrow('no certification PDF links');
  });

  it('accepts unchanged links and document bytes without writing any file', async () => {
    const result = await watch();
    expect(result.status).toBe(0);
    expect(result.output).toContain('unchanged');
    expect(result.getText).toHaveBeenCalledWith(snapshot.publishedOn);
    expect(result.getBytes).toHaveBeenCalledWith(urls[0]);
  });

  it.each([
    ['same path', urls[0].replace('d3l66gvjdr7rqw.cloudfront.net', 'old.example.test')],
    ['S3 bucket path', urls[0].replace('d3l66gvjdr7rqw.cloudfront.net', 's3.eu-west-1.amazonaws.com/static.fw1.biz')],
  ])('reports a host move quietly (%s) and checks the bytes at the current URL', async (_kind, oldUrl) => {
    const baseline = {
      ...snapshot,
      indexPdfUrls: [oldUrl, urls[1]],
      documents: [{ ...snapshot.documents[0], url: oldUrl }],
    };
    const result = await watch(page, bytes, baseline);
    expect(result.status).toBe(0);
    expect(result.output).toContain('note  AeroTech certification index: 1 PDF host move');
    expect(result.output).not.toContain('ADDED');
    expect(result.output).not.toContain('REMOVED');
    expect(result.output).toContain('source bytes unchanged');
    expect(result.getBytes).toHaveBeenCalledWith(urls[0]);

    const changed = await watch(page, Buffer.from('%PDF-1.3\nchanged after host move'), baseline);
    expect(changed.status).toBe(1);
    expect(changed.output).toContain(`source bytes changed at ${urls[0]}`);
  });

  it('separates six S3 host moves from the two genuinely new certificates', async () => {
    const oldUrls = Array.from({ length: 6 }, (_, i) => `https://s3.eu-west-1.amazonaws.com/static.fw1.biz/Templates/170652/myimages/motor-${i}.pdf`);
    const liveUrls = Array.from({ length: 6 }, (_, i) => `https://d3l66gvjdr7rqw.cloudfront.net/Templates/170652/myimages/motor-${i}.pdf`);
    const html = [...liveUrls, 'https://web.archive.org/g35w.pdf', 'https://web.archive.org/j135w.pdf']
      .map((url) => `<a href="${url}">Certificate</a>`).join('');
    const result = await watch(html, bytes, { ...snapshot, indexPdfUrls: oldUrls, documents: [] });
    expect(result.status).toBe(1);
    expect(result.output).toContain('note  AeroTech certification index: 6 PDF host moves');
    expect(result.output).toContain('index changed: 2 added, 0 removed');
    expect(result.output).toContain('ADDED https://web.archive.org/g35w.pdf');
    expect(result.output).toContain('ADDED https://web.archive.org/j135w.pdf');
    expect(result.output).not.toContain('REMOVED');
  });

  it.each([
    ['directory', 'https://new.example.test/another/certificate.pdf'],
    ['query', 'https://new.example.test/certificates/certificate.pdf?revision=2'],
    ['port', 'https://new.example.test:8443/certificates/certificate.pdf'],
  ])('keeps a changed %s flagged even when the filename and host change together', async (_kind, liveUrl) => {
    const oldUrl = 'https://old.example.test/certificates/certificate.pdf';
    const result = await watch(`<a href="${liveUrl}">Certificate</a>`, bytes,
      { ...snapshot, indexPdfUrls: [oldUrl], documents: [] });
    expect(result.status).toBe(1);
    expect(result.output).toContain('1 added, 1 removed');
    expect(result.output).not.toContain('host move');
  });

  it('does not guess host moves when multiple links name the same asset path', async () => {
    const result = await watch('<a href="https://new.example.test/certificate.pdf">Certificate</a>', bytes,
      { ...snapshot, indexPdfUrls: ['https://old.example.test/certificate.pdf', 'https://other.example.test/certificate.pdf'], documents: [] });
    expect(result.status).toBe(1);
    expect(result.output).toContain('1 added, 2 removed');
    expect(result.output).not.toContain('host move');
  });

  it('returns MOVED for an added PDF, a removed PDF and a changed linked URL', async () => {
    const result = await watch(page.replace(urls[0], 'https://example.test/revised.pdf'));
    expect(result.status).toBe(1);
    expect(result.output).toContain('1 of 1 watched value(s) MOVED:');
    expect(result.output).toContain('ADDED https://example.test/revised.pdf');
    expect(result.output).toContain(`REMOVED ${urls[0]}`);
    expect(result.getBytes).not.toHaveBeenCalled();
  });

  it('includes index-link drift in the final MOVED summary', async () => {
    const result = await watch(page.replace(urls[0], 'https://example.test/revised.pdf'));
    const summary = result.output.slice(result.output.indexOf('watched value(s) MOVED:'));
    expect(summary).toContain('\n  - AeroTech certification index changed: 1 added, 1 removed');
  });

  it.each([
    ['added', `${page}<a href="https://example.test/new.pdf">New certificate</a>`, 'ADDED https://example.test/new.pdf', '1 of 2'],
    ['removed', page.replace(urls[0], 'https://example.test/navigation'), `REMOVED ${urls[0]}`, '1 of 1'],
  ])('counts an index with only %s links as one moved value', async (_kind, html, detail, counts) => {
    const result = await watch(html);
    expect(result.status).toBe(1);
    expect(result.output).toContain(`${counts} watched value(s) MOVED:`);
    expect(result.output).toContain(detail);
    expect(result.output).toContain('\n  - AeroTech certification index changed:');
  });

  it('returns MOVED when a PDF changes at the same URL', async () => {
    const result = await watch(page, Buffer.from('%PDF-1.3\ncorrected delay measurements'));
    expect(result.status).toBe(1);
    expect(result.output).toContain('source bytes changed');
    expect(result.output).toContain('TRA/Test/E35W.pdf');
  });

  it('starts each invocation with fresh verdict counts', async () => {
    expect((await watch(page, Buffer.from('%PDF-1.3\nchanged'))).status).toBe(1);
    const unchanged = await watch();
    expect(unchanged.status).toBe(0);
    expect(unchanged.output).toContain('All 2 watched value(s)');
  });

  it('reports unreadable source as unavailable, not unchanged or MOVED', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await watch('<html>bot challenge</html>')).status).toBe(2);
      expect((await watch(page, Buffer.from('<html>not a PDF</html>'))).status).toBe(2);
    } finally { error.mockRestore(); }
  });

  it('reads PDF response bytes through the bounded transport and rejects HTTP errors and oversized responses', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    try {
      fetch.mockResolvedValueOnce(new Response(bytes));
      expect(await main([() => checkAerotechDelays(async () => page, undefined, snapshot)], () => {})).toBe(0);
      expect(fetch).toHaveBeenCalledWith(urls[0], expect.objectContaining({ signal: expect.any(AbortSignal) }));
      fetch.mockResolvedValueOnce(new Response('unavailable', { status: 404 }));
      expect(await main([() => checkAerotechDelays(async () => page, undefined, snapshot)], () => {})).toBe(2);
      expect(error.mock.calls.flat().join('\n')).toContain('HTTP 404');
      fetch.mockResolvedValueOnce(new Response(new Uint8Array(2_000_001)));
      expect(await main([() => checkAerotechDelays(async () => page, undefined, snapshot)], () => {})).toBe(2);
      expect(error.mock.calls.flat().join('\n')).toContain('PDF exceeds 2 MB');
    } finally {
      vi.unstubAllGlobals();
      error.mockRestore();
      log.mockRestore();
    }
  });

  it('watches every shipped band source and each withheld scan with individual samples', () => {
    const required = [...Object.values(delays.motors), ...review.unread.filter((e) => e.candidateDelays)];
    const documents = new Map(shipped.documents.map((d) => [d.document, d]));
    expect(documents.size).toBe(shipped.documents.length);
    for (const entry of required) {
      const watched = documents.get(entry.document);
      expect(watched, entry.document).toBeDefined();
      expect(watched.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(shipped.indexPdfUrls).toContain(watched.url);
      if (entry.url) expect(watched.url).toBe(entry.url);
      if (entry.sha256) expect(watched.sha256).toBe(entry.sha256);
    }
  });

  it('keeps unchecked candidates out of the shipped bands and derives review counts from the inventory', () => {
    expect(delays.scanReview.reviewed).toBe(review.documents.length + review.unread.length);
    expect(delays.scanReview.accepted).toBe(review.documents.length);
    expect(delays.scanReview.unreadForMerge).toBe(review.unread.length);
    expect(delays.scanReview.unreadForMerge).toBe(delays.documents.scan);
    const shippedPaths = new Set(Object.values(delays.motors).map((m) => m.document));
    for (const entry of review.unread) {
      expect(entry.reason.length).toBeGreaterThan(0);
      expect(shippedPaths.has(entry.document), entry.document).toBe(false);
    }
  });
});
