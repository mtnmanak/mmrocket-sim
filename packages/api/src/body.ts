/** The whole-file cap on a request body. */
export const MAX_API_BODY_BYTES = 8 * 1024 * 1024;
/**
 * Reader buffer capacity across this isolate. Growth resizes in place,
 * so three full bodies fit. The isolate's 128 MB
 * also holds the kernel, the bundle, incoming chunks and each parse.
 */
export const MAX_IN_FLIGHT_BODY_BYTES = 3 * MAX_API_BODY_BYTES;
export const MAX_KEY_BODY_BYTES = MAX_IN_FLIGHT_BODY_BYTES / 2;
/** The first allocation for a body: small, so a short upload holds little. */
const FIRST_STEP_BYTES = 64 * 1024;
// The installed workerd supports ES2024 buffers; the app typechecks against ES2022.
interface ResizableBuffer extends ArrayBuffer { resize(byteLength: number): void }
const ResizableArrayBuffer = ArrayBuffer as unknown as new (byteLength: number, options: { maxByteLength: number }) => ResizableBuffer;

export class BodyTooLarge extends Error {
  readonly received: number;
  readonly declared: boolean;
  constructor(received: number, declared = false) {
    super('Design body exceeds the whole-file cap.');
    this.name = 'BodyTooLarge';
    this.received = received;
    this.declared = declared;
  }
}

export class BodyTimeout extends Error {
  constructor() { super('The upload did not finish within 30 seconds.'); this.name = 'BodyTimeout'; }
}

/** The isolate's body budget is spent: retry after other uploads finish. */
export class ServerBusy extends Error {
  constructor() { super('Body bytes in flight exceed the upload budget.'); this.name = 'ServerBusy'; }
}

let reserved = 0;
const reservedByKey = new Map<string, number>();
/** Body bytes reserved across this isolate's requests now (tests). */
export const reservedBodyBytes = () => reserved;

/**
 * One request's share of the isolate's body budget. It reserves what its
 * buffers hold as the buffer grows, and gives everything back once: the Worker
 * releases it in a `finally` around the whole request, so success, refusals,
 * a client abort, a parse failure and a 500 all return it.
 */
export class BodyReservation {
  #held = 0;
  #key?: string;
  #preparedBytes = 0;
  /** Claim the first capacity before awaiting the work limiter. */
  prepare(): void { this.reserve(FIRST_STEP_BYTES); this.#preparedBytes = FIRST_STEP_BYTES; }
  takePreparedBytes(): number {
    const bytes = this.#preparedBytes;
    this.#preparedBytes = 0;
    return bytes;
  }
  setKey(key: string): void {
    if (this.#held) throw new Error('Cannot change the owner of held body bytes.');
    this.#key = key;
  }
  /** Hold `bytes` more, or throw ServerBusy and hold nothing more. */
  reserve(bytes: number): void {
    const keyBytes = this.#key === undefined ? 0 : reservedByKey.get(this.#key) ?? 0;
    if (reserved + bytes > MAX_IN_FLIGHT_BODY_BYTES || (this.#key !== undefined && keyBytes + bytes > MAX_KEY_BODY_BYTES)) throw new ServerBusy();
    if (this.#key !== undefined) reservedByKey.set(this.#key, keyBytes + bytes);
    reserved += bytes;
    this.#held += bytes;
  }
  /** Give back `bytes` this request no longer holds. */
  return(bytes: number): void {
    reserved -= bytes;
    this.#held -= bytes;
    if (this.#key !== undefined) {
      const remaining = reservedByKey.get(this.#key)! - bytes;
      if (remaining) reservedByKey.set(this.#key, remaining);
      else reservedByKey.delete(this.#key);
    }
  }
  release(): void {
    this.return(this.#held);
    this.#preparedBytes = 0;
  }
}

export function declaredBodySize(request: Request): number | undefined {
  const length = request.headers.get('content-length');
  return length !== null && /^\d+$/.test(length) ? Number(length) : undefined;
}
/**
 * Resizable buffers grow in place, in 64 KiB steps, to the bytes received. Only added capacity is
 * reserved before growth (at most 8 MiB per body). No chunks are
 * retained. A short buffer is shrunk in place to exact length;
 * a full buffer is passed directly. Neither handoff needs an importer view copy.
 * Content-Length is only an early refusal hint, never an allocation size.
 */
export async function readBody(request: Request, reservation: BodyReservation, deadlineAt = performance.now() + 30_000, key?: string): Promise<ArrayBuffer> {
  if (key !== undefined) reservation.setKey(key);
  return readBodyBytes(request, reservation, deadlineAt);
}

async function readBodyBytes(request: Request, reservation: BodyReservation, deadlineAt: number): Promise<ArrayBuffer> {
  const declared = declaredBodySize(request);
  if (declared !== undefined && declared > MAX_API_BODY_BYTES) throw new BodyTooLarge(declared, true);
  if (!request.body) return new ArrayBuffer(0);
  const buffer = new ResizableArrayBuffer(0, { maxByteLength: MAX_API_BODY_BYTES });
  let preparedBytes = reservation.takePreparedBytes();
  const reader = request.body.getReader();
  let size = 0;
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
    void reader.cancel().catch(() => undefined);
  };
  const checkDeadline = () => {
    if (performance.now() >= deadlineAt) {
      cancel();
      throw new BodyTimeout();
    }
  };
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new BodyTimeout());
      // A stream's cancel hook may never settle; refusal must not wait on it.
      cancel();
    }, Math.max(0, deadlineAt - performance.now()));
  });
  const drain = async () => {
    for (;;) {
      checkDeadline();
      const { done, value } = await reader.read();
      checkDeadline();
      if (done) break;
      if (size + value.byteLength > MAX_API_BODY_BYTES) {
        cancel();
        throw new BodyTooLarge(size + value.byteLength);
      }
      if (size + value.byteLength > buffer.byteLength) {
        // Grow to what is needed, in 64 KiB steps. resize() is in place, so doubling would save no copy and would only
        // hold unused capacity against the per-key cap (two 6 MiB uploads from one key would not fit 12 MiB).
        const grown = Math.min(MAX_API_BODY_BYTES,
          Math.ceil((size + value.byteLength) / FIRST_STEP_BYTES) * FIRST_STEP_BYTES);
        try {
          const added = grown - buffer.byteLength;
          if (added > preparedBytes) reservation.reserve(added - preparedBytes);
          preparedBytes = 0;
        } catch (e) {
          cancel();
          throw e;
        }
        buffer.resize(grown);
      }
      new Uint8Array(buffer, size, value.byteLength).set(value);
      size += value.byteLength;
    }
  };
  try {
    await Promise.race([drain(), timeout]);
  } finally {
    clearTimeout(timer!);
    // Internal workerd streams cannot unlock an outstanding cancelled read.
    if (!cancelled) reader.releaseLock();
  }
  if (preparedBytes) reservation.return(preparedBytes);
  if (size === buffer.byteLength) return buffer;
  const capacity = buffer.byteLength;
  buffer.resize(size);
  reservation.return(capacity - size);
  return buffer;
}
