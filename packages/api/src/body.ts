/** The whole-file cap on a request body. */
export const MAX_API_BODY_BYTES = 8 * 1024 * 1024;
/**
 * Reader buffer capacity across this isolate, including both buffers during
 * growth. Three full bodies fit when none is growing. The isolate's 128 MB
 * also holds the kernel, the bundle, incoming chunks and each parse.
 */
export const MAX_IN_FLIGHT_BODY_BYTES = 3 * MAX_API_BODY_BYTES;
/** The first allocation for a body: small, so a short upload holds little. */
const FIRST_STEP_BYTES = 64 * 1024;

export class BodyTooLarge extends Error {
  readonly received: number;
  constructor(received: number) { super('Design body exceeds the whole-file cap.'); this.received = received; }
}

export class BodyTimeout extends Error {
  constructor() { super('The upload did not finish within 30 seconds.'); }
}

/** The isolate's body budget is spent: retry after other uploads finish. */
export class ServerBusy extends Error {
  constructor() { super('Body bytes in flight exceed the isolate budget.'); }
}

let reserved = 0;
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
  /** Hold `bytes` more, or throw ServerBusy and hold nothing more. */
  reserve(bytes: number): void {
    if (reserved + bytes > MAX_IN_FLIGHT_BODY_BYTES) throw new ServerBusy();
    reserved += bytes;
    this.#held += bytes;
  }
  /** Give back `bytes` this request no longer holds. */
  return(bytes: number): void {
    reserved -= bytes;
    this.#held -= bytes;
  }
  release(): void {
    reserved -= this.#held;
    this.#held = 0;
  }
}

/**
 * Fixed buffers double up to the cap. Growth temporarily holds old + new
 * capacity (at most 12 MiB), both reserved before allocation. No chunks are
 * retained. A bounded view trims the logical length without a hand-off copy;
 * a full buffer is passed directly, avoiding the importer's view-input copy.
 * Content-Length is only an early refusal hint, never an allocation size.
 */
export async function readBody(request: Request, reservation: BodyReservation, deadlineAt = performance.now() + 30_000): Promise<ArrayBuffer | Uint8Array> {
  const length = request.headers.get('content-length');
  const declared = length !== null && /^\d+$/.test(length) ? Number(length) : undefined;
  if (declared !== undefined && declared > MAX_API_BODY_BYTES) throw new BodyTooLarge(declared);
  if (!request.body) return new ArrayBuffer(0);
  let buffer = new ArrayBuffer(0);
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
        let grown = Math.max(buffer.byteLength, FIRST_STEP_BYTES);
        while (grown < size + value.byteLength) grown = Math.min(MAX_API_BODY_BYTES, grown * 2);
        try {
          reservation.reserve(grown);
        } catch (e) {
          cancel();
          throw e;
        }
        const next = new ArrayBuffer(grown);
        new Uint8Array(next).set(new Uint8Array(buffer, 0, size));
        reservation.return(buffer.byteLength);
        buffer = next;
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
  return size === buffer.byteLength ? buffer : new Uint8Array(buffer, 0, size);
}
