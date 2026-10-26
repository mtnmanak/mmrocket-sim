import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Resolve a checkout's shared exclude, including linked worktrees. */
export function gitInfoExclude(root) {
  let gitDir = join(root, '.git');
  if (!existsSync(gitDir)) return null;
  if (statSync(gitDir).isFile()) {
    const target = /^gitdir: (.+)\s*$/m.exec(readFileSync(gitDir, 'utf8'))?.[1]?.trim();
    if (!target) return null;
    gitDir = resolve(root, target);
  }
  const common = join(gitDir, 'commondir');
  if (existsSync(common)) gitDir = resolve(gitDir, readFileSync(common, 'utf8').trim());
  const exclude = join(gitDir, 'info', 'exclude');
  return existsSync(exclude) ? exclude : null;
}
