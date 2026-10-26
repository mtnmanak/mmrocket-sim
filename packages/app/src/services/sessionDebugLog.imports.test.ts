// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { zipSync } from 'fflate';
import { createSessionDebugLog, MAX_DEBUG_LOG_BYTES, sessionDebugLog } from './sessionDebugLog.js';
import { importMotorFiles } from './importMotorFiles.js';
import { EX_IMPORT_BYTES_NOTE, EX_SAMPLE_LIMIT_NOTE, MAX_EX_MOTOR_SAMPLES } from './exMotorLimits.js';
import { MAX_MACH_ALT_ROWS } from './machAltLimits.js';
import { importOrk } from './orkFile.js';
import { importRkt } from './rocksimFile.js';
import { importCdx1 } from './rasaeroFile.js';
import { parseRse } from './exMotors.js';
import { decodeShareFragment } from './shareLink.js';
import { gunzipCapped, unzipMember } from './zipMember.js';
import { currentXmlParser, setXmlParser, XmlParseError } from './xmlParse.js';
import { jsXmlParser } from './xmlParseJs.js';

const parser = currentXmlParser();
afterEach(() => setXmlParser(parser));

async function refusal(run: () => unknown): Promise<Error> {
  try { await run(); } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error('Expected importer refusal');
}

function logged(error: Error): string {
  const log = createSessionDebugLog();
  log.record('import-failed', error);
  return log.text();
}

describe('C-H3 real import diagnostics', () => {
  it.each([
    EX_IMPORT_BYTES_NOTE,
    `Mach-Alt table exceeds the limit of ${MAX_MACH_ALT_ROWS.toLocaleString('en-US')} distinct rows.`,
  ])('round1 retains the count-only limit refusal: %s', message => {
    expect(logged(new Error(message))).toContain(`import-failed: Error: ${message}`);
    expect(logged(new Error(`${message} Private Fairbanks 61.234`))).toContain('Message omitted for privacy');
  });

  it('round1 retains the distinct-point refusal category without the motor name', async () => {
    const out = await importMotorFiles([new File([
      'Private 18 70 P 0.01 0.02 PrivateMaker\n0 10\n0 10',
    ], 'Private Fairbanks.eng')]);
    expect(out.parsed).toEqual([]);
    const event = sessionDebugLog.text().trim().split('\n').at(-1)!;
    expect(event).toContain('Motor import refused: fewer than two distinct thrust points (file detail omitted)');
    expect(event).not.toContain('Private');
    expect(event).not.toContain('Fairbanks');
  });

  it.each(['.eng', '.rse'])('retains the %s thrust sample-limit refusal without private fields', async extension => {
    // Happy-dom's selector truncates 100,001 siblings to 65,536; use the real JS parser to reach the cap.
    if (extension === '.rse') setXmlParser(jsXmlParser);
    const samples = Array.from({ length: MAX_EX_MOTOR_SAMPLES + 1 }, (_, i) => extension === '.eng'
      ? `${i} 61.234` : `<eng-data t="${i}" f="61.234"/>`).join('\n');
    const source = extension === '.eng'
      ? `Private 18 70 P 0.01 0.02 PrivateMaker\n${samples}`
      : `<engine-database><engine-list><engine code="Private Fairbanks" mfg="PrivateMaker" initWt="20" propWt="10" dia="18" len="70"><data>${samples}</data></engine></engine-list></engine-database>`;
    const out = await importMotorFiles([new File([source], `Private Fairbanks 61.234${extension}`)]);
    expect(out.parsed).toHaveLength(0);
    expect(out.write).toBeNull();
    expect(out.error).toContain(EX_SAMPLE_LIMIT_NOTE);
    const text = sessionDebugLog.text();
    const event = text.trim().split('\n').at(-1)!;
    for (const secret of ['Private', 'Fairbanks', '61.234', 'PrivateMaker', '<engine', '<eng-data', '.eng', '.rse']) {
      expect(text).not.toContain(secret);
    }
    expect(event).toContain('import-failed: Error: Motor import refused: thrust sample limit exceeded (file detail omitted)');
    expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(MAX_DEBUG_LOG_BYTES);
  });

  it.each([
    ['.rse', '<engine code="Private 61.234 Fairbanks" dia="18" len="70"/>', 'initial mass missing or zero'],
    ['.rse', '<engine code="Private 61.234 Fairbanks" initWt="20" propWt="0"/>', 'invalid propellant mass'],
    ['.rse', '<engine code="Private 61.234 Fairbanks" initWt="20" propWt="61.234"/>', 'propellant exceeds loaded mass'],
    ['.rse', '<engine code="Private 61.234 Fairbanks" initWt="20" propWt="10" len="70"/>', 'invalid diameter'],
    ['.rse', '<engine code="Private 61.234 Fairbanks" initWt="20" propWt="10" dia="18"/>', 'invalid length'],
    ['.rse', '<engine code="Private 61.234 Fairbanks" initWt="20" propWt="10" dia="18" len="70"/>', 'no thrust data'],
    ['.rse', '<engine code="Private 61.234 Fairbanks" initWt="20" propWt="10" dia="18" len="70"><data><eng-data t="0" f="Fairbanks"/></data></engine>', 'unreadable thrust data'],
    ['.rse', '<engine code="Private 61.234 Fairbanks" initWt="20" propWt="10" dia="18" len="70"><data><eng-data t="0" f="-61.234"/></data></engine>', 'negative time or thrust'],
    ['.eng', 'Private 18 70 P 0.01 0 PrivateMaker\n0 0\n1 0', 'invalid loaded mass'],
    ['.eng', 'Private 18 70 P 0 0.02 PrivateMaker\n0 0\n1 0', 'invalid propellant mass'],
    ['.eng', 'Private 18 70 P 61.234 0.02 PrivateMaker\n0 0\n1 0', 'propellant exceeds loaded mass'],
    ['.eng', 'Private 0 70 P 0.01 0.02 PrivateMaker\n0 0\n1 0', 'invalid diameter/length'],
    ['.eng', 'Private 18 70 P Fairbanks 0.02 PrivateMaker\n0 0\n1 0', 'nonnumeric mass'],
    ['.eng', 'Private 18 70 P 0.01 0.02 PrivateMaker\n0 0\n1 -61.234', 'negative time or thrust'],
    ['.eng', 'Private 18 70 P 0.01 0.02 PrivateMaker', 'No motors found in .eng file'],
  ])('retains the safe %s motor refusal category: %s', async (extension, source, safe) => {
    const contents = extension === '.rse' ? `<engine-database><engine-list>${source}</engine-list></engine-database>` : source;
    const out = await importMotorFiles([new File([contents], `Private Fairbanks 61.234${extension}`)]);
    expect(out.parsed).toHaveLength(0);
    expect(out.error).toContain('Private');
    const event = sessionDebugLog.text().trim().split('\n').at(-1)!;
    expect(event).toContain('import-failed: Error:');
    expect(event).toContain(safe);
    for (const secret of ['Private', '61.234', 'Fairbanks', '<engine', 'PrivateMaker']) expect(event).not.toContain(secret);
  });

  it('preserves distinct safe refusal categories from a multi-motor file without its names', async () => {
    const out = await importMotorFiles([new File([
      '<engine-database><engine-list><engine code="Private"/><engine code="Fairbanks" initWt="20" propWt="10" dia="18" len="70"/></engine-list></engine-database>',
    ], 'Private.rse')]);
    expect(out.parsed).toHaveLength(0);
    const event = sessionDebugLog.text().trim().split('\n').at(-1)!;
    expect(event).toContain('initial mass missing or zero');
    expect(event).toContain('no thrust data');
    expect(event).not.toContain('Private');
    expect(event).not.toContain('Fairbanks');
  });

  it.each([
    'Motor Private: unknown reason Fairbanks 61.234',
    'Motor Private: no thrust data Fairbanks 61.234',
    'Motor Private: data point Fairbanks has negative time or thrust (61.234, private)',
    `Motor Private: ${EX_SAMPLE_LIMIT_NOTE} Fairbanks 61.234`,
    `Motor Private: more than ${MAX_EX_MOTOR_SAMPLES + 1} thrust samples`,
    'Motor Private: more than Fairbanks 61.234 thrust samples',
  ])('omits unknown motor refusals and malformed lookalikes: %s', message => {
    const text = logged(new Error(message));
    expect(text).toContain('Message omitted for privacy');
    for (const secret of ['Private', '61.234', 'Fairbanks']) expect(text).not.toContain(secret);
  });

  it.each([
    ['.ork', importOrk, 'Not a valid .ork file (XML parse error)'],
    ['.rkt', importRkt, 'Not a valid RockSim file (XML parse error)'],
    ['.CDX1', importCdx1, 'Not a valid RASAero file (XML parse error)'],
    ['.rse', parseRse, 'Not valid XML (.rse)'],
  ] as const)('summarizes the %s importer XML refusal without parser contents', async (_format, read, message) => {
    // Happy-dom accepts malformed XML; force the parser's failure seam while
    // retaining each real importer's translation to its user-facing error.
    setXmlParser(() => { throw new XmlParseError('Private design 61.234 Fairbanks'); });
    const error = await refusal(() => read('<private-design>'));
    expect(error.message).toBe(message);
    expect(logged(error)).toContain('import-failed: Error: XML parse error (file detail omitted)');
    expect(logged(error)).not.toContain('Private');
    expect(logged(error)).not.toContain('Fairbanks');
    expect(logged(new Error(`${message} — Private design 61.234 Fairbanks`)))
      .toContain('XML parse error (file detail omitted)');
    expect(logged(new Error(`${message} — Private design 61.234 Fairbanks`))).not.toContain('Private');
  });

  it.each([
    ['missing share payload', () => decodeShareFragment('#broken'), 'not a share link (missing the d=<version>.<data> payload)'],
    ['newer share format', () => decodeShareFragment('#d=2.payload'), 'this link was made by a newer version of the app (format 2)'],
    ['binary RockSim', () => importRkt('[[RS001024RS]]'), 'This is an older BINARY RockSim file, not the XML .rkt this app reads. Open it in RockSim and re-save (RockSim 9 writes XML), or export it as .ork — either opens here.'],
    ...(['.ork', '.rkt', '.CDX1'] as const).map(kind => [
      `empty ${kind}`, () => unzipMember(zipSync({}), kind, kind), `Empty ${kind} archive`,
    ] as const),
  ] as const)('retains the real %s refusal', async (_scenario, run, message) => {
    const error = await refusal(run);
    expect(error.message).toBe(message);
    expect(logged(error)).toContain(message);
  });

  it.each(['.ork', '.rkt', '.CDX1'])('retains a static damaged %s ZIP and gzip refusal', async kind => {
    const zipError = await refusal(() => unzipMember(new Uint8Array(22), kind, kind));
    expect(zipError.message).toBe(`Not a readable ${kind} archive — it has no end-of-directory record.`);
    expect(logged(zipError)).toContain(zipError.message);
    const gzipError = await refusal(() => gunzipCapped(new Uint8Array([0x1f, 0x8b]), kind));
    expect(gzipError.message).toBe(`Not a readable compressed ${kind} file \u2014 it is damaged (does not match its own checksum \u2014 the file is cut short or corrupted).`);
    expect(logged(gzipError)).toContain(gzipError.message);
  });

  it.each([
    'the compressed data is corrupt or cut short',
    'the link is far longer than any real design — refusing to decode it',
    "this browser can't unpack share links. Open the link in Chrome or Edge 103, Firefox 113 or Safari 16.4 (iPhone and iPad: iOS 16.4) or later — or ask for the .ork file, which opens here.",
    'this link expands past 4 MB — that is not a rocket design',
    'This archive lists 10,001 entries, past the 10,000 this app will read — that is not a rocket design.',
    'Not a readable .ork archive — its directory lists 50 entries, more than 100 bytes can hold.',
    'Not a readable .rkt archive — directory entry 1 of 2 is missing.',
    'Not a readable .CDX1 archive — directory entry 1 of 2 runs past the end of the file.',
    'Not a readable .ork archive — directory entry 1 of 2 has no zip64 sizes.',
    'This compressed .ork file expands past the 64 MB this app will open — that is not a rocket design.',
    'This compressed .rkt file expands past the 64 MB this app will open — that is not a rocket design.',
    'This compressed .CDX1 file expands past the 64 MB this app will open — that is not a rocket design.',
    'This .ork file declares 1,001 simulations, past the 1,000 the app will open. Reduce the simulations in OpenRocket and save it again.',
    'This compressed .ork file has more than 1,000 gzip members, past the limit this app will open.',
    'This compressed .rkt file has more than 1,000 gzip members, past the limit this app will open.',
    'This compressed .CDX1 file has more than 1,000 gzip members, past the limit this app will open.',
    'This design has 2,001 parts, past the 2,000 the app will open. Desktop OR has no such limit.',
    'This RockSim file contains nested simulations, which the app cannot open. Open it in RockSim and save it again.',
    'This RockSim file contains nested motor loadouts, which the app cannot open. Open it in RockSim and save it again.',
    'This file contains 4,097 simulations, past the 4,096 the app will open. Remove simulations in RockSim and save it again. Desktop OR has no such limit.',
    "This file's simulations list 4,097 motor loadouts, past the 4,096 the app will open. Remove simulations in RockSim and save it again. Desktop OR has no such limit.",
    'This .ork file declares 257 flight configurations, past the 256 the app will open. Reduce the configurations in OpenRocket and save it again.',
    'This file would open as more than 256 flight configurations, past the 256 the app will open. Reduce the simulations in RockSim and save it again.',
    'This file would open as more than 256 flight configurations, past the 256 the app will open. Reduce the simulations in RASAero and save it again.',
  ])('retains the verified static/numeric refusal: %s', message => {
    expect(logged(new Error(message))).toContain(`import-failed: Error: ${message}`);
    const privateSuffix = logged(new Error(`${message} Private design 61.234 Fairbanks`));
    for (const secret of ['Private', '61.234', 'Fairbanks']) expect(privateSuffix).not.toContain(secret);
  });

  it.each([
    ['oversized member', 24, 65 * 1024 * 1024,
      'Archive member expands to 65 MB, past the 64 MB this app will open — that is not a rocket design. (file name omitted)'],
    ['inflation overflow', 24, 1024,
      'Archive member inflates past the 1,024 bytes its directory declares — the archive is damaged or crafted, not a rocket design. (file name omitted)'],
    ['checksum mismatch', 16, 0,
      'Not a readable .ork archive (file detail omitted)'],
  ] as const)('drops off-screen archive member names from a real %s refusal', async (_scenario, field, value, safe) => {
    const bytes = zipSync({ 'Private/Fairbanks 61.234.ork': new Uint8Array(1025) }, { level: 0 });
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const central = view.getUint32(bytes.length - 6, true);
    view.setUint32(central + field, value, true);
    const error = await refusal(() => unzipMember(bytes, '.ork', '.ork'));
    expect(error.message).toContain('Private/Fairbanks 61.234.ork');
    const text = logged(error);
    expect(text).toContain(safe);
    for (const secret of ['Private', 'Fairbanks', '61.234']) expect(text).not.toContain(secret);
  });

  it.each([
    'this link was made by a newer version of the app (format Private)',
    'This design has 61.234,-149.123 parts, past the 2,000 the app will open. Desktop OR has no such limit.',
    'Not a valid Private file (XML parse error)',
    'Not a readable Private archive — design contents.',
    '“Private” in this archive expands to Fairbanks MB, past the 64 MB this app will open — that is not a rocket design.',
  ])('omits non-allowlisted lookalikes: %s', message => {
    expect(logged(new Error(message))).toContain('import-failed: Error: Message omitted for privacy');
  });
});
