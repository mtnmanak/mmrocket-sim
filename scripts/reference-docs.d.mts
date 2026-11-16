export interface ReferenceOptions {
  env?: NodeJS.ProcessEnv;
  repoRoot?: string;
  isDirectory?: (path: string) => boolean;
}
export const REFERENCE_FOLDERS: string[];
export function referenceRoots(options?: ReferenceOptions): string[];
export function referenceDir(name: string, options?: ReferenceOptions): string | null;
export function referenceFile(name: string, ...parts: string[]): string | null;
