// @vitest-environment happy-dom
/**
 * Digest census — a MEASUREMENT DRIVER, not a test (the lemivSweep pattern).
 * Inert in CI and in `npm test`: it skips unless DIGEST_CENSUS names the
 * manifest scripts/digest-census.mjs writes, which also downloads the raw
 * data files it reads. Run it through that script:
 *
 *   node packages/app/scripts/digest-census.mjs
 *
 * For every motor reference with a `<digest>` in every design it is given, it
 * asks what this app flies today — the app's own importer and matcher pick
 * the catalogue motor, pickSampleFile picks that motor's bundled file — and
 * compares the digest of every bundled file of that motor (motorDigest.ts,
 * over the raw file) with the stored one:
 *   MATCH     the stored digest is the flown file's (or one with the same digest);
 *   MISMATCH  it is another bundled file of the same motor — the app flies a
 *             different curve than desktop did;
 *   OTHER     it is a bundled file of ANOTHER catalogue motor — the app matched
 *             a different motor than desktop loaded;
 *   NONE      no bundled file has it (a file changed or withdrawn upstream, or
 *             a desktop-only motor);
 *   UNMATCHED the app loads no catalogue motor for the reference.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { strFromU8 } from 'fflate';
import { importOrk, type OrkMotorRef } from './orkFile.js';
import { matchImportedMotor } from './motorMatch.js';
import { bundledOnlyFetchSpec, bundledSimFiles, fileImpulseNs, flownCurve, headerMasses, pickSampleFile, type TcMotor } from './thrustcurve.js';
import { digestMotorFile } from './motorDigest.js';
import { gunzipCapped, unzipMember } from './zipMember.js';

const MANIFEST = process.env['DIGEST_CENSUS'];

interface Manifest {
  files: { path: string; corpus: string; sha256: string }[];
  raw: string;
  results: string;
}
interface RawFile { motorId: string; format?: string; source?: string; data: string }

type Verdict = 'MATCH' | 'MISMATCH' | 'OTHER' | 'NONE' | 'UNMATCHED';

/** The file's XML, for the two things importOrk does not report: its version and its raw digests. */
function xmlOf(bytes: Uint8Array): string {
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return strFromU8(unzipMember(bytes, '.ork', '.ork'));
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) return strFromU8(gunzipCapped(bytes, '.ork'));
  return strFromU8(bytes);
}

describe.skipIf(!MANIFEST)('digest census', () => {
  it('measures', { timeout: 1_800_000 }, async () => {
    const manifest = JSON.parse(readFileSync(MANIFEST!, 'utf8')) as Manifest;
    const raw = JSON.parse(readFileSync(manifest.raw, 'utf8')) as Record<string, RawFile>;

    // Every raw file's digest, and the reverse index over the whole bundle.
    const digestOf = new Map<string, string[]>();
    const owners = new Map<string, { motorId: string; simfileId: string }[]>();
    for (const [simfileId, f] of Object.entries(raw)) {
      const d = digestMotorFile(Buffer.from(f.data, 'base64').toString('latin1'), f.format);
      digestOf.set(simfileId, d);
      for (const x of d) owners.set(x, [...(owners.get(x) ?? []), { motorId: f.motorId, simfileId }]);
    }

    const seen = new Set<string>();
    const rows: Record<string, unknown>[] = [];
    const designs: Record<string, unknown>[] = [];
    for (const file of manifest.files) {
      // Byte-identical copies count once. A renamed or re-saved copy of one
      // design (LEM-IV.ork and its "(1)", "(2)") is another file and counts
      // again, so every "designs" count below is a count of FILES.
      if (seen.has(file.sha256)) continue;
      seen.add(file.sha256);
      const bytes = new Uint8Array(readFileSync(file.path));
      let xml: string;
      let result: ReturnType<typeof importOrk>;
      try {
        xml = xmlOf(bytes);
        result = importOrk(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
      } catch (e) {
        designs.push({ path: file.path, error: String(e) });
        continue;
      }
      const version = /<openrocket[^>]*\bversion="([\d.]+)"/.exec(xml)?.[1] ?? '?';
      const rawDigests = (xml.match(/<digest>[^<]*<\/digest>/g) ?? []).length;
      designs.push({ path: file.path, corpus: file.corpus, version, rawDigests });

      // Every configuration's motors, once per (mount, motor, digest).
      const refs = new Map<string, OrkMotorRef>();
      const all = result.configs.length ? result.configs.map((c) => c.motors) : [result.motors];
      for (const motors of all) {
        for (const [mount, ref] of Object.entries(motors)) {
          if (!ref.digest) continue;
          refs.set(`${mount}|${ref.manufacturer}|${ref.designation}|${ref.digest}`, ref);
        }
      }
      for (const ref of refs.values()) {
        let chosen: TcMotor | null = null;
        await matchImportedMotor(ref, {
          fetchSpec: async (m, d) => {
            chosen = m;
            return bundledOnlyFetchSpec(m, d);
          },
        }).catch(() => null);
        const row: Record<string, unknown> = {
          path: file.path, version, manufacturer: ref.manufacturer, designation: ref.designation, digest: ref.digest,
        };
        rows.push(row);
        const motor = chosen as TcMotor | null;
        if (!motor) { row.verdict = 'UNMATCHED' satisfies Verdict; continue; }
        const files = await bundledSimFiles(motor.motorId);
        const flown = pickSampleFile(files, motor);
        row.motorId = motor.motorId;
        row.matched = `${motor.manufacturerAbbrev} ${motor.designation}`;
        row.flown = flown?.simfileId;
        row.files = files.map((f) => ({ simfileId: f.simfileId, format: f.format, source: f.source, digests: digestOf.get(f.simfileId ?? '') ?? null }));
        const has = (id: string | undefined) => !!id && (digestOf.get(id) ?? []).includes(ref.digest!);
        const impulse = (f: (typeof files)[number] | undefined | null) =>
          f?.samples ? Math.round(fileImpulseNs({ samples: flownCurve(f.samples).samples }) * 10) / 10 : null;
        if (has(flown?.simfileId)) {
          row.verdict = 'MATCH' satisfies Verdict;
        } else if (files.some((f) => has(f.simfileId))) {
          const named = files.find((f) => has(f.simfileId))!;
          row.verdict = 'MISMATCH' satisfies Verdict;
          row.digestFile = named.simfileId;
          row.flownNs = impulse(flown);
          row.digestNs = impulse(named);
          // Two files desktop tells apart (an .rse's per-sample masses or CGs
          // are in its digest) can fly identically here, which reads only the
          // samples and the two header masses.
          // Masses to a part in 10^9, as pickSampleFile compares them: 1,400 g
          // and 1,400.0000000000002 g are one mass.
          const a = headerMasses(flown!), b = headerMasses(named);
          const near = (x: number, y: number) => Math.abs(x - y) <= 1e-9 * Math.max(Math.abs(x), Math.abs(y));
          row.sameFlight = JSON.stringify(flownCurve(flown!.samples!).samples) === JSON.stringify(flownCurve(named.samples!).samples)
            && (a === null || b === null ? a === b
              : near(a.totalWeightG, b.totalWeightG) && near(a.propWeightG, b.propWeightG));
          row.flownMasses = headerMasses(flown!);
          row.digestMasses = headerMasses(named);
        } else if (owners.has(ref.digest!)) {
          row.verdict = 'OTHER' satisfies Verdict;
          row.digestOwners = owners.get(ref.digest!);
        } else {
          row.verdict = 'NONE' satisfies Verdict;
        }
      }
    }

    const count = (v: Verdict) => rows.filter((r) => r.verdict === v).length;
    const designsWith = (v: Verdict) => new Set(rows.filter((r) => r.verdict === v).map((r) => r.path)).size;
    // `distinctDesigns` and every `designs` are distinct FILES (by bytes), not
    // distinct designs: see the copies note above. Quote them as files.
    const summary = {
      files: manifest.files.length,
      distinctDesigns: seen.size,
      designsWithDigests: new Set(rows.map((r) => r.path)).size,
      // "1.10" is later than "1.4": compare minor numbers, not decimals.
      digestsDroppedPre14: designs.filter((d) => /^1\.[0-3]$/.test(String(d.version)) && (d.rawDigests as number) > 0).length,
      unreadable: designs.filter((d) => d.error).length,
      motorsWithDigest: rows.length,
      mismatchFlyingDifferently: {
        motors: rows.filter((r) => r.verdict === 'MISMATCH' && !r.sameFlight).length,
        designs: new Set(rows.filter((r) => r.verdict === 'MISMATCH' && !r.sameFlight).map((r) => r.path)).size,
      },
      ...Object.fromEntries((['MATCH', 'MISMATCH', 'OTHER', 'NONE', 'UNMATCHED'] as const).map((v) => [v, { motors: count(v), designs: designsWith(v) }])),
    };
    writeFileSync(manifest.results, JSON.stringify({ summary, rows, designs }, null, 2));
    console.log(JSON.stringify(summary, null, 2));
    for (const r of rows.filter((x) => x.verdict !== 'MATCH')) {
      console.log([r.verdict, r.path, r.manufacturer, r.designation, r.digest, r.matched ?? '', r.flown ?? '', r.digestFile ?? '',
        r.flownNs ?? '', r.digestNs ?? ''].join('\t'));
    }
    expect(rows.length).toBeGreaterThanOrEqual(0);
  });
});
