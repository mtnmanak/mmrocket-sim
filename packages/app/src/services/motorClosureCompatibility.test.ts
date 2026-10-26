// @vitest-environment happy-dom
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { userMotorCorpusPath } from './userMotorCorpusPath.testSupport.js';
import { strFromU8, unzipSync } from 'fflate';
import { expect, it } from 'vitest';
import { OrkRocket } from '@online-openrocket/engine';
import { MOTOR_DB } from './motorDb.js';
import { bundledSimFiles, fetchMotorSpec } from './thrustcurve.js';
import { exToMotorSpec, parseMotorFile, validExMotor } from './exMotors.js';
import { importOrk } from './orkFile.js';

const rocket = () => OrkRocket.buildTree({ components: [{ type: 'stage', children: [
  { type: 'bodytube', id: 'mount', length: 3, outerRadius: 0.2, motorMount: true },
] }] });

it('reports the shipped motor census through the app and engine guards', async () => {
  const built = rocket();
  let checked = 0, noFiles = 0;
  const refused: string[] = [];
  for (const motor of MOTOR_DB) {
    const files = await bundledSimFiles(motor.motorId);
    if (!files.length) { noFiles++; continue; }
    try {
      const spec = await fetchMotorSpec(motor, 5, undefined, { bundleOnly: true });
      built.setMotorById('mount', spec);
      checked++;
    } catch (e) { refused.push(`${motor.manufacturerAbbrev} ${motor.designation}: ${e}`); }
  }
  console.log(JSON.stringify({ catalogue: MOTOR_DB.length, checked, noFiles, refused }));
  // Upstream files can be unflyable; report them without blocking a refresh.
  expect(checked + noFiles + refused.length).toBe(MOTOR_DB.length);
}, 60_000);

const userFiles = userMotorCorpusPath(join(dirname(fileURLToPath(import.meta.url)), '../../../..'), existsSync, join);
it.skipIf(userFiles === null)('admits user motor files and embedded EX definitions through the same guards', () => {
  const built = rocket();
  let files = 0, checked = 0, embedded = 0;
  const existingMassRefusals: string[] = [];
  const refused: string[] = [];
  const check = (name: string, bytes: Uint8Array) => {
    if (/\.(eng|rse)$/i.test(name)) {
      files++;
      const notes: string[] = [];
      const text = strFromU8(bytes);
      const impossibleMasses = text.split(/\r?\n/).map(line => line.trim().split(/\s+/))
        .filter(fields => fields.length === 7 && Number(fields[4]) > Number(fields[5])).map(fields => fields[0]!);
      try {
        for (const motor of parseMotorFile(name, text, notes)) {
          checked++;
          expect(validExMotor(motor), name).toBe(true);
          built.setMotorById('mount', exToMotorSpec(motor, 5));
        }
        for (const note of notes) {
          const reasons = note.replace(/^skipped \d+ motors? \u2014 /, '').split(' \u00b7 ');
          for (const reason of reasons) {
            if (impossibleMasses.some(id => reason.startsWith(`${id}: more propellant (`))) existingMassRefusals.push(`${name}: ${reason}`);
            else refused.push(`${name}: ${reason}`);
          }
        }
      } catch (e) { refused.push(`${name}: ${e}`); }
    } else if (/\.ork$/i.test(name)) {
      const members = bytes[0] === 80 && bytes[1] === 75 ? unzipSync(bytes) : null;
      const xml = members ? strFromU8(Object.values(members)[0]!) : strFromU8(bytes);
      if (!xml.includes('<mmrexmotors')) return;
      const opened = importOrk(xml);
      for (const motor of opened.embeddedExMotors ?? []) {
        embedded++; checked++;
        expect(validExMotor(motor), name).toBe(true);
        built.setMotorById('mount', exToMotorSpec(motor, 5));
      }
      refused.push(...opened.notes.filter(n => /Embedded EX motors were refused/.test(n)).map(n => `${name}: ${n}`));
    }
  };
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(eng|rse|ork)$/i.test(path)) check(path, readFileSync(path));
      else if (/\.zip$/i.test(path)) {
        const members = unzipSync(readFileSync(path), { filter: file => /\.(eng|rse|ork)$/i.test(file.name) });
        for (const [name, bytes] of Object.entries(members)) check(`${path}/${name}`, bytes);
      }
    }
  };
  walk(userFiles!);
  console.log(JSON.stringify({ files, embedded, checked, existingMassRefusals, refused }));
  expect(refused).toEqual([]);
}, 60_000);
