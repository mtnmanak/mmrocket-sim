import { referenceDir } from '../../../../scripts/reference-docs.mjs';

export function userMotorCorpusPath(repositoryRoot: string, isDirectory?: (path: string) => boolean, _join?: (...parts: string[]) => string): string | null {
  return referenceDir('User files', { repoRoot: repositoryRoot, isDirectory });
}
