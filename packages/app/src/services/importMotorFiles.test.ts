// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { importMotorFiles } from './importMotorFiles.js';
import { sessionDebugLog } from './sessionDebugLog.js';
import { EX_IMPORT_BYTES_NOTE, MAX_EX_IMPORT_BYTES } from './exMotorLimits.js';

afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

it.each(['QuotaExceededError', 'SecurityError'])('C-H3 records %s motor storage refusal separately from session import', async name => {
  vi.resetModules();
  const { importMotorFiles: read } = await import('./importMotorFiles.js');
  const { sessionDebugLog: log } = await import('./sessionDebugLog.js');
  const storage = localStorage;
  vi.stubGlobal('localStorage', {
    get length() { return storage.length; },
    key: (index: number) => storage.key(index),
    getItem: (key: string) => storage.getItem(key),
    removeItem: (key: string) => storage.removeItem(key),
    clear: () => storage.clear(),
    setItem: () => { throw new DOMException('Private storage 61.234 Fairbanks', name); },
  });
  const out = await read([new File(['Private 18 70 P 0.01 0.02 PrivateMaker\n0 0\n0.5 20\n1 0'], 'Private-session.eng')]);
  expect(out.parsed).toHaveLength(1);
  expect(out.write?.stored).toBe(false);
  expect(out.error).toContain('NOT saved');
  const text = log.text();
  expect(text).toContain('import-complete');
  expect(text).toContain('import-storage-failed: Motor storage is full or blocked; imported motors are available only for this session.');
  expect(text).not.toContain('import-failed:');
  for (const secret of ['Private', '61.234', 'Fairbanks']) expect(text).not.toContain(secret);
});

it('C-H3 does not record a storage failure when the motor-library write succeeds', async () => {
  vi.resetModules();
  const { importMotorFiles: read } = await import('./importMotorFiles.js');
  const { sessionDebugLog: log } = await import('./sessionDebugLog.js');
  const out = await read([new File(['Private 18 70 P 0.01 0.02 PrivateMaker\n0 0\n0.5 20\n1 0'], 'Private-session.eng')]);
  expect(out.write?.stored).toBe(true);
  expect(log.text()).toContain('import-complete');
  expect(log.text()).not.toContain('import-storage-failed');
  expect(log.text()).not.toContain('Private');
});

it('C-H3 captures a failed motor import without the file name or its content', async () => {
  const before = sessionDebugLog.text();
  const out = await importMotorFiles([new File(['not a motor: Secret weather place 61.234'], 'Secret-session.eng')]);
  expect(out.error).toContain('Secret-session.eng');
  const after = sessionDebugLog.text();
  expect(after).not.toBe(before);
  expect(after).toContain('import-failed');
  expect(after).not.toContain('Secret');
  expect(after).not.toContain('61.234');
});

it('lane C S1c-3 refuses an oversized motor file before reading it', async () => {
  const file = new File(['not read'], 'oversized.eng');
  Object.defineProperty(file, 'size', { value: 16 * 1024 * 1024 + 1 });
  const read = vi.spyOn(file, 'arrayBuffer');
  const out = await importMotorFiles([file]);
  expect(read).not.toHaveBeenCalled();
  expect(out.write).toBeNull();
  expect(out.error).toContain('oversized.eng: Motor file limit is 16 MiB');
});

it('round2 imports a large folder and deduplicates a second copy of the collection', async () => {
  const eng = Array.from({ length: 1100 }, (_, i) => `E${i} 29 100 P 0.05 0.1 Home\n0 0\n0.5 40\n1 0\n`).join('');
  const out = await importMotorFiles([new File([eng], 'rasp.eng'), new File([eng], 'rasp (1).eng')]);
  expect(out.error).toBeNull();
  expect(out.parsed).toHaveLength(2200);
  expect(out.write?.stored).toBe(true);
  expect(out.write?.motors).toHaveLength(1100);
  expect(JSON.parse(localStorage.getItem('online-openrocket.ex-motors.v1')!)).toHaveLength(1100);
});

it('round2 imports multiple under-limit files whose combined raw count exceeds 1,024', async () => {
  const eng = Array.from({ length: 600 }, (_, i) => `E${i} 29 100 P 0.05 0.1 Home\n0 0\n0.5 40\n1 0\n`).join('');
  const out = await importMotorFiles([new File([eng], 'first.eng'), new File([eng], 'copy.eng')]);
  expect(out.error).toBeNull();
  expect(out.parsed).toHaveLength(1200);
  expect(out.write?.motors).toHaveLength(600);
  expect(out.write?.stored).toBe(true);
});

it.each(['eng', 'rse'])('round2 imports a single %s collection over 1,024 motors', async extension => {
  const eng = 'E20 29 100 P 0.05 0.1 Home\n0 0\n0.5 40\n1 0\n';
  const engine = '<engine code="E20" mfg="Home" dia="29" len="100" initWt="100" propWt="50"><data><eng-data t="0" f="0"/><eng-data t="1" f="40"/><eng-data t="2" f="0"/></data></engine>';
  const collection = extension === 'eng' ? eng.repeat(1100)
    : `<engine-database>${engine.repeat(1100)}</engine-database>`;
  const out = await importMotorFiles([new File([collection], `collection.${extension}`)]);
  expect(out.error).toBeNull();
  expect(out.parsed).toHaveLength(1100);
  expect(out.write?.stored).toBe(true);
  expect(out.write?.motors).toHaveLength(1);
});

it.each(['UTF-16LE', 'ISO-8859-1'])('round1 decodes a %s .rse with a non-ASCII maker', async encoding => {
  const xml = `<?xml version="1.0" encoding="${encoding}"?><engine-database><engine code="E20" mfg="Créateur" dia="29" len="100" initWt="100" propWt="50"><data><eng-data t="0" f="0"/><eng-data t="1" f="40"/><eng-data t="2" f="0"/></data></engine></engine-database>`;
  const bytes = encoding === 'UTF-16LE' ? new Uint8Array(2 + xml.length * 2)
    : Uint8Array.from(xml, ch => ch.charCodeAt(0));
  if (encoding === 'UTF-16LE') {
    bytes.set([0xff, 0xfe]);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < xml.length; i++) view.setUint16(2 + i * 2, xml.charCodeAt(i), true);
  }
  const out = await importMotorFiles([new File([bytes], 'encoded.rse')]);
  expect(out.error).toBeNull();
  expect(out.parsed).toHaveLength(1);
  expect(out.parsed[0]!.realManufacturer).toBe('Créateur');
});

it('round1 derives the byte refusal from the shared cap and never reads oversized XML', async () => {
  expect(EX_IMPORT_BYTES_NOTE).toBe(`Motor file limit is ${MAX_EX_IMPORT_BYTES / (1024 * 1024)} MiB; this file was not read.`);
  const file = new File(['not read'], 'oversized.rse');
  Object.defineProperty(file, 'size', { value: MAX_EX_IMPORT_BYTES + 1 });
  const read = vi.spyOn(file, 'arrayBuffer');
  const out = await importMotorFiles([file]);
  expect(read).not.toHaveBeenCalled();
  expect(out.error).toContain(EX_IMPORT_BYTES_NOTE);
});

const motorXml = (declaration = '') => `${declaration}<engine-database><engine code="E20" mfg="Créateur" dia="29" len="100" initWt="100" propWt="50"><data><eng-data t="0" f="0"/><eng-data t="1" f="40"/><eng-data t="2" f="0"/></data></engine></engine-database>`;

it.each(['rse', 'eng'])('round2 uses motor wording for undecodable Windows-1252 XML in .%s', async extension => {
  const bytes = Uint8Array.from(motorXml().replace('</engine-database>', '<!-- 20° --></engine-database>'), ch => ch.charCodeAt(0));
  const out = await importMotorFiles([new File([bytes], `legacy.${extension}`)]);
  expect(out.error).toBeNull();
  expect(out.parsed).toHaveLength(1);
  expect(out.notice).toContain('2 characters in this file could not be read and were replaced');
  expect(out.notice).toContain('Check the motor and maker names.');
  expect(out.notice).not.toContain('part and material');
  expect(out.noticeTier).toBe('caution');
});

it.each(['UTF-16LE', 'UTF-16BE', 'UTF-16LE-no-BOM', 'ISO-8859-1', 'UTF-8-BOM'])(
  'round2 detects %s RockSim XML stored as .eng', async encoding => {
    const xml = motorXml(encoding === 'ISO-8859-1' ? '<?xml version="1.0" encoding="ISO-8859-1"?>' : '');
    let bytes: Uint8Array<ArrayBuffer>;
    if (encoding.startsWith('UTF-16')) {
      const bom = encoding.endsWith('no-BOM') ? 0 : 2;
      const little = encoding !== 'UTF-16BE';
      bytes = new Uint8Array(bom + xml.length * 2);
      if (bom) bytes.set(little ? [0xff, 0xfe] : [0xfe, 0xff]);
      const view = new DataView(bytes.buffer);
      for (let i = 0; i < xml.length; i++) view.setUint16(bom + i * 2, xml.charCodeAt(i), little);
    } else if (encoding === 'ISO-8859-1') {
      bytes = Uint8Array.from(xml, ch => ch.charCodeAt(0));
    } else {
      const encoded = new TextEncoder().encode(xml);
      bytes = new Uint8Array(3 + encoded.length);
      bytes.set([0xef, 0xbb, 0xbf]);
      bytes.set(encoded, 3);
    }
    const out = await importMotorFiles([new File([bytes], 'encoded.eng')]);
    expect(out.error).toBeNull();
    expect(out.parsed[0]!.realManufacturer).toBe('Créateur');
    expect(out.noticeTier).toBe('information');
  });

it('round2 skips one oversized file by name and still imports a usable sibling', async () => {
  const oversized = new File(['not read'], 'oversized.eng');
  Object.defineProperty(oversized, 'size', { value: MAX_EX_IMPORT_BYTES + 1 });
  const read = vi.spyOn(oversized, 'arrayBuffer');
  const out = await importMotorFiles([oversized, new File(['E20 29 100 P 0.05 0.1 Home\n0 0\n1 40\n2 0'], 'good.eng')]);
  expect(read).not.toHaveBeenCalled();
  expect(out.write?.motors).toHaveLength(1);
  expect(out.error).toContain('Skipped 1 file — oversized.eng: Motor file limit is 16 MiB');
});

// Underflows to exitDiameterM 0, which validExMotor refuses (audit closure of v0.194, row A).
const refusedRse = '<engine-database><engine code="Z9" mfg="Home" dia="1e-320" exitDia="1e-321" len="100" initWt="100" propWt="50"><data><eng-data t="0" f="0"/><eng-data t="1" f="40"/><eng-data t="2" f="0"/></data></engine></engine-database>';

it('A one refused motor leaves the rest of the selection imported', async () => {
  const out = await importMotorFiles([
    new File(['E20 29 100 P 0.05 0.1 Home\n0 0\n1 40\n2 0'], 'good.eng'),
    new File([refusedRse], 'tiny.rse'),
  ]);
  expect(out.write?.stored).toBe(true);
  expect(out.write?.motors.map((m) => m.designation)).toEqual(['E20']);
  expect(out.parsed.map((m) => m.designation)).toEqual(['E20']);
  expect(out.notice).toContain('Imported 1 EX motor (E20)');
  expect(out.error).toContain('tiny.rse');
  expect(out.error).toContain('Motor Z9: invalid dimensions, curve or motor fields; it was not stored.');
  const stored = JSON.parse(localStorage.getItem('online-openrocket.ex-motors.v1')!) as { designation: string }[];
  expect(stored.map((m) => m.designation)).toEqual(['E20']);
});

it('A a selection whose every motor is refused writes nothing and resolves', async () => {
  const out = await importMotorFiles([new File([refusedRse], 'tiny.rse')]);
  expect(out.write).toBeNull();
  expect(out.parsed).toEqual([]);
  expect(out.notice).toBeNull();
  expect(out.error).toContain('tiny.rse: Motor Z9: invalid dimensions, curve or motor fields; it was not stored.');
  expect(localStorage.getItem('online-openrocket.ex-motors.v1')).toBeNull();
});

it('A names at most six refused motors and counts the rest', async () => {
  const many = Array.from({ length: 9 }, (_, i) => new File([refusedRse.replace('Z9', `Z${i}`)], `tiny${i}.rse`));
  const out = await importMotorFiles(many);
  expect(out.error!.match(/it was not stored\./g)).toHaveLength(6);
  expect(out.error).toContain('3 more motors were refused');
  expect(out.error).not.toContain('tiny8.rse');
});

it("A keeps a fully refused file's parser notes out of the import notice", async () => {
  // Undeclared and not UTF-8 (0xE9), so the decoder adds a note for this file.
  const bytes = Uint8Array.from(refusedRse.replace('Home', 'Héme'), (c) => c.charCodeAt(0));
  const out = await importMotorFiles([
    new File(['E20 29 100 P 0.05 0.1 Home\n0 0\n1 40\n2 0'], 'good.eng'),
    new File([bytes], 'tiny.rse'),
  ]);
  expect(out.write?.motors.map((m) => m.designation)).toEqual(['E20']);
  expect(out.error).toContain('tiny.rse: Motor Z9');
  expect(out.notice).not.toContain('tiny.rse');
  expect(out.noticeTier).toBe('information');
});

it('F imports a RockSim XML motor file named .txt', async () => {
  const out = await importMotorFiles([new File([motorXml().replace('Créateur', 'Maker')], 'H128.txt')]);
  expect(out.error).toBeNull();
  expect(out.write?.motors.map((m) => m.designation)).toEqual(['E20']);
  expect(out.parsed[0]!.realManufacturer).toBe('Maker');
});

it('says the stored library was copied aside when it replaced an unreadable one', async () => {
  vi.resetModules();
  const { importMotorFiles: read } = await import('./importMotorFiles.js');
  localStorage.setItem('online-openrocket.ex-motors.v1', '{broken');
  const out = await read([new File(['Kept 18 70 P 0.01 0.02 KeptMaker\n0 0\n0.5 20\n1 0'], 'kept.eng')]);
  expect(out.write?.stored).toBe(true);
  expect(out.notice).toContain('The stored motor library could not be read. The app kept a copy of it in this browser and started a new library.');
  expect(localStorage.getItem('online-openrocket.ex-motors.v1.unreadable-backup')).toBe('{broken');
});

it('says the stored library was unreadable, not full, when it refuses to write over it', async () => {
  vi.resetModules();
  const { importMotorFiles: read } = await import('./importMotorFiles.js');
  localStorage.setItem('online-openrocket.ex-motors.v1.unreadable-backup', 'older');
  localStorage.setItem('online-openrocket.ex-motors.v1', '{broken');
  const out = await read([new File(['Kept 18 70 P 0.01 0.02 KeptMaker\n0 0\n0.5 20\n1 0'], 'kept.eng')]);
  expect(out.write?.stored).toBe(false);
  expect(out.error).toContain('the stored motor library could not be read, so the app left it unchanged');
  expect(out.error).not.toContain('full or blocked');
  expect(localStorage.getItem('online-openrocket.ex-motors.v1')).toBe('{broken');
});
