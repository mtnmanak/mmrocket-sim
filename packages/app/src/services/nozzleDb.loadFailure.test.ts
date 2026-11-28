import { afterEach, expect, it, vi } from 'vitest';
import { loadNozzleDb, nozzleDbFailed, publishedExitSync, resetNozzleDbCache, subscribeNozzleDb } from './nozzleDb.js';
import nozzles from '../data/nozzles.json';
import { nozzleData } from './nozzleData.js';

afterEach(() => { vi.restoreAllMocks(); resetNozzleDbCache(); });

it('J23N r3 real loader announces failure, coalesces retries and recovers on a later call', async () => {
  resetNozzleDbCache();
  const row = nozzles.motors.find(m => m.motorId && m.exitDiameterM)!;
  const changed = vi.fn();
  const unsubscribe = subscribeNozzleDb(changed);
  try {
    const loader = vi.spyOn(nozzleData, 'load').mockRejectedValueOnce(new Error('offline chunk'));
    expect(await loadNozzleDb()).toBe('failed');
    expect(nozzleDbFailed()).toBe(true);
    expect(publishedExitSync(row.motorId!)).toBeNull();
    expect(changed).toHaveBeenCalledOnce();
    expect(loader).toHaveBeenCalledOnce();
    const retry = loadNozzleDb();
    expect(loadNozzleDb()).toBe(retry);
    expect(await retry).toBe('ready');
    expect(nozzleDbFailed()).toBe(false);
    expect(publishedExitSync(row.motorId!)).toBeCloseTo(row.exitDiameterM!, 12);
    expect(changed).toHaveBeenCalledTimes(2);
  } finally { unsubscribe(); }
});
