import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const guide = readFileSync(new URL('../user-guide.md', import.meta.url), 'utf8');
const paragraph = start => guide.split('\n').find(line => line.startsWith(start));

describe('J10 guide promises match the supported conditions', () => {
  it('S13a-6-1 / S13a-10-1 qualifies nozzle and full-flight matching', () => {
    const batch = paragraph('Every candidate flies');
    expect(batch).toContain('same complete loadout, ignition, delay policies');
    expect(batch).not.toContain('Automatic ignition with zero delay');
    expect(batch).not.toContain('replaces the selected mount');
    expect(paragraph('- **Batch simulate** gives')).toContain('nozzle value');
    expect(batch).not.toContain('a motor reads the same');
  });
  it('S13a-9-1 distinguishes a missing definition from an EX-only source', () => {
    expect(paragraph('When Save')).toContain('no captured or library definition');
    expect(paragraph('When Save')).toContain('saves without a maker and does not trigger this warning');
    expect(paragraph('When Save')).toContain('desktop OR');
    expect(paragraph('When Save')).not.toContain('desktop OpenRocket');
  });
  it('S13a-9-2 qualifies alternative-nozzle and machining notes', () => {
    expect(paragraph('- **Nine AeroTech')).toContain('complete equivalent exit');
    expect(paragraph('- **A 76 mm Loki')).toContain('complete equivalent exit');
  });
  it('S13a-9-3 discloses salvage after a motor has already been refused', () => {
    expect(paragraph('You can **import experimental')).toContain('already refused motor');
    expect(paragraph('You can **import experimental')).toContain('later valid motors can still be imported');
  });
  it('S13a-10-2 identifies local save/export failures and changed-text reopening', () => {
    const phone = paragraph('On a phone the app');
    expect(phone).toContain('global notices');
    expect(phone).toContain('Danger block beside **Save As / Export**');
    expect(phone).toContain('changed warning or error text opens it again');
    expect(phone).not.toContain('second failed export');
  });
  it('S13a-11-1 qualifies share-link catalogue and curve availability', () => {
    const share = paragraph('**Save As / Export → 🔗 Copy share link**');
    expect(share).toContain('effective catalogue');
    expect(share).toContain('embedded EX');
    expect(share).toContain('may need a network request');
  });
  it('S13a-11-2 describes zero-density preservation in both guide locations', () => {
    expect(paragraph('**RockSim round trips.**')).toContain('preserves zero-density');
    expect(paragraph('Desktop OpenRocket reads a custom material')).not.toContain('discards such zeros');
  });
  it('S13a-11-3 distinguishes automatic nozzle filling from explicit zero', () => {
    const physics = paragraph('- **power-on base drag**');
    expect(physics).toContain('Blank means automatic');
    expect(physics).toContain('explicit **0**');
    expect(physics).toContain('sum of the firing motor exit areas');
    expect(paragraph('- **Many motors have no exit diameter on file**')).toContain('imported `.rse`');
    expect(paragraph('**Cluster**')).toContain('usable exit, published or from an imported `.rse`');
  });
  it('S13a-12-1 distinguishes first burnout, last burnout and per-mount charge delay', () => {
    const coast = paragraph('**Coast**');
    expect(coast).toContain('motors finish burning together');
    expect(coast).toContain('first burnout');
    expect(coast).toContain('final burnout');
    expect(coast).toContain('primary mount');
    expect(coast).toContain('primary mount is on **Auto**');
    expect(coast).toContain('kernel summary optimum');
    expect(coast).toContain('final burnout to ballistic apogee');
  });
  it('S13a-13-1 discloses static substitutes and their CSV provenance', () => {
    expect(paragraph('| `S` |')).toContain('design estimate');
    expect(paragraph('| `S` |')).toContain('Guide-exit value sources');
    const report = paragraph('The report lists **Ejection delays by mount**');
    expect(report).toContain('When usable guide-exit samples are missing');
    expect(report).toContain('design estimate; no guide-exit sample');
    expect(report).not.toContain('— flight values at the moment');
  });
  it('S13a-13-2 describes disconnected DXF regions and tab connections', () => {
    expect(paragraph('| **.dxf**')).toContain('one closed contour per disconnected region');
    expect(paragraph('| **.dxf**')).toContain('tab joins regions only where it touches them');
    expect(paragraph('From any fin set')).toContain('one closed hairline cut contour per disconnected region');
  });
  it('S13a-13-3 includes the materials CSV round trip without an exhaustive count', () => {
    const csv = paragraph('| CSV |');
    expect(csv).toContain('**My materials**');
    expect(csv).toContain('parts and materials lists');
    expect(csv).not.toContain('writes six');
    expect(csv).not.toContain('the one the app reads back');
  });
});
