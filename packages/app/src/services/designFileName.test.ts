import { describe, expect, it } from 'vitest';
import {
  designFileBase, designFileLabel, designFileTitle, documentTitle, savedDesignFileRef, validDesignFileRef,
} from './designFileName.js';
import { safeName } from './fileName.js';

describe('design file names', () => {
  it.each(['saved', 'downloaded'] as const)('follows a renamed rocket after a suggested %s save in every design format', via => {
    for (const format of ['ork', 'rkt', 'cdx1'] as const) {
      const extension = format === 'cdx1' ? 'CDX1' : format;
      const ref = savedDesignFileRef(`New_Rocket.${extension}`, via, format, 'New Rocket', null);
      expect(ref.followsRocket).toBe(true);
      expect(designFileBase(ref, 'Renamed Rocket')).toBe('Renamed_Rocket');
      expect(designFileLabel(ref, 'Renamed Rocket')).toContain(`Save .${extension} offers Renamed_Rocket.${extension}`);
      if (format !== 'ork') expect(designFileLabel(ref, 'Renamed Rocket'))
        .toContain(format === 'rkt' ? 'RockSim file' : 'RASAero II file');
      expect(designFileTitle(ref, 'Renamed Rocket')).toContain('Save .ork offers Renamed_Rocket.ork');
      expect(documentTitle('Renamed Rocket', ref, true)).toContain(`(Renamed_Rocket.${extension})`);
      expect(validDesignFileRef(JSON.parse(JSON.stringify(ref)))).toEqual(ref);
    }
  });

  it('keeps a typed different stem and every opened format after renaming', () => {
    for (const format of ['ork', 'rkt', 'cdx1'] as const) {
      const saved = savedDesignFileRef(`Chosen name.${format}`, 'saved', format, 'New Rocket', null);
      expect(saved.followsRocket).toBe(false);
      expect(designFileBase(saved, 'Renamed Rocket')).toBe('Chosen name');
      const opened = validDesignFileRef({ name: `Disk file.${format}`, via: 'opened', format, followsRocket: true });
      expect(designFileBase(opened, 'Renamed Rocket')).toBe('Disk file');
    }
  });

  it.each(['saved', 'downloaded'] as const)('keeps an existing non-following stem after a matching %s save and rename', via => {
    for (const format of ['ork', 'rkt', 'cdx1'] as const) {
      for (const previous of [
        { name: 'Goblin.ork', via: 'opened' as const, format: 'ork' as const },
        { name: 'Goblin.ork', via: 'opened' as const, format: 'ork' as const, followsRocket: true },
        { name: 'Goblin.ork', via: 'saved' as const, format: 'ork' as const, followsRocket: false },
        { name: 'Goblin.ork', via: 'downloaded' as const, format: 'ork' as const },
      ]) {
        const ref = savedDesignFileRef(`Goblin.${format}`, via, format, 'Goblin', previous);
        expect(ref.followsRocket).toBe(false);
        expect(designFileBase(ref, 'Goblin Mk2')).toBe('Goblin');
        expect(designFileLabel(ref, 'Goblin Mk2')).not.toContain('offers');
        expect(documentTitle('Goblin Mk2', ref, false)).toContain(`(Goblin.${format})`);
      }
    }
  });

  it('continues following across saves only while the suggested rocket stem is accepted', () => {
    const first = savedDesignFileRef('Goblin.ork', 'saved', 'ork', 'Goblin', null);
    const next = savedDesignFileRef('Goblin_Mk2.rkt', 'downloaded', 'rkt', 'Goblin Mk2', first);
    expect(designFileBase(next, 'Goblin Mk3')).toBe('Goblin_Mk3');
    const chosen = savedDesignFileRef('Chosen.ork', 'saved', 'ork', 'Goblin Mk3', next);
    expect(designFileBase(chosen, 'Goblin Mk4')).toBe('Chosen');
  });

  it.each(['saved', 'downloaded'] as const)('follows a legacy default-name %s reference in every format', via => {
    for (const format of ['ork', 'rkt', 'cdx1'] as const) {
      const extension = format === 'cdx1' ? 'CDX1' : format;
      for (const stem of [safeName('New Rocket')]) {
        const old = { name: `${stem}.${extension}`, via, format };
        const restored = validDesignFileRef(old);
        expect(restored).toEqual(old);
        expect(designFileBase(restored, 'Renamed Rocket')).toBe('Renamed_Rocket');
        expect(designFileLabel(restored, 'Renamed Rocket')).toContain(`Save .${extension} offers Renamed_Rocket.${extension}`);
        expect(designFileTitle(restored, 'Renamed Rocket')).toContain('Save .ork offers Renamed_Rocket.ork');
        expect(documentTitle('Renamed Rocket', restored, false)).toContain(`(Renamed_Rocket.${extension})`);
        const next = savedDesignFileRef(`Renamed_Rocket.${extension}`, via, format, 'Renamed Rocket', restored);
        expect(next.followsRocket).toBe(true);
        expect(designFileBase(next, 'Renamed Again')).toBe('Renamed_Again');
        const chosen = savedDesignFileRef(`Chosen.${extension}`, via, format, 'Renamed Rocket', restored);
        expect(designFileBase(chosen, 'Renamed Again')).toBe('Chosen');
      }
    }
  });

  it('keeps opened, explicitly non-following and other legacy stems after rename', () => {
    for (const stem of [safeName('New Rocket'), 'New Rocket']) {
      expect(designFileBase(validDesignFileRef({ name: `${stem}.ork`, via: 'opened' }), 'Renamed Rocket')).toBe(stem);
      for (const via of ['saved', 'downloaded'] as const) {
        expect(designFileBase(validDesignFileRef({ name: `${stem}.ork`, via, followsRocket: false }), 'Renamed Rocket')).toBe(stem);
      }
    }
    for (const via of ['saved', 'downloaded'] as const) {
      expect(designFileBase(validDesignFileRef({ name: 'Goblin.ork', via }), 'Renamed Rocket')).toBe('Goblin');
      // The app never wrote a spaced default stem, so a legacy 'New Rocket.ork' was typed or opened: it keeps its name.
      expect(designFileBase(validDesignFileRef({ name: 'New Rocket.ork', via }), 'Renamed Rocket')).toBe('New Rocket');
    }
  });

  it('rejects a malformed following flag', () => {
    const old = { name: 'New_Rocket.ork', via: 'saved', format: 'ork' };
    expect(validDesignFileRef({ ...old, followsRocket: 'true' })).toBeNull();
  });

  it.each([
    ['Mon fusée (1).ORK', 'Mon fusée (1)'], ['test.RkT', 'test'], ['test.CDX1', 'test'],
    ['test.ork.backup', 'test.ork.backup'], ['test.ork.ork', 'test.ork'],
    ['  name  .ork', '  name  '], ['.ork', 'Rocket_name'], ['   .rkt', 'Rocket_name'],
  ])('uses the file stem without sanitizing it: %s', (name, expected) => {
    expect(designFileBase({ name, via: 'opened', format: 'ork' }, 'Rocket name')).toBe(expected);
  });

  it('falls back to the sanitized rocket name only when no file stem exists', () => {
    expect(designFileBase(null, 'Rocket name')).toBe('Rocket_name');
    expect(designFileBase(null, undefined)).toBe('rocket');
    expect(designFileBase(null, '')).toBe('rocket');
    expect(designFileBase(null, '火箭')).toBe('rocket');
  });

  it('labels designs with and without a file', () => {
    expect(designFileLabel(null)).toBe('Not saved to a file');
    expect(designFileLabel({ name: 'file.ork', via: 'opened', format: 'ork' })).toBe('file.ork');
  });

  it('explains the provenance and the uncertainty of a download name', () => {
    expect(designFileTitle({ name: 'file.ork', via: 'opened', format: 'ork' }))
      .toBe('Opened from file.ork. Save .ork offers this name.');
    expect(designFileTitle({ name: 'file.ork', via: 'saved', format: 'ork' }))
      .toBe('Saved as file.ork. Save .ork offers this name.');
    expect(designFileTitle({ name: 'file.ork', via: 'downloaded', format: 'ork' }))
      .toBe('Downloaded as file.ork. If your download folder already had a file of that name, the browser may have saved it under another name.');
    expect(designFileTitle(null))
      .toBe('This design has not been opened from or saved to a file in this browser. Save .ork offers the rocket name.');
  });

  it('shows the rocket, optional file and dirty mark in the tab title', () => {
    expect(documentTitle('My rocket', { name: 'Other.ork', via: 'saved', format: 'ork' }, true))
      .toBe('*My rocket (Other.ork) — MMRocket Sim');
    expect(documentTitle('My rocket', null, false)).toBe('My rocket — MMRocket Sim');
    expect(documentTitle('', null, true)).toBe('*Rocket — MMRocket Sim');
    expect(documentTitle(undefined, { name: 'Other.rkt', via: 'opened', format: 'ork' }, false))
      .toBe('Rocket (Other.rkt) — MMRocket Sim');
  });

  it.each(['opened', 'saved', 'downloaded'] as const)('accepts a valid %s reference without sanitizing', via => {
    const ref = { name: 'Mon fusée (1).ork', via };
    expect(validDesignFileRef(ref)).toEqual({ ...ref, format: 'ork' });
    expect(validDesignFileRef({ name: 'x'.repeat(255), via })?.name).toHaveLength(255);
  });

  it.each([undefined, null, 1, 'file.ork', [], {}, { name: '', via: 'opened', format: 'ork' },
    { name: '   ', via: 'opened', format: 'ork' }, { name: 'x'.repeat(256), via: 'saved', format: 'ork' },
    { name: 1, via: 'opened', format: 'ork' }, { name: 'file.ork' }, { name: 'file.ork', via: 'other' },
  ].map(value => [value]))('rejects an invalid reference: %j', value => {
    expect(validDesignFileRef(value)).toBeNull();
  });
});

it('migrates legacy formats and labels the format actually used', () => {
  for (const [name, format] of [['x.RKT', 'rkt'], ['x.CdX1', 'cdx1'], ['x.ork', 'ork']]) {
    expect(validDesignFileRef({ name, via: 'opened' })).toEqual({ name, via: 'opened', format });
  }
  expect(validDesignFileRef({ name: 'x.rkt', via: 'saved', format: 'zip' })).toBeNull();
  expect(designFileLabel({ name: 'x.ork', via: 'saved', format: 'rkt' })).toBe('x.ork — RockSim file');
  expect(designFileLabel({ name: 'x.CDX1', via: 'opened', format: 'cdx1' })).toBe('x.CDX1 — RASAero II file');
  expect(designFileTitle({ name: 'x.rkt', via: 'downloaded', format: 'rkt' })).toContain('Save .ork keeps the full design');
});
