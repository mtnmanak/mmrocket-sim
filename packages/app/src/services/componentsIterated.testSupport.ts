/**
 * How many components `run` reads out of arrays of components through the array
 * iterator: the one every spread (`[...kids, node]`) and every for-of over a
 * component list goes through. A count, not a timing, so a test can hold an
 * importer to work linear in the parts it builds without a stopwatch (audit
 * 2026-09-30, Step 8 item 24): appending by spread copied every earlier sibling
 * at each append, N²/2 reads for N parts under one parent.
 *
 * It patches `Array.prototype[Symbol.iterator]` for the length of `run` and puts
 * the original back however `run` ends. V8 then gives up its fast path for array
 * iteration in this process, and each vitest test file runs in its own process
 * here (the default forks pool; probed), so the cost stays with the file that
 * counts. An array counts when its first element looks like a component — an
 * object with `type` and `id` — which a DOM node or a string never is.
 */
export function componentsIterated(run: () => void): number {
  const proto = Array.prototype as { [Symbol.iterator]: (this: unknown[]) => IterableIterator<unknown> };
  const values = proto[Symbol.iterator];
  let read = 0;
  proto[Symbol.iterator] = function (this: unknown[]) {
    const first = this[0];
    if (typeof first === 'object' && first !== null && 'type' in first && 'id' in first) read += this.length;
    return values.call(this);
  };
  try {
    run();
  } finally {
    proto[Symbol.iterator] = values;
  }
  return read;
}
