import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Detect broken npm workspace links before tsc/eslint can hide their cause. */
export function workspaceLinkProblems(root) {
  const problems = [];
  for (const entry of readdirSync(join(root, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const target = join(root, 'packages', entry.name);
    if (!existsSync(join(target, 'package.json'))) continue;
    const { name } = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'));
    const link = join(root, 'node_modules', name);
    let stat;
    try { stat = lstatSync(link); } catch { problems.push(`${name}: missing link`); continue; }
    if (!stat.isSymbolicLink()) { problems.push(`${name}: not a link (a copied directory)`); continue; }
    try {
      if (realpathSync(link) !== realpathSync(target)) problems.push(`${name}: wrong target`);
    } catch { problems.push(`${name}: broken link`); }
  }
  return problems;
}

export function assertWorkspaceLinks(root = fileURLToPath(new URL('../', import.meta.url))) {
  const problems = workspaceLinkProblems(root);
  if (problems.length) {
    throw new Error(`Workspace installation is broken:\n${problems.join('\n')}\nRestore node_modules workspace links with npm install in this checkout before running checks. A copied workspace directory must be removed before reinstalling.`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { assertWorkspaceLinks(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
