/** AbortSignal.throwIfAborted is newer than our browser floor; preserve its reason semantics. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}
