import { describe, expect, it } from 'vitest';
import {
  designFileBase, designFileLabel, designFileTitle, documentTitle, validDesignFileRef,
} from './designFileName.js';

describe('design file names', () => {
  it.each([
    ['Mon fusée (1).ORK', 'Mon fusée (1)'], ['test.RkT', 'test'], ['test.CDX1', 'test'],
    ['test.ork.backup', 'test.ork.backup'], ['test.ork.ork', 'test.ork'],
    ['  name  .ork', '  name  '], ['.ork', 'Rocket_name'], ['   .rkt', 'Rocket_name'],
  ])('uses the file stem without sanitizing it: %s', (name, expected) => {
    expect(designFileBase({ name, via: 'opened' }, 'Rocket name')).toBe(expected);
  });

  it('falls back to the sanitized rocket name only when no file stem exists', () => {
    expect(designFileBase(null, 'Rocket name')).toBe('Rocket_name');
    expect(designFileBase(null, undefined)).toBe('rocket');
    expect(designFileBase(null, '')).toBe('rocket');
    expect(designFileBase(null, '火箭')).toBe('rocket');
  });

  it('labels designs with and without a file', () => {
    expect(designFileLabel(null)).toBe('Not saved to a file');
    expect(designFileLabel({ name: 'file.ork', via: 'opened' })).toBe('file.ork');
  });

  it('explains the provenance and the uncertainty of a download name', () => {
    expect(designFileTitle({ name: 'file.ork', via: 'opened' }))
      .toBe('Opened from file.ork. Save .ork offers this name.');
    expect(designFileTitle({ name: 'file.ork', via: 'saved' }))
      .toBe('Saved as file.ork. Save .ork offers this name.');
    expect(designFileTitle({ name: 'file.ork', via: 'downloaded' }))
      .toBe('Downloaded as file.ork. If your download folder already had a file of that name, the browser may have saved it under another name.');
    expect(designFileTitle(null))
      .toBe('This design has not been opened from or saved to a file in this browser. Save .ork offers the rocket name.');
  });

  it('shows the rocket, optional file and dirty mark in the tab title', () => {
    expect(documentTitle('My rocket', { name: 'Other.ork', via: 'saved' }, true))
      .toBe('*My rocket (Other.ork) — MMRocket Sim');
    expect(documentTitle('My rocket', null, false)).toBe('My rocket — MMRocket Sim');
    expect(documentTitle('', null, true)).toBe('*Rocket — MMRocket Sim');
    expect(documentTitle(undefined, { name: 'Other.rkt', via: 'opened' }, false))
      .toBe('Rocket (Other.rkt) — MMRocket Sim');
  });

  it.each(['opened', 'saved', 'downloaded'] as const)('accepts a valid %s reference without sanitizing', via => {
    const ref = { name: 'Mon fusée (1).ork', via };
    expect(validDesignFileRef(ref)).toEqual(ref);
    expect(validDesignFileRef({ name: 'x'.repeat(255), via })?.name).toHaveLength(255);
  });

  it.each([undefined, null, 1, 'file.ork', [], {}, { name: '', via: 'opened' },
    { name: '   ', via: 'opened' }, { name: 'x'.repeat(256), via: 'saved' },
    { name: 1, via: 'opened' }, { name: 'file.ork' }, { name: 'file.ork', via: 'other' },
  ].map(value => [value]))('rejects an invalid reference: %j', value => {
    expect(validDesignFileRef(value)).toBeNull();
  });
});
