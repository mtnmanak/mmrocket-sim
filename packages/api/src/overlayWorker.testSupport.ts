import './networkTrap.testSupport.js';
import { setCatalogueOverlay, MOTOR_DB_DATE, MOTOR_DB } from '../../app/src/services/motorDb.js';
import { SNAPSHOT_ADDED } from './snapshotOverlay.testSupport.js';
// Only the missing-curve isolate changes catalogue state, making network:'allow' observable.
// A curated-snapshot overlay (row 110) with one added motor: under it a shipped
// motor with no bundled curve, and an added one, would read the snapshot's
// curves file if the network were allowed — the API must still ask nothing.
const id = `${Number(MOTOR_DB_DATE.slice(0, 4)) + 1}-01-01`;
setCatalogueOverlay({ baseGenerated: MOTOR_DB_DATE, fetchedAt: `${id}T00:00:00Z`,
  liveCount: MOTOR_DB.length + 1, added: [SNAPSHOT_ADDED], changed: [], removed: [], rejected: [],
  snapshot: { id, generated: id, motorsSha256: 'a'.repeat(64),
    curves: { path: `v1/${id}/motorCurves.json`, bytes: 1000, sha256: 'b'.repeat(64) } } });
export { default } from './trappedWorker.testSupport.js';
