/** Browser download failures, including old chunks removed by an update. */
export function isChunkLoadError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === 'ChunkLoadError'
    || /dynamically imported module|Importing a module script failed|is not a valid JavaScript MIME type|Unable to preload CSS/i.test(err.message);
}

/** Works with or without a waiting service-worker update. */
export const CHUNK_LOAD_GUIDANCE = 'The connection may have dropped, or the app may have been updated since this page loaded. Save this tab’s design as an .ork file. Once your connection is working, reload the page.';
