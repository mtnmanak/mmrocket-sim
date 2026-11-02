// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest';
import * as library from './exMotors.js';
import { importMotorFiles } from './importMotorFiles.js';

it('R4 tiers only the displayed notice when recovery text is in the error', async () => {
  const spy = vi.spyOn(library, 'addExMotors').mockReturnValueOnce({
    stored: false, backedUp: true, motors: [], duplicates: ['R99'], replaced: [],
  });
  try {
    const result = await importMotorFiles([new File(['R99 29 100 P 0.05 0.1 Maker\n0 0\n0.5 20\n1 0'], 'r.eng')]);
    expect(result.error).toContain('recovery copy');
    expect(result.notice).toContain('listed more than once');
    expect(result.notice).not.toContain('recovery copy');
    expect(result.tier).toBe('caution');
    expect(result.noticeTier).toBe('information');
  } finally { spy.mockRestore(); }
});
