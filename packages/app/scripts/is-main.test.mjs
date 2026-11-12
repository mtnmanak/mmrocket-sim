import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import ts from 'typescript';
import { isMain } from '../../../scripts/is-main.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const originalArgv = process.argv;
const dirs = [];
function temp() {
  const dir = mkdtempSync(join(tmpdir(), 'is-main-'));
  dirs.push(dir);
  return dir;
}
function directoryLink(target, link) {
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}
afterEach(() => {
  process.argv = originalArgv;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it('recognizes the same file and rejects a different file', () => {
  process.argv = [process.execPath, fileURLToPath(import.meta.url)];
  expect(isMain(import.meta.url)).toBe(true);
  expect(isMain(new URL('../../../scripts/is-main.mjs', import.meta.url))).toBe(false);
});

it('rejects missing argv, nonexistent paths, and invalid module URLs', () => {
  process.argv = [process.execPath];
  expect(isMain(import.meta.url)).toBe(false);
  process.argv = [process.execPath, join(temp(), 'absent.mjs')];
  expect(isMain(import.meta.url)).toBe(false);
  process.argv[1] = fileURLToPath(import.meta.url);
  expect(isMain(pathToFileURL(join(temp(), 'absent.mjs')).href)).toBe(false);
  expect(isMain('https://example.com/module.mjs')).toBe(false);
});

it('recognizes argv through a directory junction and resolves both paths', () => {
  const root = temp();
  const real = join(root, 'real');
  const link = join(root, 'link');
  mkdirSync(real);
  writeFileSync(join(real, 'entry.mjs'), '');
  directoryLink(real, link);
  process.argv = [process.execPath, join(link, 'entry.mjs')];
  expect(isMain(pathToFileURL(join(real, 'entry.mjs')).href)).toBe(true);
  process.argv[1] = join(real, 'entry.mjs');
  expect(isMain(pathToFileURL(join(link, 'entry.mjs')).href)).toBe(true);
});

it('runs the workspace check through a directory junction and diagnoses broken input', () => {
  const root = temp();
  const real = join(root, 'real');
  const link = join(root, 'link');
  mkdirSync(join(real, 'packages', 'broken'), { recursive: true });
  writeFileSync(join(real, 'packages', 'broken', 'package.json'), JSON.stringify({ name: '@test/broken' }));
  cpSync(join(repo, 'scripts'), join(real, 'scripts'), { recursive: true });
  directoryLink(real, link);
  const result = spawnSync(process.execPath, [join(link, 'scripts', 'check-workspace-links.mjs')], {
    cwd: root, encoding: 'utf8', timeout: 10_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Workspace installation is broken:');
  expect(result.stderr).toContain('@test/broken: missing link');
});

// Keep argv[1]/module identity logic centralized, including aliases and multiline guards.
function hasLocalIdentityCheck(source) {
  // Most tracked files contain neither side; avoid parsing generated engine code.
  if (!/process\s*\.\s*argv\s*\[\s*1\s*\]/.test(source)
    || !/import\s*\.\s*meta\s*\.\s*url/.test(source)) return false;
  const tree = ts.createSourceFile('script.ts', source, ts.ScriptTarget.Latest, true);
  const aliases = new Map();
  const comparisons = [];
  function collect(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      aliases.set(node.name.text, node.initializer);
    }
    if (ts.isBinaryExpression(node) && [
      ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
    ].includes(node.operatorToken.kind)) comparisons.push(node);
    ts.forEachChild(node, collect);
  }
  collect(tree);
  function identities(node, seen = new Set()) {
    if (ts.isElementAccessExpression(node) && node.expression.getText(tree) === 'process.argv'
      && node.argumentExpression?.getText(tree) === '1') return 1;
    if (ts.isPropertyAccessExpression(node) && node.getText(tree) === 'import.meta.url') return 2;
    if (ts.isIdentifier(node) && aliases.has(node.text) && !seen.has(node.text)) {
      return identities(aliases.get(node.text), new Set([...seen, node.text]));
    }
    let result = 0;
    ts.forEachChild(node, child => { result |= identities(child, seen); });
    return result;
  }
  return comparisons.some(node => identities(node) === 3);
}

it('detects direct, reversed, URL, and aliased legacy guards', () => {
  const argv = 'process.' + 'argv[1]';
  const meta = 'import.' + 'meta.url';
  for (const source of [
    `if (${argv} && resolve(${argv}) === fileURLToPath(${meta})) main();`,
    `if (fileURLToPath(${meta}) === ${argv}) main();`,
    `if (${meta} === pathToFileURL(${argv} ?? '').href) main();`,
    `const invoked = ${argv};\nconst self = fileURLToPath(${meta});\nif (invoked === self) main();`,
  ]) expect(hasLocalIdentityCheck(source)).toBe(true);
  expect(hasLocalIdentityCheck('if (isMain(import.meta.url)) main();')).toBe(false);
});

it('keeps tracked scripts free of local argv/module identity checks', () => {
  const files = execFileSync('git', ['ls-files', '-z', '--', '*.mjs', '*.js', '*.ts', '*.cjs'], {
    cwd: repo, encoding: 'utf8',
  }).split('\0').filter(Boolean);
  const violations = files.filter(file => file !== 'scripts/is-main.mjs'
    && hasLocalIdentityCheck(readFileSync(join(repo, file), 'utf8')));
  expect(violations).toEqual([]);
});
