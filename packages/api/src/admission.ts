import { kernelPoisoned, KernelUnavailableError } from '../../app/src/headless/index.js';

export class KernelBusy extends Error {
  constructor() { super('Kernel admission slots are full.'); }
}
let admitted = 0;
/** A pre-upload hint; kernelJob repeats it atomically after the upload. */
export const kernelBusy = () => admitted >= 3;
/** Import, kernel work and describe's compression settle before this slot is returned. */
export async function kernelJob<T>(work: () => Promise<T>): Promise<T> {
  if (kernelPoisoned()) throw new KernelUnavailableError();
  if (kernelBusy()) throw new KernelBusy();
  admitted++;
  try { return await work(); }
  finally { admitted--; }
}
