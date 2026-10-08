import { describe, expect, it } from 'vitest';
import notes from './motorStatusNotes.json';
import db from './motors.json';

// Curated against THREAD-READ-2026-10-07.md, including its outside-target rows.
// These are motor records, not individual delays, SKUs, or simulator files.
const groups = {
  'staff-discontinued': 'D10W D21T J615ST-20A F20W/L F27R/L F42T/L G77R/L G78G/L G79W/L',
  'staff-not-released': 'J1265T K62N K76WN-P L2775ST-PS N1975W-PS',
  'whole-motor': 'D15T E6-RCT E7-RCT F22J F23FJ G75J G75M G8ST H130W H13ST H550ST H73J H97J HP-I65W I115W I170G I180W I40N-P J250FJ J99N K513FJ L1250DM L400W L875DM M1075DM M1500G M1600R M1800FJ M2100G M2225WS N2220DM',
  'seasonal-clause': 'C3.4T D2.3T D7-RCT D9W E11J E12-RCJ F12J F13-RCT F16-RCJ F37W G12-RCT G339N G69N H112J H669N H999N I117FJ I154J I195J I225FJ I305FJ I364FJ I49N J401FJ J510W J575FJ K1050W K1499N K250W K458W K650T K680R K828FJ L1040DM L1170FJ L1300R L1365M L1500T L339N L952W M1305M M2000R M750W',
  'delay-sku': 'D22W F25W F26FJ F52C F62FJ F67C H14ST',
};

describe('AeroTech interim status evidence', () => {
  it('has exactly the reviewed populations and confidence classes', () => {
    expect(Object.keys(notes)).toHaveLength(95);
    for (const [group, designations] of Object.entries(groups)) {
      const rows = Object.values(notes).filter(n => group.startsWith('staff-')
        ? n.classification === group : n.classification === 'dealer-notice' && n.scope === group);
      expect(rows.map(n => n.designation).sort(), group).toEqual(designations.split(' ').sort());
    }
  });

  it('keys each note to the exact shipped regular AeroTech motor with dated permalinks', () => {
    for (const [id, note] of Object.entries(notes)) {
      expect(db.motors.find(m => m.motorId === id), id).toMatchObject({
        designation: note.designation, manufacturerAbbrev: 'AeroTech', availability: 'regular',
      });
      expect(note.sources.length).toBeGreaterThan(0);
      for (const source of note.sources) {
        expect(source.url).toMatch(/^https:\/\/www\.rocketryforum\.com\/posts\/\d+\/$/);
        expect(source.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
      expect(note.text.endsWith('ThrustCurve.org still lists it as in production.')).toBe(true);
      if (note.classification === 'dealer-notice') {
        expect(note.text).toContain('dealer notice relayed by a hobbyist on TRF on 2026-04-03');
        expect(note.text).toContain('effective 2026-04-24');
        expect(note.text).toContain('AeroTech has not confirmed the notice in the thread.');
        expect(note.sources[0]?.url).toBe('https://www.rocketryforum.com/posts/2861212/');
      }
      if (note.scope === 'seasonal-clause') expect(note.sources.length).toBeGreaterThan(1);
      if (note.scope === 'delay-sku') {
        expect(note.text).toContain('names only the');
        expect(note.text).toContain('it does not establish whole-motor discontinuation');
      }
    }
  });

  it('does not infer notes from a name match, absent statement, or disputed seasonal coverage', () => {
    for (const designation of ['J520W', 'E26W', 'K1100T', 'E30T', 'F23-RCW-SK', 'I350R', 'K1800ST-P', 'G11', 'G77R', 'G79W', 'HP-H550ST']) {
      const motor = db.motors.find(m => m.designation === designation && m.manufacturerAbbrev === 'AeroTech');
      expect(motor, designation).toBeTruthy();
      expect(Object.hasOwn(notes, motor!.motorId), designation).toBe(false);
    }
  });

  it('retains date and naming limits for the unreleased motors', () => {
    const expected = [
      ['J1265T', '2024-04-30', '2578865'], ['K62N', '2024-01-30', '2541951'],
      ['K76WN-P', '2023-07-21', '2462897'], ['L2775ST-PS', '2024-10-06', '2644590'],
      ['N1975W-PS', '2022-02-02', '2236155'],
    ];
    for (const [name, date, post] of expected) {
      const note = Object.values(notes).find(n => n.designation === name)!;
      expect(note.text).toContain(`certified but, as of ${date}, not released`);
      expect(note.sources[0]).toEqual({ date, url: `https://www.rocketryforum.com/posts/${post}/` });
    }
    expect(notes['63bb65281d26f30004b4b07b'].text).toContain('called J1265ST in the staff post');
  });
});
