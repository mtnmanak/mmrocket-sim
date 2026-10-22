import { boosterBranches } from '@online-openrocket/engine';
import {
  APP_VERSION, CURVES_GENERATED, MOTORS_GENERATED, MAX_DESIGN_FILE_BYTES,
  commentsOf, formatWarning, jsXmlParser, mountMotorCount, mountNamesOf, motorMounts, resolveFlightState, setXmlParser,
  simulateFile, SimulateDesignError, type TimedSimulateFileResult,
} from '../../app/src/headless/index.js';

setXmlParser(jsXmlParser);

function error(code: string, message: string, status: number, headers?: HeadersInit): Response {
  return Response.json({ error: { code, message } }, { status, headers });
}

class BodyTooLarge extends Error {
  readonly received: number;
  constructor(received: number) { super('Design body exceeds the whole-file cap.'); this.received = received; }
}

/** Content-Length is only an early refusal hint; allocate from received bytes alone. */
async function readDesign(request: Request): Promise<ArrayBuffer> {
  const length = request.headers.get('content-length');
  const declared = length !== null && /^\d+$/.test(length) ? Number(length) : undefined;
  if (declared !== undefined && declared > MAX_DESIGN_FILE_BYTES) throw new BodyTooLarge(declared);
  if (!request.body) return new ArrayBuffer(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_DESIGN_FILE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new BodyTooLarge(size);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  chunks.length = 0; // Release incoming chunks before parsing; pass the owned buffer without a slice.
  return result.buffer;
}

export interface WorkerContext { waitUntil(promise: Promise<unknown>): void }
const TIMING_BASIS = 'wall-clock; not CPU time; includes waiting behind other in-isolate flights; under deployed Workers the clock only advances at I/O, so treat these as local-only';

/** Only mounts installed by the flight runner appear in its delay-resolution vector. */
function summary(out: TimedSimulateFileResult) {
  // simulateDesign returns editor state; use the same projection as its flight.
  const state = resolveFlightState(out.state.tree, out.state.savedConfigs, out.state.activeConfigId,
    out.state.detachedOverrides ?? {}, out.state.mountMotors);
  const mountNames = mountNamesOf(motorMounts(state.tree));
  const { maxAltitude, maxVelocity, maxMachNumber, flightTime } = out.result.summary;
  const aborts = [
    { name: out.state.tree.name ?? 'Rocket', events: out.result.events },
    ...boosterBranches(out.result),
  ].flatMap(branch => branch.events.filter(event => event.type === 'SIM_ABORT' || event.type === 'EXCEPTION')
    .map(event => ({ branch: branch.name, reason: event.cause ?? event.type, event })));
  return {
    experimental: true,
    outcome: aborts.length ? 'aborted' : 'completed',
    partial: aborts.length > 0,
    aborts,
    motorFailures: out.build.motorFailures.map(failure => ({ ...failure, mount: mountNames[failure.mountId] })),
    appVersion: out.appVersion,
    apogeeM: maxAltitude,
    maxVelocityMs: maxVelocity,
    maxMach: maxMachNumber,
    flightTimeS: flightTime,
    motors: out.flight.delayResolution.mounts.filter(mount =>
      state.mountMotors[mount.mountId]?.ignition?.event !== 'never').map((mount) => {
      const motor = state.mountMotors[mount.mountId]!;
      return {
        mount: mount.mountName, designation: motor.spec.designation,
        manufacturer: motor.meta.manufacturer ?? '',
        count: mountMotorCount(state.tree, mount.mountId), delayS: mount.flownDelay,
      };
    }),
    warnings: (out.run.simWarnings ?? []).map(warning => {
      const text = formatWarning(warning);
      return { ...warning, message: `${text.label}${text.detail ? ` — ${text.detail}` : ''}` };
    }),
    notes: { import: out.importNote, padMass: out.padMassNote, flight: commentsOf(out.run) },
  };
}

export const worker = {
  async fetch(request: Request, _env: unknown, ctx: WorkerContext): Promise<Response> {
    const started = performance.now();
    let filename = '';
    try {
      const url = new URL(request.url);
      if (url.pathname === '/health') {
        if (request.method !== 'GET') return error('METHOD_NOT_ALLOWED', 'Use GET for /health.', 405, { Allow: 'GET' });
        return Response.json({ ok: true, api: 's1', appVersion: APP_VERSION, engine: { openRocket: '24.12', appVersion: APP_VERSION },
          catalogue: { motorsGenerated: MOTORS_GENERATED, curvesGenerated: CURVES_GENERATED } });
      }
      if (url.pathname !== '/experimental/fly') return error('NOT_FOUND', 'Unknown endpoint.', 404);
      if (request.method !== 'POST') return error('METHOD_NOT_ALLOWED', 'Use POST with a raw design file.', 405, { Allow: 'POST' });
      filename = url.searchParams.get('filename')?.trim() ?? '';
      if (!filename) return error('FILENAME_REQUIRED', 'Supply the design filename in ?filename=.', 400);
      const data = await readDesign(request);
      if (!data.byteLength) return error('EMPTY_FILE', 'Supply a raw design file as the request body.', 400);
      const readMs = performance.now() - started;
      // No caller-supplied options; the bundled snapshot is the only external motor source.
      // simulateFile takes withKernel internally. An outer lock here would deadlock.
      // A microtask-only flight has no macrotask cancellation point inside withKernel.
      // The event loop serializes requests; S2 must measure contention/admission externally.
      const flight = simulateFile(data, filename, { network: 'forbid', yieldToUi: () => Promise.resolve() });
      // Defence in depth: keep the real flight and its cleanup alive after disconnect.
      ctx.waitUntil(flight.catch(() => undefined));
      const out = await flight;
      return Response.json({ ...summary(out), timing: {
        basis: TIMING_BASIS,
        parseMs: readMs + out.timing.parseMs,
        flyMs: out.timing.flyMs,
        totalMs: performance.now() - started,
      } });
    } catch (e) {
      if (e instanceof BodyTooLarge) {
        return error('FILE_TOO_LARGE', `${filename}: limit ${MAX_DESIGN_FILE_BYTES.toLocaleString('en-US')} bytes; received ${e.received.toLocaleString('en-US')} bytes.`, 413);
      }
      if (e instanceof SimulateDesignError) {
        const codes = { file: 'FILE_TOO_LARGE', parse: 'INVALID_FILE', build: 'DESIGN_BUILD_FAILED',
          'no-motor': 'NO_MOTOR', flight: 'FLIGHT_FAILED' } as const;
        return Response.json({ error: { code: codes[e.kind], message: e.message,
          ...(e.importNote ? { importNote: e.importNote } : {}) } },
        { status: e.kind === 'file' ? 413 : e.kind === 'parse' ? 400 : 422 });
      }
      return error('INTERNAL_ERROR', 'The design could not be simulated.', 500);
    }
  },
};

// eslint-disable-next-line no-restricted-syntax -- Cloudflare's module Worker entry requires a default export.
export default worker;
