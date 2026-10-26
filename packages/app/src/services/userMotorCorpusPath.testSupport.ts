export function userMotorCorpusPath(repositoryRoot: string, present: (path: string) => boolean, join: (...parts: string[]) => string): string | null {
  return [join(repositoryRoot, 'docs', 'User files'),
    join(repositoryRoot, '..', '..', 'online_open_rocket', 'docs', 'User files')].find(present) ?? null;
}
