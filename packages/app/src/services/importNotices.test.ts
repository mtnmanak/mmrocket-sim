// @vitest-environment happy-dom
import { expect, it } from 'vitest';
import { INITIAL_UNITS } from '../prefs/units.js';
import { importOrk } from './orkFile.js';
import { importRkt } from './rocksimFile.js';
import { importCdx1 } from './rasaeroFile.js';
import { InflatedFileTooLargeError } from './zipMember.js';

it('S1a-g7 treats blank maxtime as an invalid supplied limit, in seconds', () => {
  const loaded = importOrk('<openrocket version="1.10"><rocket><subcomponents><stage><subcomponents><bodytube><length>1</length><radius>0.03</radius></bodytube></subcomponents></stage></subcomponents></rocket><simulations><simulation><conditions><maxtime>   </maxtime></conditions></simulation></simulations></openrocket>');
  expect(loaded.launch?.maxFlightTimeS).toBe(1200);
  expect(loaded.notes.join(' ')).toContain('1200 s');
  expect(loaded.notes.join(' ')).not.toContain('default (1200)');
});

const rkt = (parts: string) => `<RockSimDocument><DesignInformation><RocketDesign><StageCount>1</StageCount><Stage3Parts><BodyTube><OD>50</OD><ID>48</ID><Len>300</Len><AttachedParts>${parts}</AttachedParts></BodyTube></Stage3Parts></RocketDesign></DesignInformation></RockSimDocument>`;
const fins = (angle: number) => `<FinSet><FinCount>3</FinCount><RootChord>60</RootChord><TipChord>30</TipChord><SemiSpan>30</SemiSpan><Thickness>3</Thickness><RadialAngle>${angle}</RadialAngle></FinSet>`;

it('S1b-g8 leaves plain RockSim XML outside the CDATA expansion cap', () => {
  expect(importRkt(rkt(''), { maxInflatedBytes: 16 }).tree.components).toHaveLength(1);
});

it('S1b-g7 formats de-collision in the chosen angle unit', () => {
  const loaded = importRkt(rkt(fins(0) + fins(0)), { units: { ...INITIAL_UNITS, angle: 'rad' } });
  expect(loaded.notes.join(' ')).toContain('rotated 1.047 rad (60°)');
});
it('S1b-g7 normalizes de-collision for rotations above a full turn', () => {
  const loaded = importRkt(rkt(fins(10) + fins(10) + fins(10)));
  const turns = loaded.notes.filter(n => n.includes('to interleave')).map(n => Number(/rotated ([\d.-]+)°/.exec(n)?.[1]));
  expect(turns).toHaveLength(2);
  expect(turns.every(n => n >= 0 && n < 360)).toBe(true);
});
it('S1b-g8 refuses CDATA expansion before parsing the expanded document', () => {
  const xml = rkt('').replace('<StageCount>', '<Name><![CDATA[' + '&'.repeat(500) + ']]></Name><StageCount>');
  expect(xml.length).toBeLessThan(1500);
  expect(() => importRkt(xml, { maxInflatedBytes: 1500 })).toThrow(InflatedFileTooLargeError);
});
it('S1c-g5 describes fallback recovery dimensions in the selected units', () => {
  const loaded = importCdx1('<RASAeroDocument><RocketDesign><BodyTube><Length>40</Length><Diameter>4</Diameter></BodyTube></RocketDesign><Recovery><Event1>true</Event1><EventType1>Altitude</EventType1><Altitude1>500</Altitude1><Size1>36</Size1><CD1>&#160;0.8</CD1></Recovery></RASAeroDocument>', { units: { ...INITIAL_UNITS, altitude: 'm', length: 'mm' } });
  const note = loaded.notes.find(n => n.includes('for this slot'));
  expect(note).toContain('152.4 m (500 ft)');
  expect(note).toContain('914.4 mm (36 in)');
});
