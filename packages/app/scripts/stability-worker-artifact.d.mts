import type { ExecFileSyncOptions } from 'node:child_process';

export function stabilityWorkerBuild(outDir: string): { args: string[]; options: ExecFileSyncOptions };
export function buildStabilityWorkerArtifact(
  required?: boolean,
  build?: (command: string, args: string[], options: ExecFileSyncOptions) => unknown,
): { outDir: string; file: string; cleanup: () => void } | null;
