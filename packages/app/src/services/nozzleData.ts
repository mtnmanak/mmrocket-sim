/** Lazy chunk boundary; separate from the lookup state machine for fault injection. */
export const nozzleData = { load: () => import('../data/nozzles.json') };
