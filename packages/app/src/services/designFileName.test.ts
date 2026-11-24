import { describe, expect, it } from 'vitest';
import {
  designFileBase, designFileLabel, designFileTitle, documentTitle, offeredDesignFileName, openedDesignFileRef, savedDesignFileRef, validDesignFileRef,
  type DesignFileRef,
} from './designFileName.js';
import { safeName } from './fileName.js';

describe('design file names', () => {
  it.each(['opened', 'saved', 'downloaded'] as const)('r3 derives blank-stem %s copy from the fallback suggestion', via => {
    const ref: DesignFileRef = { name: '  .ORK', via, format: 'ork', followsRocket: false };
    expect(offeredDesignFileName(ref, 'Rocket name', 'ork')).toBe('Rocket_name.ork');
    expect(designFileLabel(ref, 'Rocket name')).toBe(via === 'opened'
      ? 'Opened from   .ORK; Save .ork offers Rocket_name.ork' : 'Save .ork offers Rocket_name.ork');
    expect(designFileTitle(ref, 'Rocket name')).toContain('Save .ork offers Rocket_name.ork, following the rocket name.');
    expect(documentTitle('Rocket name', ref, false)).toBe('Rocket name (Rocket_name.ork) — MMRocket Sim');
  });

  it.each(['saved', 'downloaded'] as const)('r3 preserves matching spelling across every %s save state', via => {
    for (const [stem, sourceExtension] of [['A simple model rocket', 'ork'], ['火箭', 'ork'], ['Skittles', 'ORK']] as const) {
      for (const format of ['ork', 'rkt', 'cdx1'] as const) {
        const extension = format === 'cdx1' ? 'CDX1' : format;
        const suffix = format === 'rkt' ? ' — RockSim file' : format === 'cdx1' ? ' — RASAero II file' : '';
        const opened = openedDesignFileRef(`${stem}.${sourceExtension}`, 'ork', stem);
        const check = (ref: DesignFileRef, rocket: string, expectedStem: string, expectedName: string) => {
          expect(designFileBase(ref, rocket)).toBe(expectedStem);
          expect(offeredDesignFileName(ref, rocket, ref.format)).toBe(expectedName);
          expect(documentTitle(rocket, ref, false)).toBe(`${rocket} (${expectedName}) — MMRocket Sim`);
          const changed = expectedStem !== ref.name.replace(/\.(ork|rkt|cdx1)$/i, '');
          expect(designFileLabel(ref, rocket)).toBe(ref.via === 'opened'
            ? changed ? `Opened from ${ref.name}; Save .ork offers ${expectedName}` : ref.name
            : `Save .${extension} offers ${expectedName}${suffix}`);
          const orkName = ref.format === 'ork' ? expectedName : `${expectedStem}.ork`;
          const following = ` Save .ork offers ${orkName}, following the rocket name.`;
          const loss = format === 'ork' || ref.via === 'opened' ? ''
            : ` A ${format === 'rkt' ? 'RockSim' : 'RASAero II'} file does not hold everything an .ork does. Save .ork keeps the full design.`;
          expect(designFileTitle(ref, rocket)).toBe(ref.via === 'opened'
            ? `Opened from ${ref.name}.${changed ? following : ' Save .ork offers this name.'}`
            : (via === 'saved' ? `Saved as ${ref.name}.`
              : `Downloaded as ${ref.name}. If your download folder already had a file of that name, the browser may have saved it under another name.`)
              + following + loss);
        };
        check(opened, stem, stem, opened.name);
        const originalOffer = format === 'ork' ? opened.name : `${stem}.${extension}`;
        expect(offeredDesignFileName(opened, stem, format)).toBe(originalOffer);
        let ref = savedDesignFileRef(originalOffer, via, format, stem, opened);
        check(ref, stem, stem, originalOffer);
        ref = savedDesignFileRef(originalOffer, via, format, stem, ref);
        check(ref, stem, stem, originalOffer);
        check(ref, 'Plastic II', 'Plastic_II', `Plastic_II.${extension}`);
        // Before saving a renamed design, the current file still holds its original spelling.
        check(ref, stem, stem, originalOffer);
        ref = savedDesignFileRef(`Plastic_II.${extension}`, via, format, 'Plastic II', ref);
        check(ref, 'Plastic II', 'Plastic_II', `Plastic_II.${extension}`);
        // A save replaces the file reference: renaming back now uses a safe new suggestion.
        check(ref, stem, safeName(stem), `${safeName(stem)}.${extension}`);
      }
    }
  });

  it.each(['ork', 'rkt', 'cdx1'] as const)('r2 preserves a matching spaced opened %s stem through rename and rename back', format => {
    const extension = format === 'cdx1' ? 'CDX1' : format.toUpperCase();
    const stem = 'A simple model rocket';
    const ref = openedDesignFileRef(`${stem}.${extension}`, format, stem);
    const suffix = format === 'rkt' ? ' — RockSim file' : format === 'cdx1' ? ' — RASAero II file' : '';
    for (const rocket of [stem, ' My Rocket: 2 ', stem]) {
      const unchanged = rocket === stem;
      const base = unchanged ? stem : 'My_Rocket_2';
      expect(designFileBase(ref, rocket)).toBe(base);
      expect(designFileLabel(ref, rocket)).toBe(unchanged ? `${stem}.${extension}${suffix}`
        : `Opened from ${stem}.${extension}; Save .${format === 'cdx1' ? 'CDX1' : format} offers ${base}.${format === 'cdx1' ? 'CDX1' : format}${suffix}`);
      expect(designFileTitle(ref, rocket)).toContain(unchanged
        ? `Opened from ${stem}.${extension}. Save .ork offers this name.`
        : `Save .ork offers ${base}.ork, following the rocket name.`);
      expect(documentTitle(rocket, ref, false)).toContain(`(${base}.${unchanged ? extension : format === 'cdx1' ? 'CDX1' : format})`);
    }
    const saved = savedDesignFileRef(`${stem}.${extension}`, 'saved', format, stem, ref);
    expect(saved.followsRocket).toBe(true);
    expect(designFileBase(saved, 'Later rename')).toBe('Later_rename');
  });

  it('r2 keeps the original matching uppercase-extension tooltip and trims generated suggestions', () => {
    expect(designFileTitle(openedDesignFileRef('Skittles.ORK', 'ork', 'Skittles'), 'Skittles'))
      .toBe('Opened from Skittles.ORK. Save .ork offers this name.');
    expect(designFileBase(null, ' My Rocket: 2 ')).toBe('My_Rocket_2');
    expect(designFileBase(openedDesignFileRef('Skittles.ork', 'ork', 'Skittles'), '火箭')).toBe('rocket');
  });

  it.each(['ork', 'rkt', 'cdx1'] as const)('162 follows an opened matching %s name, including another save', format => {
    const extension = format === 'cdx1' ? 'CDX1' : format.toUpperCase();
    const ref = openedDesignFileRef(`Skittles.${extension}`, format, 'Skittles');
    expect(ref.followsRocket).toBe(true);
    expect(designFileLabel(ref, 'Skittles')).toBe(`Skittles.${extension}`
      + (format === 'rkt' ? ' — RockSim file' : format === 'cdx1' ? ' — RASAero II file' : ''));
    expect(documentTitle('Skittles', ref, false)).toContain(`(Skittles.${extension})`);
    expect(designFileBase(ref, 'Plastic')).toBe('Plastic');
    expect(designFileLabel(ref, 'Plastic')).toContain(`Opened from Skittles.${extension}; Save`);
    expect(designFileTitle(ref, 'Plastic')).toContain(`Opened from Skittles.${extension}.`);
    expect(designFileTitle(ref, 'Plastic')).toContain('Save .ork offers Plastic.ork, following the rocket name.');
    expect(documentTitle('Plastic', ref, true)).toContain(`(Plastic.${format === 'cdx1' ? 'CDX1' : format})`);
    const saved = savedDesignFileRef('Plastic.ork', 'saved', 'ork', 'Plastic', ref);
    expect(saved.followsRocket).toBe(true);
    expect(designFileBase(saved, 'Plastic II')).toBe('Plastic_II');
    expect(validDesignFileRef(JSON.parse(JSON.stringify(ref)))).toEqual(ref);
  });

  it('162 matches trimmed written or safe names case-sensitively, only with a usable rocket name', () => {
    for (const stem of ['My Rocket: 2', safeName('My Rocket: 2'), '  My Rocket: 2  ']) {
      const ref = openedDesignFileRef(`${stem}.ork`, 'ork', ' My Rocket: 2 ');
      expect(ref.followsRocket).toBe(true);
      expect(designFileBase(ref, 'Renamed')).toBe('Renamed');
      expect(designFileLabel(ref, ' My Rocket: 2 ')).toBe(`${stem}.ork`);
    }
    for (const name of ['skittles', 'Different', '', '   ', undefined]) {
      const ref = openedDesignFileRef('Skittles.ork', 'ork', name);
      expect(ref.followsRocket).toBe(false);
      expect(designFileBase(ref, 'Plastic')).toBe('Skittles');
    }
  });
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

  it('keeps a typed different stem and a differently named opened file after renaming', () => {
    for (const format of ['ork', 'rkt', 'cdx1'] as const) {
      const saved = savedDesignFileRef(`Chosen name.${format}`, 'saved', format, 'New Rocket', null);
      expect(saved.followsRocket).toBe(false);
      expect(designFileBase(saved, 'Renamed Rocket')).toBe('Chosen name');
      const opened = openedDesignFileRef(`Disk file.${format}`, format, 'New Rocket');
      expect(designFileBase(opened, 'Renamed Rocket')).toBe('Disk file');
      // The r3 rule accepts either the written or safe rocket name at save time.
      const typed = savedDesignFileRef(`New Rocket.${format}`, 'saved', format, 'New Rocket', null);
      expect(typed.followsRocket).toBe(true);
      expect(designFileBase(typed, 'Renamed Rocket')).toBe('Renamed_Rocket');
    }
  });

  it.each(['saved', 'downloaded'] as const)('keeps an existing non-following stem after a matching %s save and rename', via => {
    for (const format of ['ork', 'rkt', 'cdx1'] as const) {
      for (const previous of [
        { name: 'Goblin.ork', via: 'opened' as const, format: 'ork' as const },
        { name: 'Goblin.ork', via: 'opened' as const, format: 'ork' as const, followsRocket: false },
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
      for (const stem of [safeName('New Rocket'), safeName('My Rocket')]) {
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

  it.each(['opened', 'saved', 'downloaded'] as const)('rejects a malformed following flag for %s', via => {
    const old = { name: 'New_Rocket.ork', via, format: 'ork' };
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

it('r3 review: a content-sniffed file takes the extension of the saved format; a matching one keeps its own spelling', () => {
  // OpenRocket XML opened from a .rkt name, a backup name, and a name that merely ends in the letters ork.
  expect(offeredDesignFileName(openedDesignFileRef('reference.rkt', 'ork', 'reference'), 'reference', 'ork')).toBe('reference.ork');
  expect(offeredDesignFileName(openedDesignFileRef('unusual.backup', 'ork', 'Other'), 'Other', 'ork')).toBe('unusual.backup.ork');
  expect(offeredDesignFileName(openedDesignFileRef('fork', 'ork', 'fork'), 'fork', 'ork')).toBe('fork.ork');
  expect(offeredDesignFileName({ name: 'renamed.ork', via: 'saved', format: 'cdx1' }, 'renamed', 'cdx1')).toBe('renamed.CDX1');
  expect(designFileLabel({ name: 'renamed.ork', via: 'saved', format: 'cdx1', followsRocket: true }, 'renamed')).toBe('Save .CDX1 offers renamed.CDX1 — RASAero II file');
  expect(offeredDesignFileName(openedDesignFileRef('Skittles.ORK', 'ork', 'Skittles'), 'Skittles', 'ork')).toBe('Skittles.ORK');
});

it('r3 review: accepting the generic suggestion for a blank rocket name still follows a later name', () => {
  for (const blank of ['', '   ', undefined]) {
    const saved = savedDesignFileRef('rocket.ork', 'downloaded', 'ork', blank, null);
    expect(saved.followsRocket).toBe(true);
    expect(offeredDesignFileName(saved, 'Plastic', 'ork')).toBe('Plastic.ork');
  }
  // A typed name for a blank rocket does not follow.
  expect(savedDesignFileRef('mine.ork', 'saved', 'ork', '', null).followsRocket).toBe(false);
});
