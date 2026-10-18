import { APP_VERSION } from '../version.js';
import type { Preferences } from '../prefs/preferences.js';
import { AERO_NAME, type AeroChoice } from '../prefs/aeroChoice.js';
import { UNITS, type Quantity } from '../prefs/units.js';
import { EX_IMPORT_BYTES_NOTE, MAX_EX_MOTOR_SAMPLES } from './exMotorLimits.js';
import { MAX_MACH_ALT_ROWS } from './machAltLimits.js';

export const MAX_DEBUG_LOG_BYTES = 64 * 1024;
export const MAX_DEBUG_LOG_EVENTS = 200;
const EVENT_BYTES = 48 * 1024;

type DebugEvent = 'session-start' | 'preferences-changed' | 'uncaught-error' | 'unhandled-rejection'
  | 'worker-error' | 'worker-message-error' | 'app-error' | 'panel-error' | 'import-start' | 'import-failed'
  | 'import-complete' | 'import-storage-failed' | 'launch-start' | 'launch-complete' | 'launch-failed' | 'debug-log-download';
const EVENTS: readonly DebugEvent[] = ['session-start', 'preferences-changed', 'uncaught-error', 'unhandled-rejection',
  'worker-error', 'worker-message-error', 'app-error', 'panel-error', 'import-start', 'import-failed',
  'import-complete', 'import-storage-failed', 'launch-start', 'launch-complete', 'launch-failed', 'debug-log-download'];

// C-H3: error text can contain the entire imported XML or a weather query.
// Retain only known diagnostic sentences; never stringify objects or stacks.
const SAFE_MESSAGES = new Set(['No stage found', 'Failed to fetch', 'Load failed', 'NetworkError when attempting to fetch resource.',
  EX_IMPORT_BYTES_NOTE,
  `Mach-Alt table exceeds the limit of ${MAX_MACH_ALT_ROWS.toLocaleString('en-US')} distinct rows.`,
  'Script error.', 'No supported components found in this design.',
  'No supported components found in this RockSim design.', 'No supported components found in this RASAero design.',
  'Not a .ork file (root must be <openrocket>)', 'Not a .ork file (missing <rocket>)',
  'Not a RockSim design file (missing RocketDesign)', 'Not a RASAero design file (missing RocketDesign)',
  'Cache Storage is unavailable.', 'Empty .ork archive', 'Empty .rkt archive', 'Empty .CDX1 archive',
  'File exceeds the design-file size limit.',
  'No .eng or .rse files found in that selection.', 'No motors found in .eng file', 'No <engine> entries in .rse file',
  'Motor storage is full or blocked; imported motors are available only for this session.',
  'No presets found in that CSV.', 'No valid preset rows found.', 'Preset storage refused the import.',
  'not a share link (missing the d=<version>.<data> payload)', 'the compressed data is corrupt or cut short',
  'the link is far longer than any real design — refusing to decode it',
  "this browser can't unpack share links. Open the link in Chrome or Edge 103, Firefox 113 or Safari 16.4 (iPhone and iPad: iOS 16.4) or later — or ask for the .ork file, which opens here.",
  'This is an older BINARY RockSim file, not the XML .rkt this app reads. Open it in RockSim and re-save (RockSim 9 writes XML), or export it as .ork — either opens here.']);

// C-H3: these refusals contain only format names and counts, never user text.
const SAFE_IMPORT_MESSAGES = [
  /^this link was made by a newer version of the app \(format [0-9]+\)$/,
  /^this link expands past [0-9]+ MB — that is not a rocket design$/,
  /^This archive lists [0-9,]+ entries, past the [0-9,]+ this app will read — that is not a rocket design\.$/,
  /^Not a readable (\.ork|\.rkt|\.CDX1) archive — (it has no end-of-directory record|its directory lists [0-9]+ entries, more than [0-9]+ bytes can hold|directory entry [0-9]+ of [0-9]+ (is missing|runs past the end of the file|has no zip64 sizes))\.$/,
  /^Not a readable compressed (\.ork|\.rkt|\.CDX1) file — it is damaged \((part [0-9]+ of [0-9]+ )?does not match its own checksum — the file is cut short or corrupted\)\.$/,
  /^This compressed (\.ork|\.rkt|\.CDX1) file expands past the [0-9]+ MB this app will open — that is not a rocket design\.$/,
  /^This design has [0-9,]+ parts, past the [0-9,]+ the app will open\. Desktop OR has no such limit\.$/,
  /^This \.ork file declares [0-9]+ flight configurations, past the [0-9]+ the app will open\. Reduce the configurations in OpenRocket and save it again\.$/,
  /^This file would open as more than [0-9]+ flight configurations, past the [0-9]+ the app will open\. Reduce the simulations in (RockSim|RASAero) and save it again\.$/,
];

// C-H3: motor parsers name refused motors and may quote raw values. Return fixed categories only.
const MOTOR_NUMBER = '(?:NaN|-?Infinity|-?[0-9]+(?:\\.[0-9]+)?(?:e[+-]?[0-9]+)?)';
const SAFE_MOTOR_REFUSALS: readonly [RegExp, string][] = [
  [/^[\s\S]+: fewer than two distinct thrust points$/, 'fewer than two distinct thrust points'],
  [new RegExp(`^[\\s\\S]+: more than ${MAX_EX_MOTOR_SAMPLES} thrust samples$`), 'thrust sample limit exceeded'],
  [/^[\s\S]+: initial mass \(initWt\) missing or zero$/, 'initial mass missing or zero'],
  [new RegExp(`^[\\s\\S]+: loaded mass ${MOTOR_NUMBER} g is not a mass$`), 'invalid loaded mass'],
  [new RegExp(`^[\\s\\S]+: propellant mass ${MOTOR_NUMBER} g is not a mass$`), 'invalid propellant mass'],
  [new RegExp(`^[\\s\\S]+: more propellant \\(${MOTOR_NUMBER} g\\) than loaded mass \\(${MOTOR_NUMBER} g\\)$`), 'propellant exceeds loaded mass'],
  [/^Propellant and total mass must be numbers in "[\s\S]*" — read "[\s\S]*" and "[\s\S]*"\.$/, 'nonnumeric mass'],
  [/^[\s\S]+: diameter\/length missing or not a positive number$/, 'invalid diameter/length'],
  [/^[\s\S]+: diameter \(dia\) missing or not a positive number$/, 'invalid diameter'],
  [/^[\s\S]+: length \(len\) missing or not a positive number$/, 'invalid length'],
  [/^[\s\S]+: no thrust data$/, 'no thrust data'],
  [/^[\s\S]+: data point [0-9]+ of [0-9]+ cannot be read \([\s\S]*\)$/, 'unreadable thrust data'],
  [new RegExp(`^[\\s\\S]+: data point [0-9]+ has negative time or thrust \\(${MOTOR_NUMBER}, ${MOTOR_NUMBER}\\)$`), 'negative time or thrust'],
];

function diagnosticMessage(value: unknown): string {
  let name = ''; let message: unknown = value;
  try {
    if (value instanceof Error || value instanceof DOMException) {
      const errorName = value.name;
      if (['Error', 'TypeError', 'ReferenceError', 'RangeError', 'SyntaxError', 'SecurityError', 'QuotaExceededError',
        'NotAllowedError', 'AbortError', 'NetworkError'].includes(errorName)) name = `${errorName}: `;
      message = value.message;
    }
    if (typeof message !== 'string' || message.length > 8192) return `${name}Message omitted for privacy`;
    if (SAFE_MESSAGES.has(message)) return name + message;
    for (const pattern of SAFE_IMPORT_MESSAGES) if (pattern.test(message)) return name + message;
    if (/^Cannot read properties of (undefined|null) \(reading .+\)$/s.test(message)) {
      return `${name}Cannot read properties of ${message.startsWith('Cannot read properties of null') ? 'null' : 'undefined'} (property omitted)`;
    }
    if (message.startsWith('Failed to fetch dynamically imported module:')) return `${name}Failed to fetch dynamically imported module (URL omitted)`;
    if (/^(?:Not a valid (?:\.ork|RockSim|RASAero) file \(XML parse error\)|Not valid XML \(\.rse\))(?:$| — )/.test(message)) {
      return `${name}XML parse error (file detail omitted)`;
    }
    const archive = /^(Not a readable (?:\.ork|\.rkt|\.CDX1) archive|Not a readable compressed (?:\.ork|\.rkt|\.CDX1) file) — /.exec(message);
    if (archive?.[1]) return `${name}${archive[1]} (file detail omitted)`;
    const member = /^“[\s\S]*” in this archive (expands to [0-9]+ MB, past the [0-9]+ MB this app will open — that is not a rocket design\.|inflates past the [0-9,]+ bytes its directory declares — the archive is damaged or crafted, not a rocket design\.)$/.exec(message);
    if (member?.[1]) return `${name}Archive member ${member[1]} (file name omitted)`;
    if (message.startsWith('This file starts with a DOCTYPE')) return `${name}XML DOCTYPE refused (file detail omitted)`;
    if (message.startsWith('Not a RASP header line:')) return `${name}Not a RASP header line (file detail omitted)`;
    if (message.startsWith('Bad data line:')) return `${name}Bad data line (file detail omitted)`;
    const motorRefusals = new Set<string>();
    for (const part of message.split(' · ')) {
      const refusal = SAFE_MOTOR_REFUSALS.find(([pattern]) => pattern.test(part));
      if (refusal) motorRefusals.add(refusal[1]);
    }
    if (motorRefusals.size) return `${name}Motor import refused: ${[...motorRefusals].join('; ')} (file detail omitted)`;
    return `${name}Message omitted for privacy`;
  } catch { return 'Message omitted for privacy'; }
}

function eventDetail(event: Event, rejection = false): unknown {
  try {
    if (rejection) return (event as PromiseRejectionEvent).reason;
    const error = event as ErrorEvent;
    return error.error ?? error.message;
  } catch { return 'Message omitted for privacy'; }
}

function diagnosticPreferences(prefs: Preferences, aeroOverride: AeroChoice | null) {
  const out: Record<string, unknown> = {};
  for (const [key, choices] of Object.entries({
    theme: ['light', 'dark', 'system'], radiusMode: ['radius', 'diameter'],
    aeroModel: ['classic', 'supersonic', 'auto', 'hybrid'], markers3d: ['both', 'callout', 'axis', 'off'],
    stabilityUnit: ['cal', 'pct', 'both'], configurationSort: ['creation', 'name', 'name-desc', 'motor', 'motor-desc'],
  })) {
    const value = prefs[key as keyof Preferences];
    if (typeof value === 'string' && choices.includes(value)) out[key] = value;
  }
  for (const key of ['daylight', 'rogersKbf', 'rulers2d', 'tourOff'] as const) {
    const value = prefs[key];
    if (typeof value === 'boolean') out[key] = value;
  }
  if (aeroOverride === null || (typeof aeroOverride === 'string' && Object.prototype.hasOwnProperty.call(AERO_NAME, aeroOverride))) out['aeroOverride'] = aeroOverride;
  out['units'] = Object.fromEntries((Object.keys(UNITS) as Quantity[]).flatMap(q => {
    const symbol = prefs.units?.[q];
    return typeof symbol === 'string' && UNITS[q].some(u => u.symbol === symbol) ? [[q, symbol]] : [];
  }));
  return out;
}

export function createSessionDebugLog() {
  const started = Date.now();
  const encoder = new TextEncoder();
  const rows: ({ text: string; bytes: number } | undefined)[] = new Array(MAX_DEBUG_LOG_EVENTS);
  let head = 0; let count = 0; let bytes = 0; let dropped = 0; let recording = false; let preferences = '{}';
  const dropOldest = () => {
    bytes -= rows[head]!.bytes;
    rows[head] = undefined;
    head = (head + 1) % MAX_DEBUG_LOG_EVENTS;
    count--; dropped++;
  };
  const record = (event: DebugEvent, detail?: unknown) => {
    if (recording || !EVENTS.includes(event)) return;
    recording = true;
    try {
      const line = `${Date.now() - started}ms ${event}${detail === undefined ? '' : `: ${diagnosticMessage(detail)}`}\n`;
      const size = encoder.encode(line).byteLength;
      if (count === MAX_DEBUG_LOG_EVENTS) dropOldest();
      rows[(head + count) % MAX_DEBUG_LOG_EVENTS] = { text: line, bytes: size };
      count++; bytes += size;
      while (bytes > EVENT_BYTES) dropOldest();
    } catch { /* Diagnostics must not turn an app failure into another failure. */ }
    finally { recording = false; }
  };
  return {
    record,
    preferences(prefs: Preferences, aeroOverride: AeroChoice | null = null) {
      try {
        const next = JSON.stringify(diagnosticPreferences(prefs, aeroOverride));
        if (next !== preferences) { preferences = next; record('preferences-changed'); }
      } catch { /* A corrupt preference object cannot stop the app. */ }
    },
    watchWorker(worker: EventTarget): () => void {
      const error = (event: Event) => {
        record('worker-error', eventDetail(event));
      };
      const messageError = () => record('worker-message-error');
      worker.addEventListener('error', error); worker.addEventListener('messageerror', messageError);
      return () => { worker.removeEventListener('error', error); worker.removeEventListener('messageerror', messageError); };
    },
    text(): string {
      const userAgent = typeof navigator === 'undefined' ? undefined : navigator.userAgent;
      const ua = typeof userAgent !== 'string' ? 'Unavailable' : userAgent.slice(0, 1024).replace(/[\r\n]/g, ' ');
      const viewport = typeof window === 'undefined' ? 'Unavailable' : `${window.innerWidth} x ${window.innerHeight}`;
      const events = Array.from({ length: count }, (_, i) => rows[(head + i) % MAX_DEBUG_LOG_EVENTS]!.text).join('');
      const text = `MMRocket Sim session debug log\nApp version: ${APP_VERSION}\nBrowser UA: ${ua}\nViewport (CSS px): ${viewport}\n`
        + `Preferences (allowlisted): ${preferences}\nLimits: ${MAX_DEBUG_LOG_EVENTS} events, ${MAX_DEBUG_LOG_BYTES} UTF-8 bytes\n`
        + `Older events dropped: ${dropped}\nElapsed times since capture began; no design, files, locations or weather search text.\n`
        + `Unknown error messages and stack traces are omitted for privacy. Errors before capture loaded are unavailable.\n\n`
        + events;
      // C-H3: context is outside the event budget; keep its growth inside the export cap too.
      if (encoder.encode(text).byteLength > MAX_DEBUG_LOG_BYTES) {
        return `MMRocket Sim session debug log\nContext omitted: export size limit.\nOlder events dropped: ${dropped}\n\n${events}`;
      }
      return text;
    },
  };
}

export const sessionDebugLog = createSessionDebugLog();

export function startSessionDebugCapture(target: EventTarget = window, log = sessionDebugLog): () => void {
  const error = (event: Event) => log.record('uncaught-error', eventDetail(event));
  const rejection = (event: Event) => log.record('unhandled-rejection', eventDetail(event, true));
  target.addEventListener('error', error); target.addEventListener('unhandledrejection', rejection);
  log.record('session-start');
  return () => { target.removeEventListener('error', error); target.removeEventListener('unhandledrejection', rejection); };
}
