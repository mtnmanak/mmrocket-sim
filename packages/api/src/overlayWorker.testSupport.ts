import './networkTrap.testSupport.js';
import { setCatalogueOverlay, MOTOR_DB_DATE, MOTOR_DB } from '../../app/src/services/motorDb.js';
// Only the missing-curve isolate changes catalogue state, making network:'allow' observable.
setCatalogueOverlay({ baseGenerated: MOTOR_DB_DATE, fetchedAt: `${Number(MOTOR_DB_DATE.slice(0, 4)) + 1}-01-01T00:00:00Z`,
  liveCount: MOTOR_DB.length, added: [], changed: [], removed: [], rejected: [] });
export { default } from './trappedWorker.testSupport.js';
