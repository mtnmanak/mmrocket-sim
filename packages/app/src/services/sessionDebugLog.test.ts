// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSessionDebugLog, MAX_DEBUG_LOG_BYTES, MAX_DEBUG_LOG_EVENTS, startSessionDebugCapture } from './sessionDebugLog.js';
import { DEFAULT_PREFS } from '../prefs/preferences.js';

const context = vi.hoisted(() => ({ version: 'test-version' }));
vi.mock('../version.js', () => ({ get APP_VERSION() { return context.version; } }));
afterEach(() => { context.version = 'test-version'; vi.restoreAllMocks(); });

describe('C-H3 session diagnostics', () => {
  it('serializes only the browser UA value that was checked when its getter changes', () => {
    const log = createSessionDebugLog();
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValueOnce('Test browser').mockReturnValue('Private design 61.234 Fairbanks');
    const text = log.text();
    expect(text).toContain('Browser UA: Test browser');
    for (const secret of ['Private', '61.234', 'Fairbanks']) expect(text).not.toContain(secret);
  });

  it('serializes only the error name that was validated, even when its getter changes', () => {
    const log = createSessionDebugLog();
    let reads = 0;
    const error = new Error('No stage found');
    Object.defineProperty(error, 'name', { get: () => ++reads === 1 ? 'Error' : 'Private design 61.234 Fairbanks' });
    log.record('uncaught-error', error);
    expect(log.text()).toContain('uncaught-error: Error: No stage found');
    for (const secret of ['Private', '61.234', 'Fairbanks']) expect(log.text()).not.toContain(secret);
  });

  it.each(['daylight', 'rogersKbf', 'rulers2d', 'tourOff'] as const)('serializes only the validated %s preference when its getter changes', key => {
    const log = createSessionDebugLog();
    const prefs = { ...DEFAULT_PREFS };
    let reads = 0;
    Object.defineProperty(prefs, key, { get: () => ++reads === 1 ? true : 'Private design 61.234 Fairbanks'.repeat(4000) });
    log.preferences(prefs);
    const text = log.text();
    expect(text).toContain(`"${key}":true`);
    for (const secret of ['Private', '61.234', 'Fairbanks']) expect(text).not.toContain(secret);
    expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(MAX_DEBUG_LOG_BYTES);
  });

  it('caps the complete UTF-8 export when context alone exceeds the limit, retaining events', () => {
    const log = createSessionDebugLog();
    // Oversized public build metadata must not bypass the export budget.
    context.version = '🛰'.repeat(24000);
    for (let i = 0; i < MAX_DEBUG_LOG_EVENTS; i++) log.record('import-failed', new Error('No stage found'));
    const text = log.text();
    expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(MAX_DEBUG_LOG_BYTES);
    expect(text).toContain('Context omitted: export size limit.');
    expect(text.match(/import-failed/g)).toHaveLength(MAX_DEBUG_LOG_EVENTS);
    expect(text).not.toContain('�');
  });

  it('retains the newest events, drops old ones, and caps the UTF-8 download', () => {
    const log = createSessionDebugLog();
    log.record('import-start');
    for (let i = 0; i < MAX_DEBUG_LOG_EVENTS + 10; i++) log.record('import-failed', new Error('No stage found'));
    const text = log.text();
    expect(text).not.toContain('import-start');
    expect(text.match(/import-failed/g)).toHaveLength(MAX_DEBUG_LOG_EVENTS);
    expect(text).toContain('Older events dropped: 11');
    log.record('uncaught-error', new Error('🛰'.repeat(100000)));
    expect(new TextEncoder().encode(log.text()).byteLength).toBeLessThanOrEqual(MAX_DEBUG_LOG_BYTES);
  });

  it('keeps useful safe messages and never serializes user input, XML, paths, locations or error stacks', () => {
    const log = createSessionDebugLog();
    log.record('import-failed', new Error('No stage found'));
    const privateText = 'Secret rocket private.ork <rocket><name>Private</name></rocket> 61.234,-149.123 Fairbanks';
    const error = new TypeError(`Cannot read properties of undefined (reading '${privateText}')`);
    error.stack = privateText;
    log.record('uncaught-error', error);
    log.record('unhandled-rejection', privateText);
    log.record('worker-error', new Error('Failed to fetch dynamically imported module: https://private.test/?weather=Fairbanks'));
    log.record('import-failed', new Error(`C:\\Users\\Eric\\${privateText}`));
    const text = log.text();
    expect(text).toContain('No stage found');
    expect(text).toContain('TypeError: Cannot read properties of undefined (property omitted)');
    expect(text).toContain('Failed to fetch dynamically imported module (URL omitted)');
    for (const value of ['Secret', 'private.ork', '<rocket>', '61.234', '-149.123', 'Fairbanks', 'private.test', 'Eric']) {
      expect(text).not.toContain(value);
    }
  });

  it('allowlists diagnostic preferences and excludes design and launch data even in a corrupt store', () => {
    const log = createSessionDebugLog();
    log.preferences({ ...DEFAULT_PREFS, theme: 'light', daylight: true, configurationSort: 'motor',
      units: { ...DEFAULT_PREFS.units, length: 'private weather search' },
      aeroModel: 'supersonic', latitude: 61.234, tree: 'private design', weatherSearch: 'Fairbanks',
    } as unknown as typeof DEFAULT_PREFS, 'hybrid');
    const text = log.text();
    expect(text).toContain('"theme":"light"');
    expect(text).toContain('"configurationSort":"motor"');
    expect(text).toContain('"aeroOverride":"hybrid"');
    for (const value of ['private', '61.234', 'Fairbanks', 'latitude', 'tree', 'weatherSearch']) expect(text).not.toContain(value);
  });

  it('captures window and worker errors once and removes listeners when stopped', () => {
    const log = createSessionDebugLog(); const target = new EventTarget(); const worker = new EventTarget();
    const stop = startSessionDebugCapture(target, log);
    const stopWorker = log.watchWorker(worker);
    target.dispatchEvent(new ErrorEvent('error', { error: new Error('No stage found') }));
    const rejected = new Event('unhandledrejection');
    Object.defineProperty(rejected, 'reason', { value: new TypeError('Failed to fetch') });
    target.dispatchEvent(rejected);
    worker.dispatchEvent(new ErrorEvent('error', { message: 'Failed to fetch' }));
    worker.dispatchEvent(new Event('messageerror'));
    expect(log.text()).toContain('uncaught-error: Error: No stage found');
    expect(log.text()).toContain('unhandled-rejection: TypeError: Failed to fetch');
    expect(log.text()).toContain('worker-error: Failed to fetch');
    expect(log.text()).toContain('worker-message-error');
    stop(); stopWorker(); const before = log.text();
    target.dispatchEvent(new ErrorEvent('error', { message: 'No stage found' }));
    worker.dispatchEvent(new Event('error'));
    expect(log.text()).toBe(before);
  });

  it('survives event payload getters that throw while still recording that an error occurred', () => {
    const target = new EventTarget(); const log = createSessionDebugLog();
    const stop = startSessionDebugCapture(target, log);
    const event = new Event('unhandledrejection');
    Object.defineProperty(event, 'reason', { get: () => { throw new Error('Private location'); } });
    expect(() => target.dispatchEvent(event)).not.toThrow();
    expect(log.text()).toContain('unhandled-rejection: Message omitted for privacy');
    stop();
  });

  it('survives hostile getters, circular rejections and recursive capture without invoking user serializers', () => {
    const log = createSessionDebugLog();
    const hostile = new Error();
    Object.defineProperty(hostile, 'message', { get: () => { log.record('uncaught-error', hostile); throw new Error(); } });
    expect(() => log.record('uncaught-error', hostile)).not.toThrow();
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    cyclic.toString = () => { throw new Error('must not run'); };
    expect(() => log.record('unhandled-rejection', cyclic)).not.toThrow();
    expect(log.text()).toContain('Message omitted for privacy');
    expect(log.text().match(/uncaught-error/g)).toHaveLength(1);
  });
  it('summarizes importer refusals while dropping the source line', () => {
    const log = createSessionDebugLog();
    log.record('import-failed', new Error('Not a RASP header line: "Private weather 61.234"'));
    expect(log.text()).toContain('Not a RASP header line (file detail omitted)');
    expect(log.text()).not.toContain('Private');
    expect(log.text()).not.toContain('61.234');
  });
});
