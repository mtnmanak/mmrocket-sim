import { noticeNumber } from '../../app/src/prefs/units.js';
import { boosterBranches } from '@online-openrocket/engine';
import {
  kernelPoisoned, KernelUnavailableError, InflatedFileTooLargeError,
  commentsOf, formatWarning, createJsXmlParser, XmlBudgetExceededError, mountMotorCount, mountNamesOf, motorMounts, resolveFlightState, setXmlParser,
  simulateFile, SimulateDesignError, type TimedSimulateFileResult, describeFile, type DescribeFileResult, SHARE_TOO_LARGE_ERROR_NAME,
} from '../../app/src/headless/index.js';
import { displayEcho, filenameEcho } from './filenameEcho.js';
import { noteEcho, noteStrings, warningEcho, warningName } from './fileStrings.js';
import { stampedJson } from './stamp.js';
import { declaredBodySize, MAX_API_BODY_BYTES, BodyReservation, BodyTimeout, BodyTooLarge, readBody, ServerBusy } from './body.js';
import { checkKey, type Env } from './auth.js';
import { kernelBusy, kernelJob, KernelBusy } from './admission.js';
import { API_XML_LIMITS } from './xmlLimits.js';

export { API_XML_LIMITS };
setXmlParser(createJsXmlParser(API_XML_LIMITS));

const MAX_API_INFLATED_BYTES = 16 * 1024 * 1024;
const MIN_API_TIME_STEP_S = 0.05;
const APP_URL = 'https://mmrsim.mountainmanrockets.com';
let kernelUnavailableLogged = false;

function error(code: string, message: string, status: number, headers?: HeadersInit): Response {
  return stampedJson({ error: { code, message } }, { status, headers });
}

function bodySizeError(received: number, declared: boolean, filename: string): Response {
  return error('FILE_TOO_LARGE', `${filenameEcho(filename)}: the API body limit is 8 MiB; ${declared ? 'declared' : 'received'} ${received.toLocaleString('en-US')} bytes. Use ${APP_URL} for larger files.`, 413);
}

function uploadBusyError(): Response {
  return error('SERVER_BUSY', 'The API is busy with other uploads. Retry in a few seconds.', 503, { 'Retry-After': '5' });
}

function kernelUnavailableError(): Response {
  if (!kernelUnavailableLogged) {
    kernelUnavailableLogged = true;
    console.error('API kernel unavailable: isolate replacement required.');
  }
  return error('KERNEL_UNAVAILABLE', 'A previous flight on this server instance was stopped part-way. Please retry later; this instance cannot recover until it is replaced.', 503);
}

async function rateLimit(limiter: NonNullable<Env['RATE_LIMITER']>, key: string): Promise<Response | undefined> {
  try {
    if (!(await limiter.limit({ key })).success) {
      return error('RATE_LIMITED', 'This API key has made too many requests. Retry in a minute.', 429, { 'Retry-After': '60' });
    }
  } catch {
    return error('INTERNAL_ERROR', 'The API request limit could not be checked. Retry in a few seconds.', 503, { 'Retry-After': '5' });
  }
  return undefined;
}

export interface WorkerContext { waitUntil(promise: Promise<unknown>): void }
const TIMING_BASIS = 'wall-clock; not CPU time; includes waiting behind other in-isolate flights; under deployed Workers the clock only advances at I/O, so treat these as local-only';

/** Only mounts installed by the flight runner appear in its delay-resolution vector. */
function summary(out: TimedSimulateFileResult) {
  // simulateDesign returns editor state; use the same projection as its flight.
  const state = resolveFlightState(out.state.tree, out.state.savedConfigs, out.state.activeConfigId,
    out.state.detachedOverrides ?? {}, out.state.mountMotors);
  const mountNames = mountNamesOf(motorMounts(state.tree));
  const floor = out.timeStepFloor;
  const { maxAltitude, maxVelocity, maxMachNumber, flightTime } = out.result.summary;
  const aborts = [
    { name: out.state.tree.name ?? 'Rocket', events: out.result.events },
    ...boosterBranches(out.result),
  ].flatMap(branch => branch.events.filter(event => event.type === 'SIM_ABORT' || event.type === 'EXCEPTION')
    // The kernel's node ids come from a module counter (see motorFailures): never returned.
    .map(({ sourceId: _sourceId, motorMountId: _motorMountId, ...event }) => ({ branch: warningName(branch.name), reason: event.cause ?? event.type,
      event: { ...event, ...(event.source !== undefined ? { source: warningName(event.source) } : {}) } })));
  const incomplete = out.run.simWarnings?.some(warning => warning.key === 'INCOMPLETE_FLIGHT') ?? false;
  return {
    experimental: true,
    outcome: aborts.length ? 'aborted' : incomplete ? 'incomplete' : 'completed',
    partial: aborts.length > 0 || incomplete,
    aborts,
    // No node id: ids come from a module counter, so they would differ per isolate history.
    motorFailures: out.build.motorFailures.map(({ mountId, text }) => ({ mount: mountNames[mountId] === undefined ? undefined : warningName(mountNames[mountId]), text: noteEcho(text) })),
    appVersion: out.appVersion,
    apogeeM: maxAltitude,
    maxVelocityMs: maxVelocity,
    maxMach: maxMachNumber,
    flightTimeS: flightTime,
    motors: out.flight.delayResolution.mounts.flatMap((mount) => {
      const motor = state.mountMotors[mount.mountId];
      // A flown mount with no motor entry (no known input) is left out, not a 500 after the flight.
      if (!motor || motor.ignition?.event === 'never') return [];
      return [{
        mount: warningName(mount.mountName), designation: displayEcho(motor.spec.designation),
        manufacturer: displayEcho(motor.meta.manufacturer ?? ''),
        count: mountMotorCount(state.tree, mount.mountId), delayS: mount.flownDelay,
      }];
    }),
    warnings: (out.run.simWarnings ?? []).map(warning => {
      // Match original snapshots before either carrier is bounded or sanitized.
      // Both carriers then use the same name, including its retained tail.
      let message = warning.message;
      for (const source of warning.sources ?? []) {
        if (source?.name) message = message.replaceAll(`"${source.name}"`, () => `"${warningName(source.name)}"`);
      }
      const safe = { ...warning, message: warningEcho(message),
        ...(warning.sources ? { sources: warning.sources.map(source => source ? { ...source, name: warningName(source.name) } : null) } : {}) };
      const text = formatWarning(safe);
      return { ...safe, message: warningEcho(`${text.label}${text.detail ? ` — ${text.detail}` : ''}`) };
    }),
    notes: noteStrings({ api: floor
      ? [noticeNumber(floor.appStepS, 6) === noticeNumber(floor.flownStepS, 6)
        ? `This API flies at a time step of at least ${noticeNumber(floor.flownStepS, 6)} s; the app uses a slightly finer step for this design.`
        : `This API flies at a time step of at least ${noticeNumber(floor.flownStepS, 6)} s; in the app this design flies at ${noticeNumber(floor.appStepS, 6)} s.`] : [],
      import: out.importNote, padMass: out.padMassNote, flight: commentsOf(out.run).map(entry => ({ ...entry, text: warningEcho(entry.text) })) }),
  };
}

/** The /describe v1 contract (S5): the service's result, with the fragment's full app link; stampedJson adds the stamp. */
function described(out: DescribeFileResult) {
  const notes = noteStrings(out.notes);
  const { group: _group, ...importNote } = notes.import;
  return {
    api: '1',
    name: displayEcho(out.name),
    sourceFormat: out.sourceFormat,
    analysis: out.analysis,
    launchMount: out.launchMount,
    mounts: out.mounts.map(mount => ({ ...mount, name: warningName(mount.name), stageName: warningName(mount.stageName) })),
    fragment: out.fragment,
    link: `${APP_URL}/${out.fragment}`,
    notes: { ...notes, import: importNote },
  };
}

export const worker = {
  async fetch(request: Request, env: Env | undefined, ctx: WorkerContext): Promise<Response> {
    const started = performance.now();
    let filename = '';
    let describing = false;
    // Held until the response is built: every exit below gives the body bytes back.
    const reservation = new BodyReservation();
    try {
      const url = new URL(request.url);
      if (url.pathname === '/health') {
        if (request.method !== 'GET') return error('METHOD_NOT_ALLOWED', 'Use GET for /health.', 405, { Allow: 'GET' });
        return stampedJson({ ok: true, api: 's1' });
      }
      if (url.pathname !== '/describe' && url.pathname !== '/experimental/fly') return error('NOT_FOUND', 'Unknown endpoint.', 404);
      if (request.method !== 'POST') return error('METHOD_NOT_ALLOWED', 'Use POST with a raw design file.', 405, { Allow: 'POST' });
      describing = url.pathname === '/describe';
      const key = await checkKey(request, env?.API_KEYS);
      if ('code' in key) {
        if (key.code === 'NOT_CONFIGURED') return error(key.code, 'The API is not configured yet.', 503);
        const message = key.code === 'API_KEY_REQUIRED' ? 'This API needs a key.' : 'This API key is not recognised.';
        return error(key.code, message + ' To fly a design yourself, use ' + APP_URL + '.', 401,
          { 'WWW-Authenticate': 'Bearer realm="mmrsim-api"' });
      }
      if (!env?.RATE_LIMITER) return error('NOT_CONFIGURED', 'The API is not configured yet.', 503);
      filename = url.searchParams.get('filename')?.trim() ?? '';
      // Cheap refusals have their own bounded allowance, never an unlimited bypass.
      const declared = declaredBodySize(request);
      const refusal = !filename ? error('FILENAME_REQUIRED', 'Supply the design filename in ?filename=.', 400)
        : !request.body || declared === 0 ? error('EMPTY_FILE', 'Supply a raw design file as the request body.', 400)
          : declared !== undefined && declared > MAX_API_BODY_BYTES ? bodySizeError(declared, true, filename)
            : kernelPoisoned() ? kernelUnavailableError()
              : kernelBusy() ? error('KERNEL_BUSY', 'The API is busy with other designs. Retry in a few seconds.', 503, { 'Retry-After': '5' }) : undefined;
      if (refusal) return (await rateLimit(env.RATE_LIMITER, 'refused:' + key.name)) ?? refusal;
      // Reserve the first 64 KiB atomically before awaiting the work limiter.
      try { reservation.setKey(key.name); reservation.prepare(); }
      catch (e) {
        if (!(e instanceof ServerBusy)) throw e;
        return (await rateLimit(env.RATE_LIMITER, 'refused:' + key.name)) ?? uploadBusyError();
      }
      const limited = await rateLimit(env.RATE_LIMITER, key.name);
      if (limited) return limited;
      const readingStarted = performance.now();
      const data = await readBody(request, reservation, started + 30_000);
      if (!data.byteLength) return error('EMPTY_FILE', 'Supply a raw design file as the request body.', 400);
      const readMs = performance.now() - readingStarted;
      if (describing) {
        // No caller options: every other query parameter is ignored. The build and its
        // handle reads take the kernel lock inside describeFile; the import before it and
        // the fragment compression after it run outside, so the watchdog's microtask-only
        // assumption holds. No flight, auto-delay solve or Mach probe.
        const description = kernelJob(() => describeFile(data, filename, {
          kernelDeadHolderMs: 10_000, maxInflatedBytes: MAX_API_INFLATED_BYTES, designName: displayEcho,
          includeImportNoteGroup: true,
        }));
        ctx.waitUntil(description.catch(() => undefined));
        return stampedJson(described(await description));
      }
      // No caller-supplied options; the bundled snapshot is the only external motor source.
      // simulateFile takes withKernel internally. An outer lock here would deadlock.
      // A microtask-only flight has no macrotask cancellation point inside withKernel.
      // Shipped Wrangler bundles, old unminified kernel/full -> minified ASCII
      // patched kernel/summary: smallest workerd V8 old-space caps in 2 MiB steps,
      // worst across measured designs 88 -> 60 MiB, flight-bound worst 88 -> 44,
      // Worker start floor 38 -> 22; typed-array storage is outside these caps.
      // 129/129 API responses identical (excluding timing). notes.flight still returns
      // low rod-exit thrust:weight using the same WGS84 model at pad latitude and
      // interpolated height rather than reading the kernel's per-step g (which also
      // follows the rocket's drifting latitude); the difference is at rounding level.
      // The API returns neither load peaks (maxQ/max q-alpha) nor an airspeed check.
      const flight = kernelJob(() => simulateFile(data, filename, {
        network: 'forbid', reportSeries: 'summary', yieldToUi: () => Promise.resolve(),
        kernelDeadHolderMs: 10_000, minTimeStepS: MIN_API_TIME_STEP_S, maxInflatedBytes: MAX_API_INFLATED_BYTES,
        // The design's name, as every response shows it: bounded and made safe like the filename echo.
        designName: displayEcho,
      }));
      // Defence in depth: keep the real flight and its cleanup alive after disconnect.
      ctx.waitUntil(flight.catch(() => undefined));
      const out = await flight;
      return stampedJson({ ...summary(out), timing: {
        basis: TIMING_BASIS,
        parseMs: readMs + out.timing.parseMs,
        flyMs: out.timing.flyMs,
        totalMs: performance.now() - started,
      } });
    } catch (e) {
      // Display only: content selects the importer, with the full trimmed filename as fallback.
      if (e instanceof BodyTimeout) return error('BODY_TIMEOUT', e.message, 408);
      if (e instanceof BodyTooLarge) {
        return bodySizeError(e.received, e.declared, filename);
      }
      const shown = filenameEcho(filename);
      if (e instanceof InflatedFileTooLargeError) {
        return error('FILE_TOO_LARGE', `${shown}: the API inflated XML limit is 16 MiB. Use ${APP_URL} for larger files.`, 413);
      }
      if (e instanceof XmlBudgetExceededError) {
        return error('FILE_TOO_LARGE', `${shown}: ${e.message} Use ${APP_URL} for larger files.`, 413);
      }
      if (e instanceof Error && e.name === SHARE_TOO_LARGE_ERROR_NAME) {
        return error('LINK_TOO_LARGE', `${shown}: this design is too large for a share link (the app's limit is 4 MiB of design XML and 1,048,576 link characters). Use ${APP_URL}/ with the file itself.`, 413);
      }
      if (e instanceof KernelBusy) {
        return error('KERNEL_BUSY', 'The API is busy with other designs. Retry in a few seconds.', 503, { 'Retry-After': '5' });
      }
      if (e instanceof ServerBusy) {
        return uploadBusyError();
      }
      if (e instanceof KernelUnavailableError) {
        return kernelUnavailableError();
      }
      if (e instanceof SimulateDesignError) {
        const codes = { file: 'FILE_TOO_LARGE', parse: 'INVALID_FILE', build: 'DESIGN_BUILD_FAILED',
          'no-motor': 'NO_MOTOR', flight: 'FLIGHT_FAILED' } as const;
        return stampedJson({ error: { code: codes[e.kind], message: e.kind === 'build' ? warningEcho(e.message) : noteEcho(e.message),
          ...(e.importNote ? { importNote: noteStrings(e.importNote) } : {}) } },
        { status: e.kind === 'file' ? 413 : e.kind === 'parse' ? 400 : 422 });
      }
      return error('INTERNAL_ERROR', describing ? 'The design could not be described.' : 'The design could not be simulated.', 500);
    } finally {
      reservation.release();
    }
  },
};

// eslint-disable-next-line no-restricted-syntax -- Cloudflare's module Worker entry requires a default export.
export default worker;
