/** The whole-file cap on a request body. */
export const MAX_API_BODY_BYTES = 8 * 1024 * 1024;
/**
 * Body bytes every request in this isolate may hold at once: three bodies at
 * the cap. The isolate's 128 MB also holds the kernel, the bundle and each
 * parse, so a fourth full upload waits for one of these to finish.
 */
export const MAX_IN_FLIGHT_BODY_BYTES = 3 * MAX_API_BODY_BYTES;
/** The first allocation for a body: small, so a short upload holds little. */
const FIRST_STEP_BYTES = 64 * 1024;

export class BodyTooLarge extends Error {
  readonly received: number;
  constructor(received: number) { super('Design body exceeds the whole-file cap.'); this.received = received; }
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
 * buffer holds as the buffer grows, and gives everything back once: the Worker
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
 * The request body in ONE buffer, never more than the cap. Content-Length is
 * only an early refusal hint: the buffer grows from received bytes alone, in
 * place (a resizable ArrayBuffer, doubling up to the cap), so no chunk is kept
 * and no second copy of the body is assembled. The result is the same memory
 * as a fixed-length ArrayBuffer, which every consumer (TextDecoder, fflate)
 * accepts.
 */
export async function readBody(request: Request, reservation: BodyReservation): Promise<ArrayBuffer> {
  const length = request.headers.get('content-length');
  const declared = length !== null && /^\d+$/.test(length) ? Number(length) : undefined;
  if (declared !== undefined && declared > MAX_API_BODY_BYTES) throw new BodyTooLarge(declared);
  if (!request.body) return new ArrayBuffer(0);
  const buffer = new ArrayBuffer(0, { maxByteLength: MAX_API_BODY_BYTES });
  const reader = request.body.getReader();
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.byteLength > MAX_API_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new BodyTooLarge(size + value.byteLength);
      }
      if (size + value.byteLength > buffer.byteLength) {
        const grown = Math.min(MAX_API_BODY_BYTES, Math.max(size + value.byteLength, buffer.byteLength * 2, FIRST_STEP_BYTES));
        try {
          reservation.reserve(grown - buffer.byteLength);
        } catch (e) {
          await reader.cancel().catch(() => undefined);
          throw e;
        }
        buffer.resize(grown);
      }
      new Uint8Array(buffer, size, value.byteLength).set(value);
      size += value.byteLength;
    }
  } finally { reader.releaseLock(); }
  const capacity = buffer.byteLength;
  buffer.resize(size);
  reservation.return(capacity - size);
  return buffer.transferToFixedLength();
}
