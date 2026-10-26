/** Embedded-design, motor-file and whole-selection import ceilings. */
export const MAX_EMBEDDED_EX_MOTORS = 1024;
export const MAX_EX_IMPORT_BYTES = 16 * 1024 * 1024;
export const EX_IMPORT_BYTES_NOTE = `Motor file limit is ${MAX_EX_IMPORT_BYTES / (1024 * 1024)} MiB; this file was not read.`;

export const MAX_EX_MOTOR_SAMPLES = 100_000;
export const EX_SAMPLE_LIMIT_NOTE = `more than ${MAX_EX_MOTOR_SAMPLES} thrust samples`;

export const MAX_EX_IMPORT_FILES = 1000;
export const MAX_EX_SELECTION_BYTES = 32 * 1024 * 1024;
export const MAX_EX_IMPORT_MOTORS = 10_000;
export const EX_MOTOR_COUNT_NOTE = `Motor count limit is ${MAX_EX_IMPORT_MOTORS.toLocaleString('en-US')} per import; split the collection into smaller selections.`;
