export class KernelBusy extends Error {
  constructor() { super('Kernel admission slots are full.'); }
}
let admitted = 0;
/** Import, kernel work and describe's compression settle before this slot is returned. */
export async function kernelJob<T>(work: () => Promise<T>): Promise<T> {
  if (admitted >= 3) throw new KernelBusy();
  admitted++;
  try { return await work(); }
  finally { admitted--; }
}
