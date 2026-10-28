import { MOTOR_DB } from '../../app/src/services/motorDb.js';

/**
 * A motor a curated-snapshot overlay added (overlayWorker.testSupport.ts): a
 * C6 under a new id and name. Its own module, importing only motorDb, because
 * the overlay isolate's bundle can carry no node: module and no vitest.
 */
export const SNAPSHOT_ADDED = { ...MOTOR_DB.find((m) => m.manufacturerAbbrev === 'Estes' && m.designation === 'C6')!,
  motorId: 'api-snapshot-added', designation: 'C99', commonName: 'C99' };
