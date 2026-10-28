/**
 * Type surface of import-memory.mjs for src/importMemory.test.ts: the
 * bisection, run with a stub, and the run classifier. tsconfig has no allowJs,
 * so the .mjs needs this beside it. Importing the script has no side effects;
 * its CLI runs only as the entry point.
 */
export interface MemoryRun { ok: boolean; kind: 'ok' | 'oom' | 'refused' | 'failed'; status?: number | string; error?: string }
export const MAX_OLD_SPACE_MIB: number;
export function classifyRun(
  child: { stderr?: string; status: number | null; signal: string | null; error?: { code?: string } },
  line: string | undefined,
): MemoryRun;
export function smallestOldSpace(
  run: (probe: string, mode: string, file: string, oldSpaceMiB?: number) => MemoryRun,
  probe: string, mode: string, file: string, reps: number,
): Promise<{ mib: number; failedAt: number | null } | { mib: null; stopped: string }>;
