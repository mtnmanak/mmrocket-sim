// Hand-run sweep only. Resolve the baseline directly from an immutable Git tree;
// it never borrows an edited importer or matcher from the working tree.
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
const root = process.cwd().replaceAll('\\', '/');
const prefix = `${root}/.matcher-sweep/baseline/`;
const revision = process.env.MATCHER_BASELINE;
const cache = process.env.MATCHER_CACHE;
if (cache) mkdirSync(cache, { recursive: true });
const files = new Set(revision ? execFileSync('git', ['ls-tree', '-r', '--name-only', revision], { encoding: 'utf8' }).trim().split('\n') : []);
function present(path) { return path.startsWith(prefix) ? files.has(path.slice(prefix.length)) : existsSync(path); }
export async function resolve(specifier, context, next) {
  if ((specifier.startsWith('.') || specifier.startsWith('file:')) && context.parentURL?.startsWith('file:')) {
    const url = new URL(specifier, context.parentURL);
    const path = fileURLToPath(url).replaceAll('\\', '/');
    const choices = /\.js$/.test(path) ? [path.replace(/\.js$/, '.ts'), path.replace(/\.js$/, '.tsx'), path] : [path];
    const found = choices.find(present);
    if (found) return { url: pathToFileURL(found).href, shortCircuit: true };
  }
  return next(specifier, context);
}
export async function load(url, context, next) {
  if (url.startsWith('file:')) {
    const path = fileURLToPath(url).replaceAll('\\', '/');
    if (/\.(tsx?|json)$/.test(path) || (path.startsWith(prefix) && /\.m?js$/.test(path))) {
      const frozen = path.startsWith(prefix);
      const currentSource = frozen ? '' : readFileSync(path, 'utf8');
      const key = createHash('sha256').update(path + (frozen ? revision : currentSource)).digest('hex');
      const cached = cache && `${cache}/${key}.txt`;
      if (cached && existsSync(cached)) return { format: 'module', shortCircuit: true, source: readFileSync(cached, 'utf8') };
      const source = path.startsWith(prefix)
        ? execFileSync('git', ['show', `${revision}:${path.slice(prefix.length)}`], { maxBuffer: 40 * 1024 * 1024, encoding: 'utf8' })
        : currentSource;
      const compiled = path.endsWith('.json') ? `export default ${source}`
        : ts.transpileModule(source, { fileName: path, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
      if (cached) writeFileSync(cached, compiled);
      return { format: 'module', shortCircuit: true, source: compiled };
    }
    if (/\.(css|png|svg|woff2?)$/.test(path)) return { format: 'module', source: 'export default ""', shortCircuit: true };
  }
  return next(url, context);
}
