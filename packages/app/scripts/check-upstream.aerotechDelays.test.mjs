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

async function watch(html = page, body = bytes) {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const getText = vi.fn(async () => html);
  const getBytes = vi.fn(async () => body);
  try {
    const status = await main([() => checkAerotechDelays(getText, getBytes, snapshot)], () => {});
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

  it('returns MOVED for an added PDF, a removed PDF and a changed linked URL', async () => {
    const result = await watch(page.replace(urls[0], 'https://example.test/revised.pdf'));
    expect(result.status).toBe(1);
    expect(result.output).toContain('ADDED https://example.test/revised.pdf');
    expect(result.output).toContain(`REMOVED ${urls[0]}`);
    expect(result.getBytes).not.toHaveBeenCalled();
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
    const shippedPaths = new Set(Object.values(delays.motors).map((m) => m.document));
    for (const entry of review.unread) {
      expect(entry.reason.length).toBeGreaterThan(0);
      expect(shippedPaths.has(entry.document), entry.document).toBe(false);
    }
  });
});
