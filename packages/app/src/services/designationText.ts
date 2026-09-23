/**
 * Two rules for comparing motor designations as TEXT, shared by the catalogue
 * matcher (motorDb.matchDbMotor) and the catalogue-free check of a stated
 * launch weight (statedLaunchWeight.namesSameMotor), so the two cannot drift.
 * They did (review of audit 2026-09-23): the matcher took Loki's “K1127-LB” for
 * RockSim's “K1127LB” and namesSameMotor did not, so a stage weight saved with
 * one spelling was cleared, as a different motor's, when the other loaded.
 *
 * Kept apart from motorDb because motorDb imports the 1,155-row catalogue, and
 * the .ork reader, which imports statedLaunchWeight, has no business pulling it
 * in.
 */

/**
 * Does `short` begin `long` without cutting a number in two — does the cut
 * fall anywhere but between two digits? “g11” does not begin “g115-wt”; “h128”
 * begins “h128w”, “g115” begins “g115-wt”, and “h128w” begins “h128w14a” (a
 * delay glued to AeroTech's propellant letter). A `short` with no digit in it
 * is no designation and begins nothing: a bare impulse letter, a propellant
 * word. (The matcher lets a catalogue designation with no digit, Quest's
 * “MICRO_MAXX_II”, begin a file's “MICRO_MAXX_II-1” — see its `stem`.)
 */
export function prefixWithoutSplit(short: string, long: string): boolean {
  if (!/\d/.test(short) || !long.startsWith(short)) return false;
  return !(/\d/.test(short.charAt(short.length - 1)) && /\d/.test(long.charAt(short.length)));
}

/**
 * A designation with its dashes, spaces and underscores dropped wherever they
 * do not stand between two digits, so the two spellings of one designation
 * compare equal: Loki's catalogue “M900-LR” and a RockSim file's “M900LR”,
 * “J-326-LR” and “J326LR”. Between two digits the separator is KEPT AS
 * WRITTEN: “G115-13A” is no G11513A, and “A8 3” is not Quest's “A8-3” — a
 * space there is how a file writes the common name and a delay, and equating
 * the two sent “A8 3” past Estes's A8 to Quest's out-of-production A8-3 at the
 * rank of an exact designation, with nothing on screen (review of audit
 * 2026-09-23). A SLASH is kept too: AeroTech's “G79W/L” is the single-use LMS
 * motor, and “G79W-L” the RMS reload G79W at its long delay (the nozzle
 * database's own row, nozzle-db.test.mjs), so the two must not compare equal.
 * So is the separator before a lone “P”, the plugged delay: “L1090 P” is a
 * common name and a delay, and dropping the space made it Cesaroni's
 * out-of-production 75 mm “L1090-P” (4815 Ns) exactly, where AeroTech's 54 mm
 * L1090W (2671 Ns) is the motor in production (same review).
 */
export function looseDesignation(s: string): string {
  return s.replace(/[-\s_]+/g, (sep: string, at: number, all: string) =>
    ((/\d/.test(all.charAt(at - 1)) && /\d/.test(all.charAt(at + sep.length)))
      || /^p(?:[-\s_/]|$)/i.test(all.slice(at + sep.length)) ? sep : ''));
}

/**
 * A Cesaroni-style total-impulse prefix a FILE writes before the common name:
 * RockSim's own EngineCode form “217-H135-WH-12A” (the impulse, a dash, the
 * common name, the propellant code, the delay), and the glued “217H135-WH-12A”.
 * Group 1 is the impulse in newton-seconds. Only a digit run followed by an
 * impulse letter and a digit is one, so Estes's “1/2A6-2” never is.
 */
export const IMPULSE_PREFIX = /^(\d+)[-\s_]?(?=[a-o]\d)/i;
