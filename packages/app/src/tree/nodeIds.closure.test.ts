import { expect, it, vi } from 'vitest';

it('does not mint unreservable numeric ids at the restore boundary or after reload', async () => {
  const { reserveNodeIds, freshId } = await import('./treeModel.js');
  const near = `c${2 ** 50 - 1}`;
  reserveNodeIds([near]);
  const first = freshId();
  expect(first).not.toBe(`c${2 ** 50}`);
  vi.resetModules();
  const reloaded = await import('./treeModel.js');
  reloaded.reserveNodeIds([near, first]);
  expect(reloaded.freshId()).not.toBe(first);
});
