import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const source = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');

// These are source-ownership rules, not changed runtime behavior (audit 2026-10-11).
describe('audit source ownership', () => {
  it.each([
    ['S5-2', 'services/thrustcurve.ts', 'delayTag'],
    ['S7b-3', 'services/mountDelayEdits.ts', 'labelWithDelay'],
    ['S7a-5', 'services/batchSweep.ts', 'batchProbeCutoff'],
  ])('%s: removes the unused competing rule %s', (_id, path, name) => {
    expect(source(path)).not.toMatch(new RegExp(`export function ${name}\\b`));
  });

  it('S3c-6: dialogs have one modal stack and no abandoned nonmodal option', () => {
    const text = source('components/useDialog.ts');
    expect(text).not.toMatch(/modal\??:|modals\s*=|modals\./);
    expect(text).toMatch(/return stack.length/);
  });

  it('S5-3: base-drag advisory uses the shared numeric reader', () => {
    const text = source('services/baseDragImportNotes.ts');
    expect(text).toMatch(/import \{ numOpt \} from '..\/tree\/nodeNum.js'/);
    expect(text).not.toMatch(/const finite\s*=/);
  });

  it('S5-1: the 3D view derives its type and the real-control test declares its dependency', () => {
    expect(source('components/Rocket3D.tsx')).not.toMatch(/['"]three-stdlib['"]/);
    const app = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const lock = JSON.parse(readFileSync(new URL('../../../package-lock.json', import.meta.url), 'utf8'));
    expect(app.devDependencies['three-stdlib']).toBeDefined();
    expect(lock.packages['packages/app'].devDependencies['three-stdlib']).toBe(app.devDependencies['three-stdlib']);
  });

  it('S2-9: App computes the pristine-tree predicate only inside a memo', () => {
    const file = ts.createSourceFile('App.tsx', source('App.tsx'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const calls = [];
    const visit = (n) => {
      if (ts.isCallExpression(n) && n.expression.getText(file) === 'isPristineDefault') calls.push(n);
      ts.forEachChild(n, visit);
    };
    visit(file);
    expect(calls).toHaveLength(1);
    expect(calls[0].parent.parent.expression.getText(file)).toBe('useMemo');
  });
});
