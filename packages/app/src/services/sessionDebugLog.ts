import { APP_VERSION } from '../version.js';
import type { Preferences } from '../prefs/preferences.js';
import type { AeroChoice } from '../prefs/aeroChoice.js';
import { UNITS, type Quantity } from '../prefs/units.js';

export const MAX_DEBUG_LOG_BYTES = 64 * 1024;
export const MAX_DEBUG_LOG_EVENTS = 200;
const EVENT_BYTES = 48 * 1024;

type DebugEvent = 'session-start' | 'preferences-changed' | 'uncaught-error' | 'unhandled-rejection'
  | 'worker-error' | 'worker-message-error' | 'app-error' | 'panel-error' | 'import-start' | 'import-failed'
  | 'import-complete' | 'launch-start' | 'launch-complete' | 'launch-failed' | 'debug-log-download';
const EVENTS: readonly DebugEvent[] = ['session-start', 'preferences-changed', 'uncaught-error', 'unhandled-rejection',
  'worker-error', 'worker-message-error', 'app-error', 'panel-error', 'import-start', 'import-failed',
  'import-complete', 'launch-start', 'launch-complete', 'launch-failed', 'debug-log-download'];

// C-H3: error text can contain the entire imported XML or a weather query.
// Retain only known diagnostic sentences; never stringify objects or stacks.
const SAFE_MESSAGES = new Set(['No stage found', 'Failed to fetch', 'Load failed', 'NetworkError when attempting to fetch resource.',
  'Script error.', 'No supported components found in this design.',
  'No supported components found in this RockSim design.', 'No supported components found in this RASAero design.',
  'Not a .ork file (root must be <openrocket>)', 'Not a .ork file (missing <rocket>)',
  'Not a RockSim design file (missing RocketDesign)', 'Not a RASAero design file (missing RocketDesign)',
  'Cache Storage is unavailable.', 'Empty .ork archive', 'File exceeds the design-file size limit.',
  'No .eng or .rse files found in that selection.', 'No motors found in .eng file', 'No <engine> entries in .rse file',
  'No presets found in that CSV.', 'No valid preset rows found.', 'Preset storage refused the import.']);

function diagnosticMessage(value: unknown): string {
  let name = ''; let message: unknown = value;
  try {
    if (value instanceof Error || value instanceof DOMException) {
      if (['Error', 'TypeError', 'ReferenceError', 'RangeError', 'SyntaxError', 'SecurityError', 'QuotaExceededError',
        'NotAllowedError', 'AbortError', 'NetworkError'].includes(value.name)) name = `${value.name}: `;
      message = value.message;
    }
    if (typeof message !== 'string' || message.length > 8192) return `${name}Message omitted for privacy`;
    if (SAFE_MESSAGES.has(message)) return name + message;
    if (/^Cannot read properties of (undefined|null) \(reading .+\)$/s.test(message)) {
      return `${name}Cannot read properties of ${message.startsWith('Cannot read properties of null') ? 'null' : 'undefined'} (property omitted)`;
    }
    if (message.startsWith('Failed to fetch dynamically imported module:')) return `${name}Failed to fetch dynamically imported module (URL omitted)`;
    if (/^(XML|RockSim XML|RASAero XML) parse error/.test(message)) return `${name}XML parse error (file detail omitted)`;
    if (message.startsWith('This file starts with a DOCTYPE')) return `${name}XML DOCTYPE refused (file detail omitted)`;
    if (message.startsWith('Not a RASP header line:')) return `${name}Not a RASP header line (file detail omitted)`;
    if (message.startsWith('Bad data line:')) return `${name}Bad data line (file detail omitted)`;
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
    if (typeof prefs[key] === 'boolean') out[key] = prefs[key];
  }
  if (aeroOverride === null || ['classic', 'supersonic', 'auto', 'hybrid'].includes(aeroOverride)) out['aeroOverride'] = aeroOverride;
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
      const ua = typeof navigator === 'undefined' || typeof navigator.userAgent !== 'string' ? 'Unavailable'
        : navigator.userAgent.slice(0, 1024).replace(/[\r\n]/g, ' ');
      const viewport = typeof window === 'undefined' ? 'Unavailable' : `${window.innerWidth} x ${window.innerHeight}`;
      return `MMRocket Sim session debug log\nApp version: ${APP_VERSION}\nBrowser UA: ${ua}\nViewport (CSS px): ${viewport}\n`
        + `Preferences (allowlisted): ${preferences}\nLimits: ${MAX_DEBUG_LOG_EVENTS} events, ${MAX_DEBUG_LOG_BYTES} UTF-8 bytes\n`
        + `Older events dropped: ${dropped}\nElapsed times since capture began; no design, files, locations or weather search text.\n`
        + `Unknown error messages and stack traces are omitted for privacy. Errors before capture loaded are unavailable.\n\n`
        + Array.from({ length: count }, (_, i) => rows[(head + i) % MAX_DEBUG_LOG_EVENTS]!.text).join('');
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
