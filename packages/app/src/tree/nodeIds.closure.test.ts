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

it('mints distinct restorable IDs when randomUUID is unavailable', async () => {
  vi.resetModules();
  const { reserveNodeIds, freshId } = await import('./treeModel.js');
  reserveNodeIds([`c${2 ** 50 - 1}`]);
  const descriptor = Object.getOwnPropertyDescriptor(crypto, 'randomUUID');
  try {
    Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: undefined });
    const ids = [freshId(), freshId()];
    expect(ids[0]).not.toBe(ids[1]);
    expect(ids.every(id => !/^c\d+$/.test(id))).toBe(true);
    vi.resetModules();
    const reloaded = await import('./treeModel.js');
    reloaded.reserveNodeIds([`c${2 ** 50 - 1}`, ...ids]);
    expect(ids).not.toContain(reloaded.freshId());
  } finally {
    if (descriptor) Object.defineProperty(crypto, 'randomUUID', descriptor);
    else Reflect.deleteProperty(crypto, 'randomUUID');
  }
});
