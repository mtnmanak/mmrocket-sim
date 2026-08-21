import { describe, expect, it, vi } from 'vitest';
import { CANONICAL_HOST, dismantlePwa, isRetiredHost } from './hostMigration.js';

describe('isRetiredHost', () => {
  it('flags the pre-rename subdomain', () => {
    expect(isRetiredHost('openrocket.mountainmanrockets.com')).toBe(true);
  });
  it('does not flag the canonical host, previews, or localhost', () => {
    expect(isRetiredHost(CANONICAL_HOST)).toBe(false);
    expect(isRetiredHost('abc123.online-open-rocket.pages.dev')).toBe(false);
    expect(isRetiredHost('localhost')).toBe(false);
  });
});

describe('dismantlePwa', () => {
  it('unregisters every SW registration and deletes every cache', async () => {
    const unregister = vi.fn().mockResolvedValue(true);
    vi.stubGlobal('navigator', {
      serviceWorker: { getRegistrations: vi.fn().mockResolvedValue([{ unregister }, { unregister }]) },
    });
    const del = vi.fn().mockResolvedValue(true);
    vi.stubGlobal('caches', { keys: vi.fn().mockResolvedValue(['a', 'b']), delete: del });
    await dismantlePwa();
    expect(unregister).toHaveBeenCalledTimes(2);
    expect(del).toHaveBeenCalledWith('a');
    expect(del).toHaveBeenCalledWith('b');
    vi.unstubAllGlobals();
  });
  it('never throws when SW/caches APIs are missing', async () => {
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('caches', undefined);
    await expect(dismantlePwa()).resolves.toBeUndefined();
    vi.unstubAllGlobals();
  });
});
