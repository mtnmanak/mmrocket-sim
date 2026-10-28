/**
 * Type surface of import-memory.mjs for src/importMemory.test.ts: only the
 * bisection, run with a stub. tsconfig has no allowJs, so the .mjs needs this
 * beside it. Importing the script has no side effects; its CLI runs only as
 * the entry point.
 */
export interface MemoryRun { ok: boolean; status?: number | string; error?: string }
export function smallestOldSpace(
  run: (probe: string, mode: string, file: string, oldSpaceMiB?: number) => MemoryRun,
  probe: string, mode: string, file: string, reps: number,
): Promise<{ mib: number; failedAt: number | null } | null>;
