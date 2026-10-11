import { expect, it, vi } from 'vitest';
import { gateLossySave, lossySaveStatus, replacementLossNote, validLossySaveMark } from './lossySave.js';
it('writes synchronously only when there is nothing to tell, otherwise opens the gate', () => {
  const save = vi.fn(); const show = vi.fn();
  gateLossySave({ format: 'rkt', refused: null, losses: [] }, save, show);
  expect(save).toHaveBeenCalledOnce(); expect(show).not.toHaveBeenCalled();
  for (const report of [{ format: 'rkt' as const, refused: null, losses: ['rail buttons'] },
    { format: 'cdx1' as const, refused: 'No fins', losses: [] }]) {
    save.mockClear(); gateLossySave(report, save, show);
    expect(save).not.toHaveBeenCalled(); expect(show).toHaveBeenLastCalledWith(report);
  }
});
it('only shows a lossy save for its snapshot and flight count', () => {
  const saved = { mark: 'a', flights: 1, format: 'rkt' as const, lossCount: 1 };
  expect(lossySaveStatus(saved, 'a', 1)).toBe('Saved as .rkt — 1 not kept');
  expect(lossySaveStatus(saved, 'b', 1)).toBe('Unsaved changes');
  expect(lossySaveStatus(saved, 'a', 2)).toBe('Unsaved changes');
  expect(lossySaveStatus({ ...saved, lossCount: 0 }, 'a', 1)).toBe('Saved as .rkt, not .ork');
  // A check that did not finish has no count to show.
  expect(lossySaveStatus({ ...saved, incomplete: true }, 'a', 1)).toBe('Saved as .rkt — not fully checked');
  expect(lossySaveStatus({ ...saved, incomplete: true }, 'b', 1)).toBe('Unsaved changes');
});
it('validates saved format, fingerprint, flight count and loss count', () => {
  const saved = { mark: 'a', flights: 3, format: 'rkt' as const, lossCount: 2 };
  const file = { name: 'a.rkt', via: 'saved' as const, format: 'rkt' as const };
  expect(validLossySaveMark(saved, file, 'a')).toEqual(saved);
  expect(validLossySaveMark({ ...saved, incomplete: true }, file, 'a')).toEqual({ ...saved, incomplete: true });
  expect(validLossySaveMark({ ...saved, incomplete: 'yes' }, file, 'a')).toEqual(saved);
  expect(validLossySaveMark(saved, file, 'b')).toBeNull();
  expect(validLossySaveMark(saved, undefined, 'a')).toBeNull();
  expect(validLossySaveMark(saved, { ...file, via: 'opened' }, 'a')).toBeNull();
  for (const bad of [null, [], { ...saved, format: 'ork' }, { ...saved, format: 'cdx1' },
    { ...saved, flights: -1 }, { ...saved, flights: 1.5 }, { ...saved, lossCount: -1 },
    { ...saved, lossCount: Infinity }, { ...saved, lossCount: '2' }, { ...saved, mark: null }])
    expect(validLossySaveMark(bad, file, 'a')).toBeNull();
});
it('names opened/saved files and abbreviates replacement losses', () => {
  const report = { format: 'rkt' as const, refused: null, losses: ['one', 'two', 'three', 'four'] };
  expect(replacementLossNote({ name: 'x.rkt', via: 'opened', format: 'rkt' }, report)).toBe('You opened “x.rkt”, but it does not keep: one; two; three…');
  expect(replacementLossNote(null, report)).toBeNull();
  expect(replacementLossNote({ name: 'x.rkt', via: 'saved', format: 'rkt' }, { format: 'rkt', refused: null, incomplete: true, losses: ['The app could not finish checking.'] }))
    .toBe('You saved “x.rkt”. The app could not finish checking.');
});
