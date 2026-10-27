/** Non-browser entry only. The host installs the parser once at module scope. */
import { simulateFile as simulateFileService, type SimulateFileOptions } from '../services/simulateFile.js';
export type { TimedSimulateFileResult } from '../services/simulateFile.js';

/** No macrotask boundary inside the kernel lock, hence no host cancellation point there. */
export function simulateFile(
  data: ArrayBuffer | Uint8Array, fileName: string, options: SimulateFileOptions = {},
) {
  return simulateFileService(data, fileName, { ...options, yieldToUi: options.yieldToUi ?? (() => Promise.resolve()) });
}
export { setXmlParser, XmlBudgetExceededError } from '../services/xmlParse.js';
export { jsXmlParser, createJsXmlParser } from '../services/xmlParseJs.js';
export { KernelUnavailableError, SimulateDesignError } from '../services/simulateDesign.js';
export { InflatedFileTooLargeError } from '../services/zipMember.js';
export { MAX_DESIGN_FILE_BYTES, designFileTooLarge } from '../services/designFile.js';
export { APP_VERSION } from '../version.js';
export { MOTOR_DB_DATE as MOTORS_GENERATED } from '../services/motorDb.js';
export { generated as CURVES_GENERATED } from '../data/motorCurves.json';
export { mountMotorCount } from '../tree/treeModel.js';
export { motorMounts } from '../tree/treeModel.js';
export { mountNamesOf } from '../services/designDerivation.js';
export { resolveFlightState } from '../services/flightState.js';
export { commentsOf } from '../services/simReport.js';
export { formatWarning } from '../services/simWarnings.js';
export { describeFile, type DescribeFileResult } from '../services/describeFile.js';
export { SHARE_TOO_LARGE_ERROR_NAME } from '../services/shareLink.js';
