import { describe, expect, it } from 'vitest';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { worker } from './index.js';
import { bytesOf } from './fixtures.testSupport.js';

/**
 * OUT OF SCOPE, recorded for the owner (cloud lane 23, question Q2). Owner ruling
 * 113-14a bounds the design's NAME; every other string a design file supplies is
 * still returned as the file states it. Each case below shows one such field
 * longer than the 200-code-point echo bound. If the owner rules these bounded
 * too, these expectations flip.
 */
const ctx = { waitUntil: (_p: Promise<unknown>) => {} };
const post = (route: string, filename: string, body: Uint8Array) => worker.fetch(
  new Request(`http://local${route}?filename=${encodeURIComponent(filename)}`, { method: 'POST', body: new Uint8Array(body).buffer }), undefined, ctx);
const LONG = 'L'.repeat(300);
const points = (text: string) => Array.from(text).length;
const reference = () => strFromU8(unzipSync(bytesOf('reference.ork'))['rocket.ork']!);
const ork = (xml: string) => zipSync({ 'rocket.ork': strToU8(xml) });

describe('file-derived strings other than the design name are not bounded (owner question Q2)', () => {
  it('/describe mounts[].name and mounts[].stageName', async () => {
    const xml = reference().replace('<name>Inner Tube</name>', `<name>${LONG}</name>`).replace(/(<stage>\s*<name>)Sustainer/, `$1${LONG}`);
    const out = await (await post('/describe', 'parts.ork', ork(xml))).json() as { mounts: { name: string; stageName: string }[] };
    expect(points(out.mounts[0]!.name)).toBe(300);
    expect(points(out.mounts[0]!.stageName)).toBe(300);
  });

  it('/experimental/fly motors[].mount', async () => {
    const xml = reference().replace('<name>Inner Tube</name>', `<name>${LONG}</name>`);
    const out = await (await post('/experimental/fly', 'mount.ork', ork(xml))).json() as { motors: { mount: string }[] };
    expect(points(out.motors[0]!.mount)).toBe(300);
  }, 60_000);

  it('/experimental/fly warnings[].message quotes component names', async () => {
    const rkt = strFromU8(bytesOf('TubeFins2.rkt')).replace('<Name>Nose cone</Name>', `<Name>${LONG}</Name>`);
    const out = await (await post('/experimental/fly', 'TubeFins2.rkt', strToU8(rkt))).json() as { warnings: { message: string }[] };
    expect(out.warnings.some(w => w.message.includes(LONG))).toBe(true);
  }, 60_000);

  it('a quoted motor designation in notes and in a 422 importNote', async () => {
    const xml = reference().replace('<designation>C6</designation>', `<designation>${LONG}</designation>`);
    const response = await post('/experimental/fly', 'motor.ork', ork(xml));
    const out = await response.json() as { error?: { importNote: { text: string } }; notes?: { import: { text: string } } };
    const note = out.error?.importNote.text ?? out.notes!.import.text;
    expect(note).toContain(`“${LONG}”`);
  }, 60_000);
});
