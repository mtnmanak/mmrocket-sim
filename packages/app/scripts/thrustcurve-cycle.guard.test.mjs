import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import ts from 'typescript';

// A static edge would undo the cycle break (audit 2026-10-11, S5-7).
it('keeps thrustcurve imports of exMotors dynamic', () => {
  const source = ts.createSourceFile('thrustcurve.ts',
    readFileSync(new URL('../src/services/thrustcurve.ts', import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const imports = source.statements.filter(ts.isImportDeclaration)
    .filter((statement) => ts.isStringLiteral(statement.moduleSpecifier)
      && /(?:^|\/)exMotors(?:\.[cm]?[jt]s)?$/.test(statement.moduleSpecifier.text));
  expect(imports.map((statement) => statement.getText(source))).toEqual([]);
});
